/**
 * 「在下级未收尾」的回合收尾提醒（7.24.0 修3）。
 *
 * ## 为什么需要它
 *
 * 协议要求小组长「没有可推进的事 → 结束回合等通知」，但运行时的结算通知在父级回合
 * 不在跑时会被**静默丢弃**（根因见 `lib/pending-notices.js`）。即使 7.24.0 补了冷唤醒，
 * 如果小组长在**还有下级在跑**的时候就收尾，仍然会进入"等一个可能不会来的通知"的状态。
 *
 * 所以收尾钩子（`agent/turn-stopping`）对**被委派的 agent**（depth ≥ 1）额外看一次台账：
 * 若还有在飞下级，就注入一条 advisory 提醒它继续推进——**不硬拦**（不 cancel、不 deny），
 * 只给模型一次改正机会；同一回合只注入一次；读不到成员快照时按"未知"不注入（fail-open）。
 *
 * @module dsh-commander-mode/lib/in-flight-advisory
 */

/** 提醒里最多点名多少个在飞下级（其余折叠成计数）。 */
export const ADVISORY_MAX_NAMES = 8;

/**
 * 构造「在下级未收尾」提醒文本。
 *
 * @param {object} [input] - 判定输入。
 * @param {object[]} [input.members] - 执行者子树成员快照（每项 `{ name, status }`；
 *   `status === 'running'` 表示在飞）。
 * @param {number} [input.depth] - 该 agent 的委派深度（root 为 0；只有 ≥ 1 才提醒）。
 * @returns {string} 提醒文本；不该提醒时返回 `''`。
 */
export function buildInFlightAdvisory({ members, depth } = {}) {
  try {
    if (!(typeof depth === 'number' && Number.isFinite(depth) && depth > 0)) return '';
    const rows = Array.isArray(members) ? members : [];
    const running = rows.filter((item) => item !== null && typeof item === 'object' && item.status === 'running');
    if (running.length === 0) return '';
    const names = running
      .map((item) => (typeof item.name === 'string' && item.name !== '' ? item.name : '（未命名）'))
      .slice(0, ADVISORY_MAX_NAMES);
    const tail = running.length > names.length ? ` …（共 ${running.length} 个在飞）` : '';
    return [
      `【执行者·收尾提醒】你还有 ${running.length} 个下级在跑：${names.join('、')}${tail}。`,
      '**有在飞下级时不得结束回合**：先推进（用 `send_message` 追问/追加指令，或 `interrupt_agent` 纠偏）。',
      '确实只能等外部输入时再收尾，并在回复里写明"在等哪个下级、等它的什么产物"。',
    ].join('\n');
  } catch {
    return '';
  }
}
