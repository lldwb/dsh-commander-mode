/**
 * **待投递的结算通知**（7.19.0）：运行时在父级空闲时**静默丢弃**子智能体完成通知，
 * 这里补一条**持久化队列**，等父级下次醒来时再交给它。
 *
 * ## 根因（已确证，读运行时源码 + 会话日志双向验证）
 *
 * `@deepseek-ai/dsh-subagent` 的 `notifySettlement()`：
 *
 * ```js
 * const parent = this.ctx.agents.get(parentId);
 * if (parent === void 0 || parent.ctx.fiber.state !== 2 || this.rootOf(parent) !== activation.root) return;
 * ...
 * this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer');
 * ```
 *
 * **`parent.ctx.fiber.state !== 2`（父级回合不在跑）→ 直接 return**：通知既不生成、
 * 不排队、也不唤醒 —— **静默丢弃**。（7.5.0 的注释写成"排队但不唤醒"是不准确的，
 * 那条分支只在父级有 activity 时才会走到。）
 *
 * ## 实测（`9fbe2191` = 小组长 `layout-paradigm-lead`，2026-11-18）
 *
 * 它派了 6 个子智能体，只收到 **2 个**完成通知，而且**规律 100% 吻合**：
 *
 * | 子智能体 | 结束时小组长 | 通知 |
 * |---|---|---|
 * | `code-structure-analyst` 09:02:55 | turn 1 **在跑** | ✅ |
 * | `bdx-reverser` 09:09:00 | turn 2 **在跑** | ✅ |
 * | `diag-data-analyst` 09:07:00 | 空闲（09:05:01 结束） | ❌ |
 * | `svg-verifier` 09:20:56 | 空闲（09:15:40 结束） | ❌ |
 * | `diag-direction-fields` 09:51:46 | 空闲（09:40:29 结束） | ❌ |
 * | `impl-zero-direction` 09:59:17 | 空闲 | ❌ |
 *
 * 最后是**上级**发来「子智能体已经完成任务了」才把它叫醒（turn 5 @ 10:00:11）——
 * 它自己完全不知道那 4 个已经完成。
 *
 * ## 为什么 7.5.0 的 `steer` 补偿也只救回 2/6
 *
 * 补偿要求 `agents.get(parentSessionId)` 拿到**活着的** parent agent；父级回合已结束、
 * 实例被回收时拿不到 → 走 `parent-not-live` 直接放弃。**所以"补一条 steer"解决不了
 * 父级已休眠的情况**，必须把通知**存下来**，等它下次醒来再给。
 *
 * @module dsh-commander-mode/lib/pending-notices
 */

/** 每个会话最多保留多少条待投递通知（防止长期积压）。 */
export const MAX_PENDING_NOTICES = 20;

/** 待投递通知最多保留多久（毫秒）；过期丢弃，避免几天后翻旧账。 */
export const PENDING_NOTICE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 往账本里记一条待投递通知（就地改写）。
 *
 * @param {object} ledger - 同步账本（会随 7.12.0 的快照持久化）。
 * @param {object} notice - 通知内容。
 * @param {string} notice.childId - 子会话 id。
 * @param {string} [notice.name] - 子智能体名字。
 * @param {string} [notice.stopReason] - 停止原因。
 * @param {number} [notice.at] - 发生时间。
 * @returns {boolean} 是否记录成功。
 */
