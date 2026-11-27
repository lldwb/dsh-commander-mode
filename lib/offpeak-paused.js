/**
 * 「谷峰暂停后续做」：识别**被谷峰（高峰暂停）打断**的下级，并提示指挥官**复用/等待**
 * 它们，而不是当成失败重新派一批。
 *
 * ## 与 `reboot-resume.js`（7.28.0）的分工
 *
 * 那个模块处理的是「宿主重启后，下级会话还在册但 Agent 没了」——用 `session_resume_subagents`
 * 冷恢复。本模块处理的是**同一形态的一个特例**：
 *
 * - 谷峰在高峰时段把正在跑的下级 `cancel` 掉（`aborted + hook + offpeak-pause`）；
 * - 下级**还活着**（Agent 在、会话在），只是被暂停；进入空闲时段或用户关掉谷峰后
 *   会自动续跑（`dsh-session-enhance` 的 offpeak controller 负责）；
 * - 但指挥官的上下文里看不到"它只是被暂停"，很容易把它当失败：重新 `subagent` 派一批、
 *   或者向用户报错。
 *
 * 所以这里把事实摆到它眼前：**哪些下级是被谷峰暂停的、它们会自己恢复**。
 *
 * ## 数据来源与成本
 *
 * 判定需要读子会话日志（最后一个 `turn/end` 的 reason）；`listDescendants()` 只给
 * 身份与活动态。所以由 `agent.js` 的团队快照刷新时顺带异步读（同一 agent 不并发），
 * 结果缓存在快照里；本模块只做纯函数（判定 + 渲染），便于离线单测。
 *
 * @module dsh-commander-mode/lib/offpeak-paused
 */

/** 运行时上下文里这一段的标题。 */
export const OFFPEAK_PAUSED_TITLE = '## 谷峰暂停后续做：被暂停的下级会自己恢复，别当失败重派';

/**
 * 一条 `turn/end` 的 reason 是不是「被谷峰高峰暂停打断」。
 *
 * @param {{ kind?: string, reason?: { kind?: string, reason?: string } } | undefined} reason - `turn/end` 的 reason。
 * @returns {boolean} 是则 true。
 */
export function isOffpeakPause(reason) {
  return (
    reason?.kind === 'aborted' &&
    reason?.reason?.kind === 'hook' &&
    reason?.reason?.reason === 'offpeak-pause'
  );
}

/**
 * 从一份会话事件数组里取「最后一个回合的结束原因」。
 *
 * @param {any[] | undefined} events - `sessionQuery.readSession(id)` 的 events。
 * @returns {any | undefined} 最后一个 `turn/end` 的 reason；没有则 undefined。
 */
export function lastTurnEndReason(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn/end') return event.data?.reason;
  }
  return undefined;
}

/**
 * 从 `listDescendants()` 的行里挑出「被谷峰高峰暂停」的直接下级。
 *
 * 判定需要读子会话日志的最后一个 `turn/end` reason，所以由调用方注入 `readSession`；
 * 结果按会话 id 缓存在 `cache`（Map）里，避免每轮把整份日志重读一遍。
 * 读不到（没有 sessionQuery / 日志损坏）按「不是暂停」处理——宁可少提示一次，
 * 也不要把正常下级误报成暂停。
 *
 * @param {object} input - 参数。
 * @param {any[]} [input.rows] - `subagents.listDescendants()` 的结果。
 * @param {(id: string) => Promise<{ events?: any[] }>} input.readSession - 读子会话。
 * @param {Map<string, { paused: boolean, at: number }>} [input.cache] - 判定缓存。
 * @param {number} [input.now] - 当前时间（单测注入）。
 * @param {number} [input.ttlMs] - 缓存有效期。
 * @param {number} [input.limit] - 最多检查多少个下级（防止超大团队拖慢）。
 * @returns {Promise<{ id: string, name: string }[]>} 被暂停的下级。
 */
export async function collectOffpeakPaused(input) {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const readSession = input?.readSession;
  if (typeof readSession !== 'function') return [];
  const cache = input?.cache instanceof Map ? input.cache : new Map();
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const ttlMs = Number.isFinite(input?.ttlMs) && input.ttlMs > 0 ? input.ttlMs : 60 * 1000;
  const limit = Number.isFinite(input?.limit) && input.limit > 0 ? Math.trunc(input.limit) : 8;

  const candidates = rows
    .filter((row) => row !== null && typeof row === 'object' && row.kind === 'child')
    .filter((row) => (typeof row.depth === 'number' ? row.depth === 1 : true))
    // 正在跑的不可能是「被暂停」（真在跑就让它跑）。
    .filter((row) => row.activity !== 'running')
    .filter((row) => typeof row.id === 'string' && row.id !== '')
    .slice(0, limit);

  const paused = [];
  for (const row of candidates) {
    const id = row.id;
    const cached = cache.get(id);
    let isPaused;
    if (cached !== undefined && now - cached.at < ttlMs) {
      isPaused = cached.paused;
    } else {
      try {
        const snapshot = await readSession(id);
        isPaused = isOffpeakPause(lastTurnEndReason(snapshot?.events));
      } catch {
        isPaused = false;
      }
      cache.set(id, { paused: isPaused, at: now });
    }
    if (isPaused === true) {
      paused.push({
        id,
        name: typeof row.path === 'string' && row.path !== '' ? row.path : id,
      });
    }
  }
  return paused;
}

/**
 * 渲染「谷峰暂停后续做」提示块。
 *
 * 没有这类下级时返回空串（不占 token、不制造噪音）。
 *
 * @param {object} input - 参数。
 * @param {{ id: string, name: string }[]} [input.paused] - 被谷峰暂停的下级。
 * @param {boolean} [input.resumeToolPresent] - 当前 agent 是否有 `session_resume_subagents`。
 * @returns {string} 上下文文本（可能为空串）。
 */
export function renderOffpeakPausedNotice({ paused = [], resumeToolPresent = true } = {}) {
  const items = (Array.isArray(paused) ? paused : []).filter(
    (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '',
  );
  if (items.length === 0) return '';

  const lines = [OFFPEAK_PAUSED_TITLE, ''];
  lines.push(
    `你有 **${items.length} 个下级**正在被「谷峰」的高峰暂停挡着（不是失败、不是重启丢失）：`,
  );
  lines.push('');
  for (const item of items.slice(0, 8)) lines.push(`- \`${item.name}\`（\`${item.id}\`）`);
  if (items.length > 8) lines.push(`- …还有 ${items.length - 8} 个`);
  lines.push('');
  lines.push('处理口径（重要）：');
  lines.push('1. **不要重新派一批**替代它们——它们的会话与上下文都在，重派等于同一份活做两遍；');
  lines.push('2. **不要当成失败追责或向用户报错**——中断原因是高峰暂停，空闲时段开始或用户关掉谷峰后会自动续跑；');
  if (resumeToolPresent) {
    lines.push(
      '3. 只有**需要立刻推进**（不能等空闲）时才 `session_resume_subagents` 冷恢复它们；否则先做别的不需要模型调用的准备/核对，等它们自己回来。',
    );
  } else {
    lines.push('3. 本会话没有 `session_resume_subagents`，只能等它们自动恢复（或让用户先关掉谷峰）；期间不要新开同期下级。');
  }
  return lines.join('\n');
}
