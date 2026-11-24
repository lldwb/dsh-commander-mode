/**
 * 模式变体：同一个 `dsh-commander-mode/agent` 行在**两个 preset** 下运行的差异。
 *
 * ## 为什么需要"变体"而不是"再写一个 agent 行"
 *
 * 7.26.0 用户要求加「指挥者 · CC 模式」：**小组长这一层不派 DSH 子智能体，改派 Claude Code
 * 会话**。两个模式除了"下级是谁"之外完全一样（协议、门禁、工单、看板、专家名册……），
 * 所以不该复制 96 KB 的 `lib/protocol.js` 与 2200 行的 `agent.js` —— 只让同一条模式行
 * 按 preset 判断自己在哪个变体里。
 *
 * ## 为什么按「会话头的 preset id」判，而不是按行 config
 *
 * `agent.js` 没有声明 `Config`（它的配置在顶层的 `commander-mode` 配置行里，两个 preset
 * 共享同一份），所以模式行拿不到自己的行 config。而会话头里的 `agentPreset` 是运行时
 * 事实，且**子代理也带**：`@deepseek-ai/dsh-subagent` 建子级时用
 * `agentPresets.composedPreset(parent.ctx)` 继承父级的组合 id（`child-agent.ts:142`），
 * 写进子会话 header。所以小组长（L1）读自己的 header 同样能知道"我在 CC 模式里"。
 *
 * ## 判据是"前缀"，不是"等于"
 *
 * preset id 归本包声明（`commander` / `commander-cc`），但**用户的 profile patch 可以按 id
 * 覆盖**同名行。这里按 `cc` 后缀识别，这样 `commander-cc` 与将来任何以 `-cc` 结尾的变体
 * （例如 `interview-cc`）都能复用同一套门禁，不必每加一个模式改一次代码。
 *
 * @module dsh-commander-mode/lib/mode-variant
 */

/** CC 变体的 preset id（`cordis.patch.yml` 里 `preset-commander-cc` 行的 `config.id`）。 */
export const CC_PRESET_ID = 'commander-cc';

/** 已知的两个变体。 */
export const DELEGATION_VARIANTS = Object.freeze(['native', 'cc']);

/**
 * 读一个 agent 的 preset id。
 *
 * @param {unknown} agent - 活着的 agent。
 * @returns {string | undefined} preset id；读不到时 undefined。
 */
export function presetIdOf(agent) {
  try {
    const id = agent?.session?.header?.agentPreset;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这个 preset id 是不是 CC 变体。
 *
 * 判据是**后缀**而不是等于：preset id 归本包声明（`commander` / `commander-cc`），但用户的
 * profile patch 可以按 id 覆盖同名行；将来若再派生别的 `*-cc`（例如 `interview-cc`），
 * 同一套门禁与"强制团队"逻辑都能复用，不必每加一个模式改一次代码。
 *
 * @param {unknown} id - preset id。
 * @returns {boolean} 是否 CC 变体。
 */
export function isCcPresetId(id) {
  return typeof id === 'string' && (id === CC_PRESET_ID || id.endsWith('-cc'));
}

/**
 * 这个 agent 跑在哪个变体里。
 *
 * **读不到 preset id 时按 `native`**：CC 模式是"额外加出来的能力"，读不到身份时退回原有
 * 行为最安全 —— 反过来（猜成 cc）会让普通指挥者模式的小组长被禁掉 DSH 子智能体，
 * 那是把 L1→L2 整条链切断，代价远大于"CC 模式的门禁少拦一次"。
 *
 * @param {unknown} agent - 活着的 agent。
 * @returns {'native' | 'cc'} 变体。
 */
export function delegationVariantOf(agent) {
  return isCcPresetId(presetIdOf(agent)) ? 'cc' : 'native';
}

/**
 * 把一个未识别的变体值规范化（配置/测试里手写时用）。
 *
 * @param {unknown} value - 可能是 undefined / 'cc' / 'native' / 其它。
 * @returns {'native' | 'cc'} 规范化结果。
 */
export function normalizeVariant(value) {
  return value === 'cc' ? 'cc' : 'native';
}
