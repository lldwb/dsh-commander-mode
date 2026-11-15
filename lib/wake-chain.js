/**
 * 通知链兜底：子智能体结算时**主动唤醒它的父级**（7.5.0）。
 *
 * ## 为什么需要这个模块
 *
 * 用户 2026-11-15 的口径：
 *
 * > 「子智能体完成通知小组长，小组长完成通知指挥官，而不是定期去检查进度，
 * >   除非用户确认进度」
 *
 * 也就是说：**要通知链，不要轮询**。但实测这条链会断。
 *
 * ## 断在哪（session-1d8c8c60，2026-11-15）
 *
 * 小组长 `slice-quality-lead` 派了 7 个子智能体，**全部** `turn/end completed`，
 * 但它只收到 **2 次**完成通知（`diag-forensics` 02:22、`verify-impl` 03:29），
 * 另外 5 次静默丢失（`video-defects` / `inherit-impl` / `dtext-fix` / `v5-label-fix` /
 * `dtable-fix`）。丢/送与「父会话当时有没有开着的回合」**完全相关**：
 * 送达的 2 次父正在跑，丢失的 5 次父空闲。
 *
 * 后果：`dtable-fix` 05:08:59 正常结束并交付完整报告 → 小组长没被唤醒 →
 * 指挥者也没被唤醒 → 用户连问两次「进度如何」，中间静默 49 分钟 + 1 小时 29 分钟。
 *
 * ## 运行时侧的原因（已定位到源码）
 *
 * `@deepseek-ai/dsh-subagent` 的 `notifySettlement()`：
 *
 * ```js
 * const parent = this.ctx.agents.get(parentId);
 * if (parent === void 0 || parent.ctx.fiber.state !== 2 || this.rootOf(parent) !== activation.root) return;
 * ...
 * this.sendWaking(parent, message, parent.status === "idle" ? "queue" : "steer");
 * ```
 *
 * `sendWaking` 里：
 *
 * ```js
 * const parentActivation = this.resident.get(parent.id);
 * if (parentActivation !== void 0 && ...) { this.deliver(...); this.wake(parentActivation); return; }
 * if (delivery === "steer") parent.steer(message);
 * else parent.followup(message);      // ← 父级激活已结算时走这里：排队，但不唤醒
 * ```
 *
 * 小组长的回合结束后它的 activation 已结算（所以指挥者收到了它的「finished」通知），
 * 于是它的子智能体结算时走 `followup` —— **消息进了队列，但没有任何东西把小组长叫醒**。
 * 通知在队列里等着，等到下一次有人给它发消息才被顺带读出来。
 *
 * ## 本模块做什么（只补「唤醒」，不替代运行时通知）
 *
 * 监听 `subagent/end`（host 事件，`runInfo` 形状：
 * `{ runId, provider, parentSessionId, id, local }` + `stopReason`），
 * 在**父级是被委派的子级（depth ≥ 1）**时用 `agent.steer()` 补一条**极短**的唤醒。
 *
 * - 为什么只补 depth ≥ 1：指挥者（depth 0）的通知实测每次都到（它是 root，
 *   `rootOf(parent)` 与 resident 判定都成立）；补它会变成重复噪音。
 * - 为什么用 `steer`：`steer` 会**唤醒**空闲 agent；`inject` 只写历史（插件的
 *   `steerCommander` 早就用这个结论，见 `agent.js` 的注释）。
 * - 为什么消息极短：运行时的真实通知**已经在队列里**，被唤醒后会在同一个回合里送达；
 *   我们只需要「叫醒」，不该把内容再说一遍。消息里明确写「详情见运行时通知」。
 *
 * 全程 fail-open：没有 `agents` 服务 / 读不到父会话 / steer 抛错 → 静默跳过，
 * 绝不因为兜底机制本身出错而影响正常结算。
 *
 * @module dsh-commander-mode/lib/wake-chain
 */

import { randomUUID } from 'node:crypto';

/** 本插件补的唤醒通知的 source 标记（便于在会话里区分运行时的通知）。 */
export const WAKE_SOURCE_KIND = 'dsh-commander-mode';

/**
 * 判断一个 stopReason 该不该唤醒父级。
 *
 * `completed` / `aborted` / `max-tokens` / `refusal` / `error` 都是「结束了」——
 * 父级需要知道。未知值也唤醒（宁可多叫一次，也不要让父级空等）。
 *
 * @param {unknown} stopReason - 结算原因。
 * @returns {boolean} 是否值得唤醒。
 */
export function shouldWakeFor(stopReason) {
  if (typeof stopReason !== 'string') return true;
  return stopReason.trim() !== '';
}

/**
 * 从 `subagent/end` 的 info 里取「父会话 id + 子会话 id + 名字 + 停止原因」。
 *
 * 形状来自 `@deepseek-ai/dsh-subagent` 的 `runInfo()`：
 * `{ runId, provider, parentSessionId, id, local }`，`subagent/end` 再附
 * `stopReason` 与可选的 `lastAssistantMessage`。
 *
 * @param {unknown} info - 事件 payload。
 * @returns {{ parentSessionId: string, childId: string, stopReason: string } | undefined}
 *   解析结果；关键字段缺失时 `undefined`。
 */
