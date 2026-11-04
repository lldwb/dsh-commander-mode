/**
 * 派发门禁 —— 把「计划确认后才派活」「每件活有工单」从提示词升级为确定性检查（0.6.0）。
 *
 * ## 为什么是代码
 *
 * README 自己承认：「规划后先确认」「分歧上报」由协议保证，模型偶尔会跳过。0.4/0.5 的
 * 事故里最贵的一种正是"没确认就派了一堆活"。这里用与「指挥者不执行」相同的机制
 * （`tools/pre-execute` 返回 deny）把它变成可测试的规则：
 *
 * - 没有**有效的计划授权（Mandate）** → 拒绝派发；
 * - 有授权但派发没带**工单 id** → 拒绝（要求先 `commander_ticket_create`）；
 * - 工单不存在/已结束/不属于本会话/建立时的授权已过期 → 拒绝。
 *
 * ## 必须放行的情形（与 `lib/guard.js` 同一原则：宁可漏拦，不可拦死）
 *
 * - 子代理（teammate/subagent）自己调用派发工具：它们不是指挥者，不该被指挥者的门禁拦；
 * - 这个部署没有账本服务：降级回 0.5 行为（只靠协议）；
 * - 读不到会话 id / 读不到工单：当作"未知"放行，并让调用方日志可见；
 * - `requireMandate: false`：用户显式关掉这套规则。
 *
 * ## 哪些工具有"新工作"语义
 *
 * 只有**开启一件新活**的工具受门禁约束：一次性子代理、workflow、spawn_teammate。
 * `send_message` 是对已有 teammate 的追加/续做，不算新工作；`wait_agent` / `list_agents` /
 * `team_task_*` 是等待与状态操作，也不拦。
 *
 * @module dsh-commander-mode/lib/dispatch-gate
 */

import { isDelegatedAgent } from './guard.js';
import { isTerminal, PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID } from './tickets.js';

/** 具有"开启新工作"语义的工具（specialist 工具按 `subagent_` 前缀识别）。 */
export const NEW_WORK_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'commander_worker_spawn',
]);

/** 工单标记：`[ticket:t-1]`（Team 工具没有 ticket 参数，只能靠 prompt 标记）。 */
export const TICKET_MARKER = /\[ticket:([A-Za-z0-9_.-]+)\]/;

/**
 * 判断一次工具调用是否属于"派发新工作"。
 *
 * @param {string} name - 工具名。
 * @returns {boolean} 是否需要 Mandate/工单。
 */
export function isNewWorkTool(name) {
  const toolName = typeof name === 'string' ? name : '';
  if (toolName === '') return false;
  if (NEW_WORK_TOOLS.includes(toolName)) return true;
  return toolName.startsWith('subagent_');
}

/**
 * 从派发参数里提取工单 id。
 *
 * 两条来源（按优先级）：
 * 1. 工具参数 `ticket`（本插件给 specialist 工具加的字段）；
 * 2. task/prompt/message 文本里的 `[ticket:t-N]` 标记（Team 工具只有自由文本）。
 *
 * @param {unknown} args - 工具参数。
 * @returns {string | undefined} 工单 id。
 */
