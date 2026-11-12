/**
 * 「指挥者模式」的 preset 声明行（`dsh-commander-mode/preset-commander`）。
 *
 * 语义等价于随附的 `@deepseek-ai/dsh-agent-preset`：把 preset 定义交给
 * `ctx.agentPresets.register()` 并在卸载时释放。**自带一份的理由与实现细节见
 * `lib/preset-declaration.js`**：插件页组件行的标题按「模块名」解析 locale，
 * 用随附声明器时标题会显示成通用的「Agent 预设定义」，看不出是哪个模式。
 *
 * ## 3.7.0：plugins 在 JS 里拼装
 *
 * 本行的 `config.plugins` 不再来自 `cordis.patch.yml`（那里曾有两份 ~84 行的能力行块），
 * 而是由 `lib/preset-plugins.js` 从 `lib/capabilities.js` 单一来源拼装后注入。
 * `cordis.patch.yml` 只保留 `id / name / description / order` 这些声明元数据。
 *
 * ## 5.0.0：一个模式
 *
 * 「项目经理模式」已并入本模式，所以只剩这一行声明。组合 = 能力行 + 指挥者模式行
 * （协议 / 门禁 / 专家安装）+ 可选工作流组件（`project-dev-workflow`，只注册 skill）。
 * 本包 `skills/` 目录由本行注入（工作流手册引用的 20 个方法 skill 在这里）。
 *
 * @module dsh-commander-mode/preset-commander
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PresetDeclarationConfig, declarePreset } from './lib/preset-declaration.js';
import { commanderPresetPlugins } from './lib/preset-plugins.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'preset-commander-declaration';

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
 * 注册指挥者模式的 preset 定义。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 本行 config（只含声明元数据）。
 * @returns {Promise<void>} 注册结果。
 */
export function apply(ctx, config) {
  const dir = packageSkillsDir();
  const plugins = commanderPresetPlugins({ skillDirs: dir === undefined ? [] : [dir] });
  return declarePreset(ctx, { ...(config ?? {}), plugins }, 'preset-commander');
}
