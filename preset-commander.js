/**
 * 「指挥者模式」的 preset 声明行（`dsh-commander-mode/preset-commander`）。
 *
 * 语义等价于随附的 `@deepseek-ai/dsh-agent-preset`：把 preset 定义交给
 * `ctx.agentPresets.register()` 并在卸载时释放。**自带一份的理由与实现细节见
 * `lib/preset-declaration.js`**：插件页组件行的标题按「模块名」解析 locale，
 * 两个模式共用随附声明器时标题会完全一样（都叫「Agent 预设定义」），分不清谁是谁。
 *
 * ## 3.7.0：plugins 在 JS 里拼装
 *
 * 本行的 `config.plugins` 不再来自 `cordis.patch.yml`（那里曾有两份 ~84 行的能力行块），
 * 而是由 `lib/preset-plugins.js` 从 `lib/capabilities.js` 单一来源拼装后注入。
 * `cordis.patch.yml` 只保留 `id / name / description / order` 这些声明元数据。
 * 好处：能力行只有一份，两个模式不可能因为"改了一边没改另一边"而静默漂移。
 *
 * @module dsh-commander-mode/preset-commander
 */

import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';
import { commanderPresetPlugins } from './lib/preset-plugins.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-commander-declaration';

/** 缺了 `agentPresets` 就没有声明这回事。 */
export const inject = ['agentPresets'];

/** 行配置形状（`plugins` 由本模块注入，YAML 不必再写）。 */
export const Config = PresetDeclarationConfig;

/**
 * 注册指挥者模式的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config（只含声明元数据）。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  return declarePreset(ctx, { ...(config ?? {}), plugins: commanderPresetPlugins() }, 'preset-commander');
}