export function ticketFromDispatchArgs(args) {
  if (args === null || typeof args !== 'object') return undefined;
  if (typeof args.ticket === 'string' && args.ticket.trim() !== '') return args.ticket.trim();
  for (const key of ['task', 'prompt', 'message', 'description']) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const match = TICKET_MARKER.exec(value);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * 判断一次派发是否通过门禁。
 *
 * @param {object} input - 判定输入。
 * @param {unknown} input.agent - 发起调用的 agent。
 * @param {string} input.name - 工具名。
 * @param {unknown} input.args - 工具参数。
 * @param {boolean} input.requireMandate - 是否要求计划授权。
 * @param {boolean} input.requireTicket - 是否要求工单归属。
 * @param {object | undefined} input.ledger - `commanderLedger` 服务（可能缺失）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策或放行。
 */
export function evaluateDispatchGate({ agent, name, args, requireMandate, requireTicket, ledger }) {
  if (requireMandate !== true) return undefined;
  if (isDelegatedAgent(agent)) return undefined;
  if (!isNewWorkTool(name)) return undefined;
  if (ledger === undefined || ledger === null) return undefined; // 降级：没有账本只靠协议。

  const sessionId = sessionIdOf(agent);
  if (sessionId === undefined) return undefined; // 身份不明 → 放行（宁可漏拦）。

  let mandate;
  let tickets;
  try {
    mandate = ledger.activeMandate(sessionId);
    tickets = ledger.listTickets(sessionId);
  } catch {
    return undefined; // 读不到状态不拦。
  }

  if (mandate === null) {
    return {
      kind: 'deny',
      reason: [
        `指挥者模式：派发新工作之前必须先让用户确认计划（没有有效的计划授权）。`,
        `请先调用 \`ask_user_question\`，并把问题 id 精确写成 \`${PLAN_QUESTION_ID}\`；问题正文里列出计划（目标、拆分、每步产出物、验收判据、分工）；`,
        `选项第一项 label 精确写成「${PLAN_CONFIRM_LABEL}」。用户选择它之后，本次派发才会被允许。`,
        '不要重试本工具；不要自己假装用户已确认。',
      ].join('\n'),
    };
  }

  const ticketId = ticketFromDispatchArgs(args);
  if (ticketId === undefined) {
    if (requireTicket !== true) return undefined;
    const openIds = tickets.map((ticket) => ticket.id);
    return {
      kind: 'deny',
      reason: [
        '指挥者模式：每一次派发都必须挂在一张工单上（工单是这个模式里"一件被授权的活"）。',
        openIds.length === 0
          ? '当前会话还没有工单：先调用 `commander_ticket_create` 建工单（标题 + 验收判据）。'
          : `当前会话的工单：${openIds.join('、')}。先确认这次派发属于哪一张（一张工单可多次派发）；需要新工单就调用 \`commander_ticket_create\`。`,
        '派发时带上工单：一次性子代理工具传 `ticket` 参数；Team 工具在 task/prompt 首行写 `[ticket:t-N]`。',
        '不要重试本工具。',
      ].join('\n'),
    };
  }

  let ticket;
  try {
    ticket = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
  } catch {
    return undefined;
  }
  if (ticket === null) {
    return {
      kind: 'deny',
      reason: [
        `找不到工单 \`${ticketId}\`（或它不属于当前会话）。`,
        '先用 `commander_tickets` 查看当前会话的工单；需要新建就调用 `commander_ticket_create`。',
        '不要重试本工具。',
      ].join('\n'),
    };
  }
  if (isTerminal(ticket)) {
    return {
      kind: 'deny',
      reason: `工单 \`${ticket.id}\` 已结束（${ticket.status}），不能再往它上面派活。需要继续就新建工单，并在计划里说明为什么重开。`,
    };
  }
  if (ticket.mandateId !== mandate.id) {
    return {
      kind: 'deny',
      reason: [
        `工单 \`${ticket.id}\` 是在上一版计划下建立的，而用户刚确认了新计划（授权 ${mandate.id}）。`,
        '不要派到旧工单上：用 `commander_ticket_create` 按新计划建工单，或先向用户说明哪些旧工单要作废（`commander_ticket_update` 取消）。',
      ].join('\n'),
    };
  }
  return undefined;
}

/** 从 agent 读会话 id；读不到返回 undefined。 */
export function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id;
    if (typeof id !== 'string' || id.trim() === '') return undefined;
    return id;
  } catch {
    return undefined;
  }
}

/** 供工具描述复用：一段简短的授权说明。 */
export const MANDATE_NOTE = '派发前必须已有用户确认的计划（`ask_user_question` 的问题 id = `commander-plan`），且每次派发都带工单 id。';
