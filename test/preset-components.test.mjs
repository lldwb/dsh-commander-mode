/**
 * 同伴包预设组件的发现与拼装（7.20.0）。
 *
 * ## 需求原话（2026-11-19）
 *
 * 「给 dsh-plugin-devkit 插件添加一个组件，让 dsh-commander-mode 插件也可以像创造模式一样
 * 编辑插件和使用 dsh-plugin-devkit 插件」。
 *
 * ## 为什么要这么多"坏输入"用例
 *
 * devkit 不是本包的依赖，而是**软依赖**：装没装、哪个版本、清单写没写对，全都不由本包决定。
 * 而 preset 的实例审计是"一行挂不上 ⇒ 整个 preset 判坏 ⇒ 用户失去整个指挥者模式"。所以
 * 发现逻辑必须**fail-closed**：任何一处不合法就跳过该组件，指挥者模式照旧声明。
 *
 * 这一组测试锁四类行为：
 *
 * 1. **何时发现**：profile 启用了这个 bundle 且包能解析 → 发现；没装 / 被禁用 → 不发现且不告警；
 * 2. **发现什么**：行 id / 入口 specifier / skill 目录（绝对路径）都来自提供方清单；
 * 3. **什么时候拒绝**：入口越权（指向别的包）、入口解析不到、行 id 冲突、skill 目录越界或不存在
 *    → 该组件（或该目录）被跳过，并给出**点名原因**的 warning，绝不静默；
 * 4. **拼进 preset 的形状**：组件行排最后、`skill-filesystem.customSkillDirs` 合并本包与组件
 *    的目录且去重，声明仍然只发生一次。
 *
 * 夹具是临时目录里"像安装过一样"的 profile（`node_modules/<pkg>` + 包内文件），
 * 解析起点与 Loader 一致（`pathToFileURL(profileDir) + '/'`）。
 *
 * Run: node --test test/preset-components.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { CAPABILITY_ROWS, allCapabilityRowIds } from '../lib/capabilities.js';
import {
  DEFAULT_COMPONENT_PACKAGES,
  readEnabledBundles,
  resolvePresetComponents,
} from '../lib/preset-components.js';
import {
  MODE_ROWS,
  commanderPresetPlugins,
} from '../lib/preset-plugins.js';
import { apply as applyCommander, packageSkillsDir } from '../preset-commander.js';

const DEVKIT = 'dsh-plugin-devkit';

/**
 * 造一个"装过插件"的 profile。
 *
 * @param {object} [options] - 夹具选项。
 * @param {string[]} [options.bundles] - `dsh.profile.bundles`（默认包含 devkit）。
 * @param {'valid'|'foreign-module'|'missing-entry'|'bad-descriptor'|'escape-skills'|'no-descriptor'} [options.shape] - 提供方清单的形状。
 * @param {boolean} [options.install] - 是否真的在 node_modules 里放这个包。
 * @param {string} [options.packageName] - 包名（默认 devkit）。
 * @returns {{ root: string, profileDir: string, packageDir: string }} 路径。
 */
function makeProfile({ bundles = [DEVKIT], shape = 'valid', install = true, packageName = DEVKIT } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'commander-components-'));
  const profileDir = path.join(root, 'profile');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-fixture', dsh: { profile: { bundles } } }, null, 2)}\n`,
    'utf8',
  );

  const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
  if (!install) return { root, profileDir, packageDir };

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'preset-component.js'), 'export const name = "fixture-component"\nexport function apply() {}\n', 'utf8');
  mkdirSync(path.join(packageDir, 'skills', 'fixture-skill'), { recursive: true });
  writeFileSync(path.join(packageDir, 'skills', 'fixture-skill', 'SKILL.md'), '# fixture\n', 'utf8');

  const descriptors = {
    valid: { id: 'devkit', module: `${packageName}/preset-component`, skillDirs: ['skills'] },
    'foreign-module': { id: 'devkit', module: 'someone-else/preset-component', skillDirs: ['skills'] },
    'missing-entry': { id: 'devkit', module: `${packageName}/not-exported`, skillDirs: ['skills'] },
    'bad-descriptor': { id: 'Not A Slug', module: `${packageName}/preset-component`, skillDirs: 'skills' },
    'escape-skills': { id: 'devkit', module: `${packageName}/preset-component`, skillDirs: ['../outside'] },
    'no-descriptor': undefined,
  };
  const presetComponent = descriptors[shape];
  const manifest = {
    name: packageName,
    version: '0.0.0',
    type: 'module',
    ...(presetComponent === undefined ? {} : { dsh: { presetComponent } }),
  };
  writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, profileDir, packageDir };
}

