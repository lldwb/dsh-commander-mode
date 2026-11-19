/**
 * 「同伴包预设组件」的发现与校验 —— 指挥者模式拿到 devkit 的那条软依赖链路。
 *
 * ## 为什么需要这一层
 *
 * 2026-11-19 用户要求：让指挥者模式像创造模式一样能编辑插件、能用 `dsh-plugin-devkit`。
 * 但 DSH 的 preset 是**完整组合**（不是全局工具集的叠加层）：一个 preset 能拿到什么，只取决于
 * 它自己的 `config.plugins`。devkit 的 bundle patch 只能按 id 覆盖 `preset-cordis`（创造模式），
 * 既无法把行插进别人的 preset（`insert` 只对 `group: true` 的行有效），也不该为了指挥者模式把
 * `devkit_*` 挂成全局行——那会让 standard / minimal 等所有模式都泄漏沙箱工具。
 *
 * 所以路径反过来：**由消费方（本包）在声明 preset 时发现同伴包声明的组件，并拼进自己的组合**。
 * 组件的描述写在提供方自己的 `package.json` 里：
 *
 * ```json
 * "dsh": {
 *   "presetComponent": {
 *     "id": "devkit",
 *     "module": "dsh-plugin-devkit/preset-component",
 *     "skillDirs": ["skills"]
 *   }
 * }
 * ```
 *
 * 三个字段各有明确职责：`id` 是 preset 里的行 id（冲突就跳过），`module` 是交给 Loader 的
 * **bare specifier**（必须是提供方自己的子路径），`skillDirs` 是要追加到宿主 preset
 * `skill-filesystem.customSkillDirs` 的包内相对目录（devkit 的三个开发 skill 就在这里）。
 *
 * ## 三条硬约束
 *
 * 1. **fail-closed**：任何一个字段不合法、模块解析不到、目录越界或不存在 → **跳过该组件**
 *    并记一条 warning，绝不把一个注定挂不上的行塞进 preset（preset 的实例审计会把整行判坏，
 *    用户会失去整个指挥者模式）。
 * 2. **尊重启用状态**：`dsh.profile.bundles` 里没有这个包时直接不发现（用户禁用 devkit =
 *    指挥者模式也不该有它）；profile 清单读不到时才退化成"只按能否解析判断"。
 * 3. **解析起点与 Loader 一致**：从 `ctx.baseUrl`（app-boot 设的 profile 目录 file URL）解析，
 *    优先走 `./node_modules/<name>/package.json` 的相对路径——它不经过 app-boot 的
 *    启动快照解析表，运行中新装的插件也能被看到（这是 devkit 生成器实测过的坑，见其
 *    `scripts/gen-preset-patch.mjs` 增量 (a) 的注释）。
 *
 * ## 边界
 *
 * 本模块只**读**别人的清单与文件系统，不注册任何东西、不缓存（每次声明 preset 时重算）。
 * 它是同步的：`apply()` 在 Loader 激活期调用，读两个小 JSON 不值得引入异步竞态。
 *
 * @module dsh-commander-mode/lib/preset-components
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 默认发现哪些同伴包。
 *
 * 只列**已知的**同伴包，不做全目录扫描：扫描会把任意一个装了 `dsh.presetComponent`
 * 的第三方包悄悄塞进指挥者模式，用户完全无法预期自己的模式里多了什么。
 *
 * @type {readonly string[]}
 */
export const DEFAULT_COMPONENT_PACKAGES = Object.freeze(['dsh-plugin-devkit']);

