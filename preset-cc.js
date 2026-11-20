/**
 * 「指挥者 · CC 模式」的 preset 声明行（`dsh-commander-mode/preset-cc`）。
 *
 * ## 与「指挥者模式」的差异只有一处
 *
 * 组合**完全相同**（`lib/preset-plugins.js` 的同一份能力行 + 模式行 + 可选工作流），
 * 区别在 **preset id**：`commander-cc`。模式行（`dsh-commander-mode/agent`）按会话头里的
 * `agentPreset` 判断变体（见 `lib/mode-variant.js`），于是：
 *
 * - 指挥官（L0）照旧用 `subagent` 建小组长；
 * - 小组长（L1）这一层的 DSH 委派工具被 `tools/pre-execute` 拒绝，只能用
 *   `subagent_claude_code` 派 Claude Code 会话。
 *
 * 为什么不复制一份能力行：preset 是完整组合，但"下级是谁"是**协议 + 门禁**的差异，
 * 不是工具集的差异 —— 删掉 `tool-subagent` 会让指挥官自己也建不了小组长，
 * 整条链塌成一层（详见 `lib/guard.js` 的 `evaluateCcDelegation` 注释）。
 *
 * @module dsh-commander-mode/preset-cc
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { allCapabilityRowIds } from './lib/capabilities.js';
import { resolvePresetComponents } from './lib/preset-components.js';
import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';
import { MODE_ROWS, commanderPresetPlugins } from './lib/preset-plugins.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-commander-cc-declaration';

/** 缺了 `agentPresets` 就没有声明这回事。 */
export const inject = ['agentPresets'];

/** 行配置形状（`plugins` 由本模块注入，YAML 不必再写）。 */
export const Config = PresetDeclarationConfig;

/**
 * 本包 `skills/` 目录的绝对路径（与原生模式共用同一份工作流方法 skill）。
 *
 * @returns {string | undefined} 目录绝对路径。
 */
export function packageSkillsDir() {
  try {
    const dir = fileURLToPath(new URL('./skills/', import.meta.url));
    return fs.existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读当前 profile 目录（用于判断同伴 bundle 是否启用）。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {string | undefined} profile 目录。
 */
export function profileDirOf(ctx) {
  try {
    const context = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
    return typeof context?.dir === 'string' && context.dir !== '' ? context.dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发现同伴包声明的预设组件（与原生模式同一套：devkit 等）。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {{ components: { row: { id: string, name: string }, skillDirs: string[] }[], warnings: string[] }} 组件与告警。
 */
export function discoverPresetComponents(ctx) {
  const profileDir = profileDirOf(ctx);
  const baseUrl = typeof ctx?.baseUrl === 'string' && ctx.baseUrl !== '' ? ctx.baseUrl : undefined;
  return resolvePresetComponents({
    baseUrl,
    profileDir,
    reservedIds: [...allCapabilityRowIds(), ...MODE_ROWS.map((row) => row.id)],
  });
}

/**
 * 注册「指挥者 · CC 模式」的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config（只含声明元数据）。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  const dir = packageSkillsDir();
  const { components, warnings } = discoverPresetComponents(ctx);
  for (const warning of warnings) ctx.logger?.warn?.(`preset-cc: ${warning}`);
  const plugins = commanderPresetPlugins({ skillDirs: dir === undefined ? [] : [dir], components });
  return declarePreset(ctx, { ...(config ?? {}), plugins }, 'preset-cc');
}
