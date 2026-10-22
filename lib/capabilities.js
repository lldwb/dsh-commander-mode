/**
 * agent preset 的「能力行」清单 —— 单一来源的 JS 版本。
 *
 * ## 为什么这里要抄一份 `cordis.patch.yml` 里的行
 *
 * DSH 的 preset 是**完整组合**，不是全局工具集上的叠加层：`@deepseek-ai/dsh-web-app`
 * 把随附的每个能力行都设成 `disabled: true`，然后在每个 preset 内部重新声明它要的行。
 * 所以任何新 preset（包括本插件为每个 specialist 动态注册的那个）都必须自己重述
 * 能力行，否则那个 agent 会没有文件系统、没有 shell。
 *
 * `cordis.patch.yml` 是声明式的（Loader 读它），而 specialist preset 是**运行时**生成的
 * （名册可配置，条数不定），两者没法共享同一份 YAML。于是这里放 JS 常量，YAML 那边放
 * 等价的行，并用 `test/capabilities.test.mjs` 逐行比对，防止两边漂移。
 *
 * ## 谁用这份清单
 *
 * - `commander` preset：`cordis.patch.yml` 里的 `CAPABILITIES` 块（应与此处一致）；
 * - 每个 specialist preset：`lib/specialists.js` 的 `specialistPresetDefinition()` 通过
 *   `specialistPresetPlugins()` 直接展开它。
 *
 * specialist 与指挥者需要同一套能力（读、写、跑命令、跑测试、加载 skill），差别只在
 * **没有** `commander-mode` 行（指挥者协议与门禁），以及多一行 specialist 人设。
 *
 * @module dsh-commander-mode/lib/capabilities
 */

/**
 * 能力行的「形状」只有几种，这里用最小的描述结构，由 `toEntry()` 展开成 Loader 的
 * entry list。`group` 行（`cordis:group`）带 `isolate` 与子行数组。
 */
export const CAPABILITY_ROWS = Object.freeze([
  Object.freeze({
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    config: Object.freeze({ maxBytes: 65536 }),
  }),
  // 按平台二选一：Windows 用 pwsh，其余用 bash。两者都声明、用 disabled 条件关掉一个，
  // 与 patch 里的 `!!js` 条件等价（这里用 JS 直接算，因为 specialist preset 走 JS 对象）。
  Object.freeze({
    id: 'tool-bash',
    name: '@deepseek-ai/dsh-tool-bash',
    disabled: { platform: 'not-win32' },
  }),
  Object.freeze({
    id: 'tool-pwsh',
    name: '@deepseek-ai/dsh-tool-pwsh',
    disabled: { platform: 'win32' },
  }),
  Object.freeze({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }),
  Object.freeze({
    id: 'tool-fs-search',
    name: '@deepseek-ai/dsh-tool-fs-search',
    config: Object.freeze({ sampleOverCapGlobResults: false }),
  }),
  Object.freeze({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }),
  Object.freeze({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }),
  Object.freeze({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }),
  Object.freeze({ id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' }),
  Object.freeze({ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' }),
  Object.freeze({
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: Object.freeze({ compaction: true, toolResultPruner: true }),
    config: Object.freeze([
      Object.freeze({ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }),
      Object.freeze({ id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' }),
      Object.freeze({
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 }),
      }),
    ]),
  }),
  Object.freeze({
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: Object.freeze({ workflowEngine: true }),
    config: Object.freeze([
      Object.freeze({
        id: 'workflow-ptc',
        name: '@deepseek-ai/dsh-workflow-ptc',
        config: Object.freeze({ provider: 'spawn' }),
      }),
      Object.freeze({ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' }),
    ]),
  }),
  Object.freeze({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }),
  Object.freeze({
    id: 'tool-todo',
    name: '@deepseek-ai/dsh-tool-todo',
    config: Object.freeze({ allowParallelInProgress: true }),
  }),
  Object.freeze({
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    config: Object.freeze({ fetch: true, searchTimeoutMs: 60000 }),
  }),
  Object.freeze({ id: 'present', name: '@deepseek-ai/dsh-tool-present' }),
]);

/** 当前平台（用于把上面 `disabled` 的抽象条件展开成布尔值）。 */
function isWin32() {
  return process.platform === 'win32';
}

/**
 * 把一条能力描述展开成 Loader entry。
 *
 * `disabled` 支持两种写法：布尔（原样）与 `{ platform: 'win32' | 'not-win32' }`、
 * 后者按当前平台求值 —— specialist preset 是运行时构造的普通对象，不能写 YAML 的
 * `!!js` 表达式，所以条件在这里落成布尔。
 *
 * @param {object} row - `CAPABILITY_ROWS` 里的一项（或本模块的同类结构）。
 * @returns {object} 可交给 `agentPresets.register()` 的 entry。
 */
export function toEntry(row) {
  const entry = { id: row.id, name: row.name };
  if (row.group !== undefined) entry.group = row.group;
  if (row.isolate !== undefined) entry.isolate = { ...row.isolate };
  if (row.config !== undefined) {
    entry.config = Array.isArray(row.config) ? row.config.map((child) => toEntry(child)) : { ...row.config };
  }
  if (row.disabled !== undefined) {
    entry.disabled = typeof row.disabled === 'boolean' ? row.disabled : resolvePlatformCondition(row.disabled);
  }
  return entry;
}

/** 展开 `{ platform }` 条件。 */
function resolvePlatformCondition(condition) {
  if (condition.platform === 'win32') return !isWin32();
  if (condition.platform === 'not-win32') return isWin32();
  throw new Error(`未知的平台条件：${String(condition.platform)}`);
}

/**
 * specialist preset 的完整 plugins 清单。
 *
 * @param {object} options - 组装参数。
 * @param {string} options.personaSectionName - specialist 人设行的 name（本包的 `./specialist` 出口）。
 * @param {string} options.persona - 人设与纪律文本。
 * @returns {object[]} entry list。
 */
export function specialistPresetPlugins({ personaSectionName, persona }) {
  return [
    ...CAPABILITY_ROWS.map((row) => toEntry(row)),
    {
      id: 'specialist-persona',
      name: personaSectionName,
      config: { persona },
    },
  ];
}

/**
 * `CAPABILITY_ROWS` 的顶层行 id（含 group 行，不含 group 的子行）。
 *
 * @returns {string[]} 行 id。
 */
export function capabilityRowIds() {
  return CAPABILITY_ROWS.map((row) => row.id);
}

/**
 * 全部行 id（含 group 子行）—— 用于「specialist preset 必须覆盖指挥者 preset 的每一行」
 * 这类结构断言。
 *
 * @returns {string[]} 行 id。
 */
export function allCapabilityRowIds() {
  const ids = [];
  for (const row of CAPABILITY_ROWS) {
    ids.push(row.id);
    if (Array.isArray(row.config)) for (const child of row.config) ids.push(child.id);
  }
  return ids;
}