/** 夹具回收（只删自己在 os.tmpdir() 下造的那一份）。 */
const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) continue;
    rmSync(resolved, { recursive: true, force: true });
  }
});

/** 解析起点与 app-boot 一致：profile 目录的 file URL + 尾部斜杠。 */
function rootUrlOf(profileDir) {
  return `${pathToFileURL(profileDir).href}/`;
}

// --------------------------------------------------------- 1) 何时发现 ---

test('默认候选只有 devkit（不做全目录扫描，模式里多出什么必须可预期）', () => {
  assert.deepEqual([...DEFAULT_COMPONENT_PACKAGES], [DEVKIT]);
});

test('启用且可解析 → 发现组件：行 id / 入口 specifier / skill 目录都来自提供方清单', () => {
  const fixture = makeProfile();
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(warnings, [], '合法夹具不该有告警');
  assert.equal(components.length, 1);
  assert.deepEqual(components[0].row, { id: 'devkit', name: `${DEVKIT}/preset-component` });
  assert.deepEqual(components[0].skillDirs, [path.join(fixture.packageDir, 'skills')]);
});

test('没安装（且不在启用清单里）→ 不发现、也不告警（软依赖缺席是正常状态）', () => {
  const fixture = makeProfile({ install: false, bundles: [] });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.deepEqual(warnings, [], '没装 devkit 不该在每次启动时刷告警');
});

test('被禁用（不在 profile.bundles 里）→ 不发现、也不告警', () => {
  const fixture = makeProfile({ bundles: ['@deepseek-ai/dsh-base'] });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.deepEqual(warnings, []);
});

test('启用清单里有、却解析不到 → 不发现，但要点名这个不一致', () => {
  const fixture = makeProfile({ install: false });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /启用/u);
  assert.match(warnings[0], /package\.json/u);
});

test('没有 profile 清单时不做启用过滤（读不到 ≠ 未启用），只按能否解析判断', () => {
  const fixture = makeProfile();
  cleanup.push(fixture.root);
  assert.equal(readEnabledBundles(undefined), undefined);
  const { components } = resolvePresetComponents({ baseUrl: rootUrlOf(fixture.profileDir) });
  assert.equal(components.length, 1);
});

test('没有解析起点（单测的裸 ctx）→ 完全不做发现，行为退回 7.19.0', () => {
  const { components, warnings } = resolvePresetComponents();
  assert.deepEqual(components, []);
  assert.deepEqual(warnings, []);
});

// ----------------------------------------------------- 2) 什么时候拒绝 ---

test('入口指向别的包 → 跳过并告警（组件不能挂任意模块）', () => {
  const fixture = makeProfile({ shape: 'foreign-module' });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /本包自己的子路径/u);
});

test('入口解析不到 → 跳过并告警（宁可少一个组件，也不让 preset 判坏）', () => {
  const fixture = makeProfile({ shape: 'missing-entry' });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /解析不到/u);
});

test('行 id 不是 slug → 跳过并告警', () => {
  const fixture = makeProfile({ shape: 'bad-descriptor' });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slug/u);
});

test('行 id 与本 preset 已有行冲突 → 跳过并告警（能力行 / 模式行占用的 id 也算）', () => {
  const fixture = makeProfile({ shape: 'valid' });
  cleanup.push(fixture.root);
  const reserved = [...allCapabilityRowIds(), ...MODE_ROWS.map((row) => row.id)];
  assert.ok(reserved.includes('tool-fs'), '夹具前提：能力行 id 里有 tool-fs');
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
    reservedIds: [...reserved, 'devkit'],
  });
  assert.deepEqual(components, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /冲突/u);
});

test('skillDirs 指向包外 → 该目录被跳过、行仍保留（行本身是合法的）', () => {
  const fixture = makeProfile({ shape: 'escape-skills' });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.equal(components.length, 1, '行合法就该保留');
  assert.deepEqual(components[0].skillDirs, [], '越界目录不能进 customSkillDirs');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /包外/u);
});