/** 行 id 的形状：与 Loader entry id / 能力行 id 同一套（小写 slug）。 */
const ROW_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * 解析 Loader 的解析起点。
 *
 * `ctx.baseUrl` 是 app-boot 设的 `file:///…/profiles/<name>/`（带尾部斜杠）；没有它时用
 * `profileDir` 现算一个。两者都没有（单元测试的裸 ctx）就返回 undefined —— 此时不做发现，
 * 行为与 7.19.0 完全一致（**不要让测试依赖机器上恰好装了什么**）。
 *
 * @param {unknown} baseUrl - `ctx.baseUrl`。
 * @param {unknown} profileDir - `profileContext.dir`。
 * @returns {string | undefined} createRequire 可用的起点。
 */
function resolveRootUrl(baseUrl, profileDir) {
  if (typeof baseUrl === 'string' && baseUrl !== '') return baseUrl;
  if (typeof profileDir === 'string' && profileDir !== '') return `${pathToFileURL(profileDir).href}/`;
  return undefined;
}

/**
 * 读 profile 的 `dsh.profile.bundles`（当前启用清单）。
 *
 * @param {unknown} profileDir - `profileContext.dir`。
 * @returns {Set<string> | undefined} 启用清单；读不到或形状不对时 undefined（= 未知，不据此过滤）。
 */
export function readEnabledBundles(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return undefined;
    return new Set(bundles.filter((name) => typeof name === 'string' && name !== ''));
  } catch {
    return undefined;
  }
}

/**
 * 从 Loader 起点解析一个 specifier（先相对 `./node_modules`，再按包名）。
 *
 * @param {string} specifier - 例如 `./node_modules/x/package.json` 或 `x/package.json`。
 * @param {string} rootUrl - `createRequire` 的起点。
 * @returns {string | undefined} 解析到的绝对路径（解析失败返回 undefined，不抛）。
 */
function tryResolve(specifier, rootUrl) {
  try {
    return createRequire(rootUrl).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * 定位同伴包的 `package.json`。
 *
 * @param {string} packageName - 包名。
 * @param {string} rootUrl - Loader 起点。
 * @returns {string | undefined} 清单路径。
 */
function resolveManifestPath(packageName, rootUrl) {
  // 相对路径优先：绕过 app-boot 的启动快照解析表（运行中新装的包也能被发现）。
  return tryResolve(`./node_modules/${packageName}/package.json`, rootUrl)
    ?? tryResolve(`${packageName}/package.json`, rootUrl);
}

/**
 * 校验并收集一个同伴包声明的预设组件。
 *
 * @param {string} packageName - 提供方包名。
 * @param {string} manifestPath - 提供方 `package.json` 的绝对路径。
 * @param {string} rootUrl - Loader 起点（用于校验 `module` 真能解析）。
 * @param {Set<string>} usedIds - 已被占用的行 id（能力行 / 模式行 / 之前的组件）。
 * @returns {{ component?: { row: { id: string, name: string }, skillDirs: string[] }, warnings: string[] }} 结果。
 */
function readComponent(packageName, manifestPath, rootUrl, usedIds) {
  const warnings = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { warnings: [`${packageName}: 读不出 package.json（${error.message}），预设组件不会挂载`] };
  }

  const descriptor = manifest?.dsh?.presetComponent;
  // 没声明组件的包是普通 bundle —— 不是错误，也不提示。
  if (descriptor === undefined) return { warnings };

  const rowId = typeof descriptor?.id === 'string' ? descriptor.id.trim() : '';
  if (!ROW_ID_PATTERN.test(rowId)) {
    warnings.push(`${packageName}: dsh.presetComponent.id 必须是可用作行 id 的小写 slug（实际：${JSON.stringify(descriptor?.id)}），已跳过`);
    return { warnings };
  }
  if (usedIds.has(rowId)) {
    warnings.push(`${packageName}: 预设组件行 id "${rowId}" 与已有行冲突，已跳过（组件行 id 必须在本 preset 内唯一）`);
    return { warnings };
  }

  const moduleSpecifier = typeof descriptor?.module === 'string' ? descriptor.module.trim() : '';
  if (!moduleSpecifier.startsWith(`${packageName}/`)) {
    warnings.push(`${packageName}: dsh.presetComponent.module 必须是本包自己的子路径（实际：${JSON.stringify(descriptor?.module)}），已跳过`);
    return { warnings };
  }
  if (tryResolve(moduleSpecifier, rootUrl) === undefined) {
    // 解析不到的行挂上去会让整个 preset 的实例审计报坏 —— 宁可少挂一个组件。
    warnings.push(`${packageName}: 预设组件入口 ${moduleSpecifier} 从 Loader 起点解析不到（package.json 的 exports 是否漏了它？），已跳过`);
    return { warnings };
  }

  const packageDir = path.dirname(manifestPath);
  const skillDirs = [];
  const declared = descriptor?.skillDirs;
  if (declared !== undefined && !Array.isArray(declared)) {
    warnings.push(`${packageName}: dsh.presetComponent.skillDirs 必须是字符串数组，已按空处理`);
  }
  for (const entry of Array.isArray(declared) ? declared : []) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      warnings.push(`${packageName}: dsh.presetComponent.skillDirs 里有非字符串/空项，已跳过该项`);
      continue;
    }
    const absolute = path.resolve(packageDir, entry);
    const relative = path.relative(packageDir, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      warnings.push(`${packageName}: skillDirs 不能指向包外（${entry}），已跳过该项`);
      continue;
    }
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      warnings.push(`${packageName}: skillDirs 目录不存在（${entry}），已跳过该项`);
      continue;
    }
    if (!skillDirs.includes(absolute)) skillDirs.push(absolute);
  }

  return { component: { row: { id: rowId, name: moduleSpecifier }, skillDirs }, warnings };
}

