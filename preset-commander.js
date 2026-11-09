/**
 * 「指挥者模式」的 preset 声明行（`dsh-commander-mode/preset-commander`）。
 *
 * 语义等价于随附的 `@deepseek-ai/dsh-agent-preset`：把本行 config 交给
 * `ctx.agentPresets.register()` 并在卸载时释放。**自带一份的理由与实现细节见
 * `lib/preset-declaration.js`**：插件页组件行的标题按「模块名」解析 locale，
 * 两个模式共用随附声明器时标题会完全一样（都叫「Agent 预设定义」），分不清谁是谁。
 *
 * 这一行的配置写在 `cordis.patch.yml` 的 `preset-commander` 里（能力行 + 指挥者协议行）。
 *
 * @module dsh-commander-mode/preset-commander
 */

import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-commander-declaration';

/** 缺了 `agentPresets` 就没有声明这回事。 */
export const inject = ['agentPresets'];

/** 行配置形状（与随附声明器一致）。 */
export const Config = PresetDeclarationConfig;

/**
 * 注册指挥者模式的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  return declarePreset(ctx, config, 'preset-commander');
}