test('没声明 dsh.presetComponent 的包 → 视作普通 bundle，不发现也不告警', () => {
  const fixture = makeProfile({ shape: 'no-descriptor' });
  cleanup.push(fixture.root);
  const { components, warnings } = resolvePresetComponents({
    baseUrl: rootUrlOf(fixture.profileDir),
    profileDir: fixture.profileDir,
  });
  assert.deepEqual(components, []);
  assert.deepEqual(warnings, []);
});

// ------------------------------------------------- 3) 拼进 preset 的形状 ---

test('commanderPresetPlugins：组件行排最后，skill 目录与本包合并且去重', () => {
  const own = 'C:\\fake\\commander\\skills';
  const extra = 'C:\\fake\\devkit\\skills';
  const components = [
    { row: { id: 'devkit', name: `${DEVKIT}/preset-component` }, skillDirs: [extra, own] },
  ];
  const plugins = commanderPresetPlugins({ skillDirs: [own], components });

  assert.equal(plugins.length, CAPABILITY_ROWS.length + MODE_ROWS.length + 1, '行数 = 能力行 + 模式行 + 组件行');
  assert.deepEqual(plugins.at(-1), { id: 'devkit', name: `${DEVKIT}/preset-component` }, '组件行必须排最后');
  // 组件行之前的最后两行仍是模式行（组件不插在模式行中间）。
  assert.deepEqual(plugins.slice(-3, -1).map((entry) => entry.id), MODE_ROWS.map((row) => row.id));

  const skillFs = plugins.find((entry) => entry.id === 'skill-filesystem');
  assert.deepEqual(skillFs.config, { customSkillDirs: [own, extra] }, '目录要合并、去重、保序');
});

test('没有组件时不改变既有组合（7.19.0 的清单逐字不变）', () => {
  const plugins = commanderPresetPlugins({ skillDirs: ['C:\\fake\\skills'] });
  assert.equal(plugins.length, CAPABILITY_ROWS.length + MODE_ROWS.length);
  assert.deepEqual(plugins.at(-1).id, 'project-dev-workflow');
});

// ------------------------------------------------------- 4) apply 接线 ---

test('apply：启用 devkit 时，注册的 preset 末尾多出组件行、skill-filesystem 含两个目录', async () => {
  const fixture = makeProfile();
  cleanup.push(fixture.root);

  const registrations = [];
  const warnings = [];
  const ctx = {
    baseUrl: rootUrlOf(fixture.profileDir),
    get: (name) => (name === 'profileContext' ? { dir: fixture.profileDir } : undefined),
    agentPresets: {
      register: (definition) => {
        registrations.push(definition);
        return Promise.resolve(async () => {});
      },
    },
    effect: (callback) => {
      callback();
      return () => {};
    },
    logger: { warn: (...args) => warnings.push(args) },
  };

  await applyCommander(ctx, { id: 'commander', name: '指挥者模式', description: '测试', order: 7 });

  assert.equal(registrations.length, 1);
  const definition = registrations[0];
  assert.deepEqual(definition.plugins.at(-1), { id: 'devkit', name: `${DEVKIT}/preset-component` });
  const skillFs = definition.plugins.find((entry) => entry.id === 'skill-filesystem');
  const ownSkills = packageSkillsDir();
  assert.ok(typeof ownSkills === 'string', '本包 skills/ 目录必须存在（joins fixture 的断言依赖它）');
  assert.deepEqual(
    skillFs.config.customSkillDirs,
    [ownSkills, path.join(fixture.packageDir, 'skills')],
    '本包 skills/ 在前、组件 skills/ 在后（顺序即优先级）',
  );
  assert.deepEqual(warnings, [], '合法夹具不该有告警');
});

test('apply：禁用 devkit 时仍能声明 preset（指挥者模式不因软依赖缺席而坏掉）', async () => {
  const fixture = makeProfile({ bundles: [] });
  cleanup.push(fixture.root);

  const registrations = [];
  const ctx = {
    baseUrl: rootUrlOf(fixture.profileDir),
    get: () => ({ dir: fixture.profileDir }),
    agentPresets: { register: (definition) => { registrations.push(definition); return Promise.resolve(async () => {}); } },
    effect: (callback) => { callback(); return () => {}; },
    logger: { warn: () => {} },
  };

  await applyCommander(ctx, { id: 'commander', name: '指挥者模式', description: '测试', order: 7 });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].plugins.length, CAPABILITY_ROWS.length + MODE_ROWS.length);
});
