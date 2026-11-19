/**
 * 指挥者模式的**完整 preset 组合**（`plugins` 列表）—— 单一来源。
 *
 * ## 为什么在 JS 里拼装，而不是写在 `cordis.patch.yml`
 *
 * preset 是**完整组合**（不是叠加层），所以每个 preset 都必须重述自己需要的每一行。
 * 3.6.0 及以前这件事由 `cordis.patch.yml` 里两份逐字复制的能力行块完成（每份 ~84 行，
 * 合计 168 行），靠 `test/capabilities.test.mjs` 逐行比对防漂移——**同一份清单存在三处**
 * （`lib/capabilities.js` + 两份 YAML）。
 *
 * 3.7.0 起改成：能力行只有 `lib/capabilities.js` 一份，preset 的 `plugins` 由本模块拼装，
 * 声明器（`preset-commander.js`）在 `apply()` 里注入。`cordis.patch.yml` 只保留
 * `id / name / description / order` 这些**声明元数据**。
 *
 * ## 5.0.0：一个模式
 *
 * 「项目经理模式」已并入指挥者模式（专家团与六段工作流都是按需的，不需要第二个模式）。
 * 所以这里只有一个组合：能力行 + 指挥者模式行（协议 / 门禁 / 专家安装）+ 可选工作流组件
 * （`project-dev-workflow`，只注册 skill、按需加载）。
 *
 * ## 7.20.0：同伴包的预设组件
 *
 * 接线顺序是 **能力行 → 模式行 → 组件行**：组件行（今天只有 `devkit`）排最后，
 * 与创造模式里 devkit 子行排最后的位置感一致；它的 `skillDirs` 追加进
 * `skill-filesystem.customSkillDirs`，所以组件自带的 skill 与指挥者自己的 20 个 skill
 * 在同一个 `skill` 工具里可见。发现逻辑（谁算组件、怎么校验）在
 * `lib/preset-components.js`，本模块只负责拼装。
 *
 * 这么做的前提是：preset 子行是运行时挂载的 fiber，`plugins` 本来就不进 Loader 的 entry
 * 树（settings 页读的是那棵树，所以配置行才必须留在顶层）。也就是说 YAML 里的 `plugins`
 * 只是"交给 apply 的数据"，把它换成本模块的返回值不影响加载语义。
 *
 * @module dsh-commander-mode/lib/preset-plugins
 */

import { capabilityEntries } from './capabilities.js';

/** 模式行：协议 + 门禁 + 专家安装（`dsh-commander-mode/agent`）。 */
export const MODE_ROWS = Object.freeze([
  Object.freeze({ id: 'commander-mode-agent', name: 'dsh-commander-mode/agent' }),
  // 可选工作流手册：只注册 skill（`project-dev-workflow`），不注入常驻 prompt。
  Object.freeze({ id: 'project-dev-workflow', name: 'dsh-commander-mode/workflow' }),
]);

/**
 * 指挥者模式的完整 plugins 清单。
 *
 * @param {object} [options] - 组装参数。
 * @param {string[]} [options.skillDirs] - 本包 `skills/` 目录（绝对路径）；不传则不加载。
 * @param {{ row: { id: string, name: string }, skillDirs?: string[] }[]} [options.components] -
 *   同伴包声明的预设组件（见 `lib/preset-components.js`）：行追加到最后，`skillDirs` 并进
 *   `skill-filesystem` 的 `customSkillDirs`。
 * @returns {object[]} entry list（能力行 + 模式行 + 组件行）。
 */
export function commanderPresetPlugins({ skillDirs, components = [] } = {}) {
  const ownSkillDirs = Array.isArray(skillDirs) ? skillDirs : [];
  const extras = Array.isArray(components) ? components : [];

  // 目录去重（同一条目允许多个来源声明；重复的 customSkillDirs 会让 skill 目录被扫两遍）。
  const mergedSkillDirs = [];
  for (const dir of [...ownSkillDirs, ...extras.flatMap((component) => (Array.isArray(component?.skillDirs) ? component.skillDirs : []))]) {
    if (typeof dir !== 'string' || dir === '') continue;
    if (!mergedSkillDirs.includes(dir)) mergedSkillDirs.push(dir);
  }

  const componentRows = extras
    .filter((component) => component !== null && typeof component === 'object' && component.row !== null && typeof component.row === 'object')
    .map((component) => ({ ...component.row }));

  return [
    ...capabilityEntries({ skillDirs: mergedSkillDirs }),
    ...MODE_ROWS.map((row) => ({ ...row })),
    ...componentRows,
  ];
}

/**
 * 某个 preset 的**能力行部分**（去掉模式行）—— 用于断言能力行来自单一来源。
 *
 * @param {object[]} plugins - 完整 plugins 列表。
 * @param {readonly object[]} [modeRows] - 该模式的模式行（默认 `MODE_ROWS`）。
 * @returns {object[]} 能力行 entry list。
 */
export function capabilityPartOf(plugins, modeRows = MODE_ROWS) {
  const modeIds = new Set(modeRows.map((row) => row.id));
  return plugins.filter((entry) => !modeIds.has(entry.id));
}
