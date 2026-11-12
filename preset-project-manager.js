/**
 * 「项目经理模式」的 preset 声明行（`dsh-commander-mode/preset-project-manager`）。
 *
 * 与 `preset-commander.js` 同构：语义等价于随附的 `@deepseek-ai/dsh-agent-preset`，
 * 自带一份只为了让插件页组件行的标题能显示「项目经理模式」（组件行标题按模块名解析
 * locale，共用随附声明器时两行标题会一样）。实现细节见 `lib/preset-declaration.js`。
 *
 * ## 3.7.0：plugins 在 JS 里拼装
 *
 * `config.plugins` 由 `lib/preset-plugins.js` 从 `lib/capabilities.js` 单一来源拼装后注入：
 * 能力行 + 项目经理协议行 + 可选工作流行。与指挥者模式唯一的能力行差异是
 * `skill-filesystem.config.customSkillDirs`（加载本包 `skills/` 目录）。
 * `cordis.patch.yml` 只保留 `id / name / description / order`。
 *
 * @module dsh-commander-mode/preset-project-manager
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';
import { projectManagerPresetPlugins } from './lib/preset-plugins.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-project-manager-declaration';

/** 缺了 `agentPresets` 就没有声明这回事。 */
export const inject = ['agentPresets'];

/** 行配置形状（`plugins` 由本模块注入，YAML 不必再写）。 */
export const Config = PresetDeclarationConfig;

/**
 * 本包 `skills/` 目录的绝对路径（按本模块位置解析，不写死任何绝对路径）。
 *
 * 目录不存在时返回 `undefined`：宁可不加载，也不要给 skill-filesystem 一个坏路径
 * （它会在每轮加载时告警）。`files` 里包含 `skills/**`，正常安装时一定存在。
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
 * 注册项目经理模式的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config（只含声明元数据）。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  const dir = packageSkillsDir();
  const plugins = projectManagerPresetPlugins({ skillDirs: dir === undefined ? [] : [dir] });
  return declarePreset(ctx, { ...(config ?? {}), plugins }, 'preset-project-manager');
}
