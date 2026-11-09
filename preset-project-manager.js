/**
 * 「项目经理模式」的 preset 声明行（`dsh-commander-mode/preset-project-manager`）。
 *
 * 与 `preset-commander.js` 同构：语义等价于随附的 `@deepseek-ai/dsh-agent-preset`，
 * 自带一份只为了让插件页组件行的标题能显示「项目经理模式」（组件行标题按模块名解析
 * locale，共用随附声明器时两行标题会一样）。实现细节见 `lib/preset-declaration.js`。
 *
 * 这一行的配置写在 `cordis.patch.yml` 的 `preset-project-manager` 里
 * （能力行 + 项目经理协议行 + 项目开发工作流行）。
 *
 * @module dsh-commander-mode/preset-project-manager
 */

import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-project-manager-declaration';

/** 缺了 `agentPresets` 就没有声明这回事。 */
export const inject = ['agentPresets'];

/** 行配置形状（与随附声明器一致）。 */
export const Config = PresetDeclarationConfig;

/**
 * 注册项目经理模式的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  return declarePreset(ctx, config, 'preset-project-manager');
}
