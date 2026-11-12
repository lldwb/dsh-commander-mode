/**
 * 两个模式的**完整 preset 组合**（`plugins` 列表）—— 单一来源。
 *
 * ## 为什么在 JS 里拼装，而不是写在 `cordis.patch.yml`
 *
 * preset 是**完整组合**（不是叠加层），所以每个 preset 都必须重述自己需要的每一行。
 * 3.6.0 及以前这件事由 `cordis.patch.yml` 里两份逐字复制的能力行块完成（每份 ~84 行，
 * 合计 168 行），靠 `test/capabilities.test.mjs` 逐行比对防漂移——**同一份清单存在三处**
 * （`lib/capabilities.js` + 两份 YAML）。
 *
 * 3.7.0 起改成：能力行只有 `lib/capabilities.js` 一份，两个 preset 的 `plugins` 由本模块
 * 拼装，声明器（`preset-commander.js` / `preset-project-manager.js`）在 `apply()` 里注入。
 * `cordis.patch.yml` 只保留 `id / name / description / order` 这些**声明元数据**。
 *
 * 这么做的前提是：preset 子行是运行时挂载的 fiber，`plugins` 本来就不进 Loader 的 entry
 * 树（settings 页读的是那棵树，所以配置行才必须留在顶层）。也就是说 YAML 里的 `plugins`
 * 只是"交给 apply 的数据"，把它换成本模块的返回值不影响加载语义。
 *
 * ## 两个模式之间允许的唯一差异
 *
 * 能力行**逐字一致**，唯一例外是 `skill-filesystem` 的 `customSkillDirs`：项目经理模式
 * 加载本包 `skills/` 目录，指挥者模式不加载（保持 1.x 能力与文本不变）。除此之外谁多一行、
 * 少一行、改一个 config，都会让两个模式静默漂移成"一个能用 shell、另一个没有文件系统"。
 *
 * @module dsh-commander-mode/lib/preset-plugins
 */

import { capabilityEntries } from './capabilities.js';

/** 指挥者模式的协议 + 门禁 + specialist 安装行（`dsh-commander-mode/agent`）。 */
export const COMMANDER_MODE_ROWS = Object.freeze([
  Object.freeze({ id: 'commander-mode-agent', name: 'dsh-commander-mode/agent' }),
]);

/** 项目经理模式的两行：协议行 + 可选工作流手册（只注册 skill）。 */
export const PROJECT_MANAGER_MODE_ROWS = Object.freeze([
  Object.freeze({ id: 'project-manager-agent', name: 'dsh-commander-mode/project-manager' }),
  Object.freeze({ id: 'project-dev-workflow', name: 'dsh-commander-mode/workflow' }),
]);

/**
 * 指挥者模式的完整 plugins 清单。
 *
 * @returns {object[]} entry list（能力行 + 模式行）。
 */
export function commanderPresetPlugins() {
  return [...capabilityEntries(), ...COMMANDER_MODE_ROWS.map((row) => ({ ...row }))];
}

/**
 * 项目经理模式的完整 plugins 清单。
 *
 * @param {object} [options] - 组装参数。
 * @param {string[]} [options.skillDirs] - 本包 `skills/` 目录（绝对路径）；不传则不加载。
 * @returns {object[]} entry list（能力行 + 模式行 + 工作流行）。
 */
export function projectManagerPresetPlugins({ skillDirs } = {}) {
  return [...capabilityEntries({ skillDirs }), ...PROJECT_MANAGER_MODE_ROWS.map((row) => ({ ...row }))];
}

/**
 * 某个 preset 的**能力行部分**（去掉模式行）—— 用于断言两个模式共享同一份能力。
 *
 * @param {object[]} plugins - 一个 preset 的完整 plugins 列表。
 * @param {readonly object[]} modeRows - 该模式自己的模式行。
 * @returns {object[]} 能力行 entry list。
 */
export function capabilityPartOf(plugins, modeRows) {
  const modeIds = new Set(modeRows.map((row) => row.id));
  return plugins.filter((entry) => !modeIds.has(entry.id));
}