export function parseSettlement(info) {
  if (info === null || typeof info !== 'object') return undefined;
  const parentSessionId = typeof info.parentSessionId === 'string' ? info.parentSessionId.trim() : '';
  const childId = typeof info.id === 'string' ? info.id.trim() : '';
  if (parentSessionId === '' || childId === '') return undefined;
  const stopReason = typeof info.stopReason === 'string' && info.stopReason.trim() !== ''
    ? info.stopReason.trim()
    : 'unknown';
  return { parentSessionId, childId, stopReason };
}

/**
 * 生成给父级的唤醒正文（极短，只负责"叫醒"）。
 *
 * @param {{ childId: string, stopReason: string }} input - 结算信息。
 * @param {string} [childName] - 子级可读名（有就用，没有用会话 id）。
 * @returns {string} 唤醒正文。
 */
export function buildWakeText({ childId, stopReason }, childName) {
  const who = typeof childName === 'string' && childName.trim() !== '' ? childName.trim() : childId;
  const tail = stopReason === 'completed'
    ? '已完成'
    : `已结束（${stopReason}）`;
  return [
    `【子智能体完成】${who} ${tail}。`,
    '这是插件补的唤醒：运行时的完成通知可能已排在你的收件箱里（详情以它为准）。',
    '请核对它的产物与结论，按你的任务继续推进；该结算就结算，该回报就回报。',
  ].join('\n');
}

/**
 * 判断父级是否值得补唤醒：只补「父级本身是被委派的子级」（depth ≥ 1）。
 *
 * @param {object | undefined} parentAgent - 父级 agent（可能读不到）。
 * @returns {boolean} 是否补唤醒。
 */
export function shouldCompensate(parentAgent) {
  try {
    if (parentAgent === null || parentAgent === undefined || typeof parentAgent !== 'object') return false;
    if (typeof parentAgent.steer !== 'function') return false;
    const header = parentAgent.session?.header;
    if (header === null || header === undefined || typeof header !== 'object') return false;
    // 父级是子级（有父会话 / 来源是 subagent / 委派深度 > 0）→ 它可能是"激活已结算"的那种，
    // 运行时的 followup 不会叫醒它，需要补。
    if (header.parentSession !== undefined && header.parentSession !== null) return true;
    if (header.origin === 'subagent') return true;
    const depth = header.delegationDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 给父级投一条唤醒（`steer` 会唤醒空闲 agent）。
 *
 * @param {object} parentAgent - 父级 agent。
 * @param {string} text - 唤醒正文。
 * @param {string} summary - 一行摘要（UI / inbox 用）。
 * @returns {boolean} 是否投递成功。
 */
export function steerParent(parentAgent, text, summary) {
  try {
    if (parentAgent === null || typeof parentAgent !== 'object') return false;
    if (typeof parentAgent.steer !== 'function') return false;
    parentAgent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: WAKE_SOURCE_KIND, form: 'notice', summary },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 处理一次 `subagent/end`：必要时唤醒父级。
 *
 * @param {object} input - 依赖与事件。
 * @param {unknown} input.info - `subagent/end` 的 payload。
 * @param {(name: string) => object | undefined} input.getService - 取服务（`agents`）。
 * @param {object} [input.logger] - 可选 logger（`warn` / `debug`）。
 * @returns {{ woke: boolean, reason: string }} 结果（便于测试断言）。
 */
export function handleSettlement({ info, getService, logger } = {}) {
  try {
    const parsed = parseSettlement(info);
    if (parsed === undefined) return { woke: false, reason: 'payload-unusable' };
    if (!shouldWakeFor(info?.stopReason)) return { woke: false, reason: 'stop-reason-ignored' };

    const agents = typeof getService === 'function' ? getService('agents') : undefined;
    if (agents === undefined || agents === null || typeof agents.get !== 'function') {
      return { woke: false, reason: 'no-agents-service' };
    }
    const parentAgent = agents.get(parsed.parentSessionId);
    if (parentAgent === undefined || parentAgent === null) {
      return { woke: false, reason: 'parent-not-live' };
    }
    if (!shouldCompensate(parentAgent)) {
      // 父级是指挥者（depth 0）→ 运行时通知实测可靠，不补，避免重复噪音。
      return { woke: false, reason: 'parent-is-root' };
    }

    const childName = typeof info?.name === 'string' ? info.name : '';
    const text = buildWakeText(parsed, childName);
    const ok = steerParent(parentAgent, text, `子智能体完成：${childName || parsed.childId}`);
    if (ok) {
      logger?.debug?.('commander-mode: 已为结算的子智能体补唤醒父级（%s）', parsed.childId);
      return { woke: true, reason: 'steered' };
    }
    return { woke: false, reason: 'steer-failed' };
  } catch (error) {
    logger?.warn?.('commander-mode: 通知链兜底失败（按跳过处理）：%o', error);
    return { woke: false, reason: 'error' };
  }
}