export function pushPendingNotice(ledger, notice) {
  try {
    if (ledger === null || typeof ledger !== 'object') return false;
    const childId = typeof notice?.childId === 'string' ? notice.childId.trim() : '';
    if (childId === '') return false;
    if (!Array.isArray(ledger.pendingNotices)) ledger.pendingNotices = [];
    const at = Number.isFinite(notice?.at) ? notice.at : Date.now();
    // 同一子会话只留一条（重复的 subagent/end 不该反复占位）。
    ledger.pendingNotices = ledger.pendingNotices.filter((item) => item?.childId !== childId);
    ledger.pendingNotices.push({
      childId,
      name: typeof notice?.name === 'string' ? notice.name.slice(0, 120) : '',
      stopReason: typeof notice?.stopReason === 'string' ? notice.stopReason.slice(0, 40) : '',
      at,
    });
    if (ledger.pendingNotices.length > MAX_PENDING_NOTICES) {
      ledger.pendingNotices = ledger.pendingNotices.slice(-MAX_PENDING_NOTICES);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 取出并清空待投递通知（就地改写）。
 *
 * @param {object} ledger - 同步账本。
 * @param {number} [now] - 当前时间（用于 TTL）。
 * @returns {object[]} 未过期的通知（按发生时间升序）。
 */
export function drainPendingNotices(ledger, now = Date.now()) {
  try {
    if (ledger === null || typeof ledger !== 'object') return [];
    const rows = Array.isArray(ledger.pendingNotices) ? ledger.pendingNotices : [];
    if (rows.length === 0) return [];
    const fresh = rows
      .filter((item) => item !== null && typeof item === 'object' && typeof item.childId === 'string')
      .filter((item) => !(Number.isFinite(item.at) && now - item.at > PENDING_NOTICE_TTL_MS))
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    ledger.pendingNotices = [];
    return fresh;
  } catch {
    return [];
  }
}

/**
 * 渲染待投递通知的提示文本（父级下次醒来时看到）。
 *
 * @param {object[]} notices - `drainPendingNotices()` 的结果。
 * @returns {string} 提示文本；空数组时返回 `''`。
 */
export function renderPendingNotices(notices) {
  try {
    const rows = Array.isArray(notices) ? notices : [];
    if (rows.length === 0) return '';
    const lines = rows.map((item) => {
      const who = typeof item.name === 'string' && item.name !== '' ? item.name : item.childId;
      const tail = item.stopReason === 'completed' || item.stopReason === '' ? '已完成' : `已结束（${item.stopReason}）`;
      return `- ${who} ${tail}`;
    });
    return [
      `【子智能体结算通知（补投）】你在空闲期间有 ${rows.length} 个子智能体结束了，`,
      '运行时的完成通知会**静默丢弃**（父级回合不在跑时），下面是插件替你存下来的：',
      ...lines,
      '请核对它们的产物与结论，按你的任务继续推进；该结算就结算、该回报就回报。',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * 判断一次 `subagent/end` 是否需要**入队补投**（7.19.0）。
 *
 * 需要补投的两种情形：
 * 1. 父级 agent 拿不到（`parent-not-live`）→ 运行时必然丢弃，只能存下来；
 * 2. 父级拿到了但它是"被委派的子级"且当前空闲 → 即使 steer 也可能落在已结算的激活上。
 *
 * 指挥者（depth 0）不补：运行时对 root 的通知实测可靠（它是 root，`rootOf` 与
 * resident 判定都成立），补了只会重复。
 *
 * @param {object} [input] - 判定输入。
 * @param {object | undefined} [input.parentAgent] - 父级 agent（可能拿不到）。
 * @param {string} [input.stopReason] - 停止原因。
 * @returns {boolean} 是否入队。
 */
export function shouldQueueNotice({ parentAgent, stopReason } = {}) {
  try {
    if (typeof stopReason === 'string' && stopReason.trim() === '') return false;
    if (parentAgent === null || parentAgent === undefined) return true; // 拿不到父级 → 必须存
    const header = parentAgent.session?.header;
    if (header === null || header === undefined || typeof header !== 'object') return false;
    // 只给"被委派的子级"（depth ≥ 1）补；指挥者的通知实测可靠。
    const isChild = (header.parentSession !== undefined && header.parentSession !== null)
      || header.origin === 'subagent'
      || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0);
    if (!isChild) return false;
    // 父级空闲 → steer 也可能丢，入队更稳（真正投递发生在它下次醒来时）。
    return parentAgent.status === 'idle';
  } catch {
    return false;
  }
}

/**
 * 取走一个会话积压的结算通知，用于**会话开场/被冷唤醒后主动补投**（7.24.0 修2）。
 *
 * 与 `systemPrompt.context` 里的 `drainNotices` 是同一个队列：`drain` 是破坏性的，
 * 所以同一批通知只可能被交付一次（开场补投与上下文补投天然互斥、不会重复）。
 *
 * @param {object} input - 依赖。
 * @param {object} [input.service] - 账本服务（`getLedger()`；需有 `drainPendingNotices`）。
 * @param {string} [input.sessionId] - 目标会话 id。
 * @returns {{ count: number, text: string }} 补投条数与渲染文本；无积压时为 `{ count: 0, text: '' }`。
 */
export function takePendingForRedelivery({ service, sessionId } = {}) {
  try {
    if (service === null || service === undefined || typeof service !== 'object') return { count: 0, text: '' };
    if (typeof service.drainPendingNotices !== 'function') return { count: 0, text: '' };
    if (typeof sessionId !== 'string' || sessionId === '') return { count: 0, text: '' };
    const notices = service.drainPendingNotices(sessionId);
    if (!Array.isArray(notices) || notices.length === 0) return { count: 0, text: '' };
    const text = renderPendingNotices(notices);
    if (text === '') return { count: 0, text: '' };
    return { count: notices.length, text };
  } catch {
    return { count: 0, text: '' };
  }
}