/**
 * 发现并校验所有同伴包声明的预设组件。
 *
 * @param {object} [options] - 发现参数。
 * @param {readonly string[]} [options.packages] - 候选包名（默认 `DEFAULT_COMPONENT_PACKAGES`）。
 * @param {unknown} [options.baseUrl] - `ctx.baseUrl`（Loader 解析起点）。
 * @param {unknown} [options.profileDir] - `profileContext.dir`（用于判断启用状态 / 备用起点）。
 * @param {string[]} [options.reservedIds] - 本 preset 已占用的行 id（能力行 + 模式行）。
 * @returns {{ components: { row: { id: string, name: string }, skillDirs: string[] }[], warnings: string[] }} 组件与告警。
 */
export function resolvePresetComponents({ packages = DEFAULT_COMPONENT_PACKAGES, baseUrl, profileDir, reservedIds = [] } = {}) {
  const components = [];
  const warnings = [];
  const rootUrl = resolveRootUrl(baseUrl, profileDir);
  if (rootUrl === undefined) return { components, warnings };

  const enabled = readEnabledBundles(profileDir);
  const usedIds = new Set((Array.isArray(reservedIds) ? reservedIds : []).filter((id) => typeof id === 'string' && id !== ''));

  for (const packageName of Array.isArray(packages) ? packages : []) {
    if (typeof packageName !== 'string' || packageName.trim() === '') continue;
    // 用户明确禁用这个 bundle 时不发现它 —— "禁用"应该意味着"这个模式里也没有它"。
    if (enabled !== undefined && !enabled.has(packageName)) continue;

    const manifestPath = resolveManifestPath(packageName, rootUrl);
    if (manifestPath === undefined) {
      // 启用清单里有、却解析不到：这是真实的不一致（装坏了），要说出来。
      if (enabled !== undefined) warnings.push(`${packageName}: 已在 profile.bundles 中启用，但从 Loader 起点解析不到 package.json，预设组件不会挂载`);
      continue;
    }

    const { component, warnings: rowWarnings } = readComponent(packageName, manifestPath, rootUrl, usedIds);
    warnings.push(...rowWarnings);
    if (component === undefined) continue;

    usedIds.add(component.row.id);
    components.push(component);
  }

  return { components, warnings };
}
