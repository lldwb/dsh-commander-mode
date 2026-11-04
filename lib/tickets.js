/**
 * 工单（Ticket）状态机 —— 0.6.0 的纯函数内核。
 *
 * ## 为什么需要它
 *
 * 0.4/0.5 的看板只回答"任务板/计划清单同步了没"，不回答"**每一件被派出去的活**现在在
 * 哪一步、卡在谁身上、要不要人管"。真实事故（`session-7064696b`）里 6/14 任务没人收尾，
 * 根因不是没提示，而是**没有一件活的独立状态**：任务板是 Team 的，计划清单是 todo 的，
 * 子代理结果只是散落在会话历史里的文本。
 *
 * 这里引入最小闭环（借 Super-agent 的 Ticket/Assignment/Report 形状，裁剪到指挥者场景）：
 *
 * ```
 * Ticket（一件被授权的活）
 *   ├─ Mandate：用户确认的计划（谁在什么时候、按哪版计划授权）
 *   ├─ Assignment：一次派发（通道、工具、开始时间）
 *   └─ Report：执行者交回的结构化状态（六态）
 * ```
 *
 * ## 设计约束
 *
 * - **纯函数**：不读文件、不碰时间（时间由调用方传入）——这样单测可以钉住每一条状态迁移。
 * - **不引入 Source/Thread/Eval**：指挥者场景没有多源事件，Trigger 就是用户消息或完成通知。
 * - **一 ticket 一记录**：不保留完整报告历史（只留 `lastReport`），账本才不会无限膨胀；
 *   需要追溯时以会话日志为准（DSH 的 Model-visible means logged 不变量）。
 *
 * @module dsh-commander-mode/lib/tickets
 */

import { createHash } from 'node:crypto';

/** 计划确认问题的固定 id（协议要求模型必须用这个 id）。 */
export const PLAN_QUESTION_ID = 'commander-plan';

/** 计划确认问题里"确认执行"选项的固定 label（精确匹配才算授权）。 */
export const PLAN_CONFIRM_LABEL = '确认，开始执行';

/** 计划确认问题里"需要调整"选项的固定 label（不授权）。 */
export const PLAN_ADJUST_LABEL = '需要调整';

/** 工单状态。 */
export const TICKET_STATUS = Object.freeze({
  OPEN: 'open',
  WORKING: 'working',
  WAITING: 'waiting',
  REVIEW: 'review',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  DONE: 'done',
  CANCELLED: 'cancelled',
});

/** 终态。 */
export const TERMINAL_STATUSES = Object.freeze([TICKET_STATUS.DONE, TICKET_STATUS.CANCELLED]);

/** 执行者回报的六态（与 Super-agent 的 Report 对齐）。 */
export const REPORT_STATUS = Object.freeze({
  PROGRESS: 'progress',
  WAITING: 'waiting',
  READY: 'ready',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  DROPPED: 'dropped',
});

/** 六态 → 工单状态。 */
const REPORT_TO_STATUS = Object.freeze({
  progress: TICKET_STATUS.WORKING,
  waiting: TICKET_STATUS.WAITING,
  ready: TICKET_STATUS.REVIEW,
  blocked: TICKET_STATUS.BLOCKED,
  failed: TICKET_STATUS.FAILED,
  dropped: TICKET_STATUS.CANCELLED,
});

/** 对模型暴露的"可更新状态"集合（工具参数用）。 */
export const UPDATABLE_STATUSES = Object.freeze([
  TICKET_STATUS.WAITING,
  TICKET_STATUS.REVIEW,
  TICKET_STATUS.BLOCKED,
  TICKET_STATUS.FAILED,
  TICKET_STATUS.DONE,
  TICKET_STATUS.CANCELLED,
]);

/** 派发通道。 */
export const ASSIGNMENT_CHANNEL = Object.freeze({
  SPECIALIST: 'specialist',
  TEAM: 'team',
  ONE_SHOT: 'one-shot',
  WORKER: 'worker',
});

/** 状态集合（用于校验外部输入）。 */
const ALL_STATUSES = new Set(Object.values(TICKET_STATUS));

/**
 * 判断是否为终态。
 *
 * @param {object} ticket - 工单。
 * @returns {boolean} 是否已结束。
 */
export function isTerminal(ticket) {
  return ticket !== null && typeof ticket === 'object' && TERMINAL_STATUSES.includes(ticket.status);
}

/**
 * 判断工单是否仍可被推进。
 *
 * @param {object} ticket - 工单。
 * @returns {boolean} 是否未结束。
 */
export function isOpen(ticket) {
  return ticket !== null && typeof ticket === 'object' && ALL_STATUSES.has(ticket.status) && !isTerminal(ticket);
}

/**
 * 工单当前阶段（给看板排序用）。
 *
 * 判定顺序与 Super-agent 的 `ticketStage` 同构：先答人工、再评审、再阻塞/失败、再工作、
 * 最后排队/空闲。
 *
 * @param {object} ticket - 工单。
 * @returns {string} 阶段：`answer` / `review` / `blocked` / `failed` / `working` / `idle` / `queued` / `ended`。
 */
export function ticketStage(ticket) {
  if (ticket === null || typeof ticket !== 'object') return 'ended';
  if (isTerminal(ticket)) return 'ended';
  const report = ticket.lastReport;
  if (ticket.status === TICKET_STATUS.BLOCKED) return 'blocked';
  if (ticket.status === TICKET_STATUS.FAILED) return 'failed';
  if (ticket.status === TICKET_STATUS.REVIEW) return 'review';
  if (ticket.status === TICKET_STATUS.WAITING) return 'idle';
  if (ticket.status === TICKET_STATUS.WORKING) return 'working';
  if (ticket.status === TICKET_STATUS.OPEN) {
    return report === null || report === undefined ? 'queued' : 'working';
  }
  return 'queued';
}

/**
 * 这个工单是否需要人做决定（看板置顶的判据）。
 *
 * @param {object} ticket - 工单。
 * @returns {boolean} 是否需要人。
 */
export function needsPerson(ticket) {
  if (ticket === null || typeof ticket !== 'object') return false;
  return [
    TICKET_STATUS.REVIEW,
    TICKET_STATUS.BLOCKED,
    TICKET_STATUS.FAILED,
  ].includes(ticket.status);
}

/**
 * 工单是否停滞：一次 Assignment 已开始、超过阈值仍没有任何新 Report。
 *
 * 注意：这是**代理指标**，不是"任务真的没进展"——所以看板只提示"先核对产物"，不自动
 * 重派或结束（Super-agent 也说任务层巡检是五模块里最难的）。
 *
 * @param {object} ticket - 工单。
 * @param {number} now - 当前时间（ms）。
 * @param {number} stallMs - 停滞阈值（ms）。
 * @returns {boolean} 是否疑似停滞。
 */
export function isStalled(ticket, now, stallMs) {
  if (!isOpen(ticket) || typeof now !== 'number' || typeof stallMs !== 'number' || stallMs <= 0) return false;
  if (ticket.status !== TICKET_STATUS.WORKING && ticket.status !== TICKET_STATUS.OPEN) return false;
  const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : [];
  const last = assignments[assignments.length - 1];
  if (last === undefined || last === null) return false;
  const startedAt = Number(last.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  // 已经有比这次 Assignment 更新的 Report → 不算停滞（执行者在汇报）。
  const reportAt = Number(ticket.lastReport?.at);
  if (Number.isFinite(reportAt) && reportAt >= startedAt) return false;
  return now - startedAt >= stallMs;
}

/**
 * 计算一次计划确认的哈希。
 *
 * 只对"面向用户的计划文本 + 确认问题 + 选项"取哈希：模型重写措辞时哈希会变，这是有意的
 * ——授权绑定的是**用户当时看到的那份计划**，不是"任何计划"。
 *
 * @param {object} question - `ask_user_question` 里的一个问题对象。
 * @returns {string} 16 位十六进制哈希。
 */
export function planHash(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const text = [
    typeof question?.header === 'string' ? question.header : '',
    typeof question?.question === 'string' ? question.question : '',
    ...options.map((option) => (typeof option?.label === 'string' ? option.label : '')),
  ].join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 从 `ask_user_question` 的调用参数里找计划确认问题。
 *
 * @param {unknown} args - 工具参数。
 * @returns {object | undefined} 问题对象（id 必须是 `commander-plan`）。
 */
export function findPlanQuestion(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  return questions.find((question) => question?.id === PLAN_QUESTION_ID);
}

/**
 * 判断一份计划是否被**明确确认**。
 *
 * 确定性规则：对应答案的 `selected` 里必须**精确包含** `确认，开始执行`；用户自己输入
 * 以"确认"开头的自定义答案也算（`custom`）。被跳过（selected 为空且无 custom）不算。
 *
 * @param {object} question - 计划确认问题。
 * @param {unknown} value - `ask_user_question` 的返回值（`{ answers: [...] }`）。
 * @returns {{ confirmed: boolean, answer: object | undefined }} 判定结果。
 */
export function isPlanConfirmed(question, value) {
  const answers = Array.isArray(value?.answers) ? value.answers : [];
  const answer = answers.find((item) => item?.id === PLAN_QUESTION_ID);
  if (answer === undefined || answer === null) return { confirmed: false, answer: undefined };
  const selected = Array.isArray(answer.selected) ? answer.selected.map(String) : [];
  if (selected.includes(PLAN_CONFIRM_LABEL)) return { confirmed: true, answer };
  const custom = typeof answer.custom === 'string' ? answer.custom.trim() : '';
  if (custom.startsWith('确认')) return { confirmed: true, answer };
  return { confirmed: false, answer };
}

// ---------------------------------------------------------------- 记录 ---

/**
 * 创建一个新工单记录（不校验 session，由账本服务负责作用域）。
 *
 * @param {object} input - 创建参数。
 * @param {string} input.id - 工单 id（账本分配，如 `t-1`）。
 * @param {string} input.sessionId - 所属会话。
 * @param {string} input.title - 一句话标题。
 * @param {string} [input.intent] - 目标/背景。
 * @param {string[]} [input.acceptance] - 验收判据。
 * @param {string[]} [input.scope] - 写作用域（提示，不是锁）。
 * @param {string | null} [input.mandateId] - 创建时继承的计划授权 id。
 * @param {number} input.at - 创建时间（ms）。
 * @returns {object} 工单记录。
 */
export function createTicketRecord({ id, sessionId, title, intent = '', acceptance = [], scope = [], mandateId = null, at }) {
  return {
    id: String(id),
    sessionId: String(sessionId),
    title: String(title),
    intent: String(intent),
    acceptance: Array.isArray(acceptance) ? acceptance.map(String) : [],
    scope: Array.isArray(scope) ? scope.map(String) : [],
    status: TICKET_STATUS.OPEN,
    mandateId: mandateId === null || mandateId === undefined ? null : String(mandateId),
    assignments: [],
    lastReport: null,
    /** Worker Session 执行信息（0.8.0 opt-in）：{ sessionId, directory, startedAt, permission }。 */
    execution: null,
    createdAt: Number(at),
    updatedAt: Number(at),
    endedAt: null,
    endReason: null,
  };
}

/**
 * 记录一次派发（返回新对象，不修改入参）。
 *
 * @param {object} ticket - 工单。
 * @param {object} input - 派发参数。
 * @param {string} input.id - Assignment id。
 * @param {string} input.channel - `specialist` / `team` / `one-shot` / `worker`。
 * @param {string} input.toolName - 实际调用的工具名。
 * @param {string} [input.ref] - 执行者引用（childId / teammate 名），可后补。
 * @param {number} input.at - 开始时间（ms）。
 * @returns {object} 新工单。
 */
export function recordAssignment(ticket, { id, channel, toolName, ref, at }) {
  const next = cloneTicket(ticket);
  next.assignments = [...next.assignments, {
    id: String(id),
    channel: String(channel),
    toolName: String(toolName),
    ref: ref === undefined || ref === null ? null : String(ref),
    startedAt: Number(at),
    endedAt: null,
  }];
  if (!isTerminal(next)) next.status = TICKET_STATUS.WORKING;
  next.updatedAt = Number(at);
  return next;
}

/**
 * 结算最后一次派发（只作为记录，不改变工单状态）。
 *
 * @param {object} ticket - 工单。
 * @param {number} at - 结算时间（ms）。
 * @param {string} [ref] - 补写的执行者引用。
 * @returns {object} 新工单。
 */
export function settleAssignment(ticket, at, ref) {
  const next = cloneTicket(ticket);
  const assignments = next.assignments;
  if (assignments.length === 0) return next;
  const last = assignments[assignments.length - 1];
  if (last.endedAt === null) last.endedAt = Number(at);
  if (ref !== undefined && ref !== null && last.ref === null) last.ref = String(ref);
  next.updatedAt = Number(at);
  return next;
}

/**
 * 应用一次结构化回报（返回新对象）。
 *
 * @param {object} ticket - 工单。
 * @param {object} report - 回报。
 * @param {string} report.status - 六态之一。
 * @param {string} [report.summary] - 摘要（≤2000 字符）。
 * @param {string} [report.question] - 需要人回答的问题。
 * @param {string} [report.assignmentId] - 对应的 Assignment id。
 * @param {number} report.at - 时间（ms）。
 * @returns {object} 新工单。
 */
export function applyReport(ticket, { status, summary = '', question = '', assignmentId, at }) {
  const reportStatus = typeof status === 'string' ? status.toLowerCase() : '';
  if (!Object.hasOwn(REPORT_TO_STATUS, reportStatus)) {
    throw new Error(`未知的回报状态：${String(status)}（允许：${Object.keys(REPORT_TO_STATUS).join(' / ')}）`);
  }
  const next = cloneTicket(ticket);
  const lastAssignment = next.assignments[next.assignments.length - 1];
  next.lastReport = {
    status: reportStatus,
    summary: String(summary).slice(0, 2000),
    question: String(question ?? '').slice(0, 2000),
    at: Number(at),
    ...(assignmentId === undefined || assignmentId === null ? {} : { assignmentId: String(assignmentId) }),
  };
  if (lastAssignment !== undefined && lastAssignment.endedAt === null) {
    lastAssignment.endedAt = Number(at);
    if (lastAssignment.ref === null && assignmentId !== undefined && assignmentId !== null) lastAssignment.ref = String(assignmentId);
  }
  if (!isTerminal(next)) {
    next.status = REPORT_TO_STATUS[reportStatus];
    if (next.status === TICKET_STATUS.CANCELLED) {
      next.endedAt = Number(at);
      next.endReason = 'dropped';
    }
  }
  next.updatedAt = Number(at);
  return next;
}

/**
 * 直接更新状态（指挥者手动结算/取消/标记受阻）。
 *
 * @param {object} ticket - 工单。
 * @param {string} status - 目标状态（必须在 `UPDATABLE_STATUSES` 里）。
 * @param {object} [options] - 选项。
 * @param {string} [options.reason] - 结束原因。
 * @param {string} [options.summary] - 最近摘要。
 * @param {number} options.at - 时间（ms）。
 * @returns {object} 新工单。
 */
export function applyStatus(ticket, status, { reason = '', summary = '', at } = {}) {
  const target = typeof status === 'string' ? status.toLowerCase() : '';
  if (!UPDATABLE_STATUSES.includes(target)) {
    throw new Error(`不能把工单更新为 ${String(status)}（允许：${UPDATABLE_STATUSES.join(' / ')}）`);
  }
  const next = cloneTicket(ticket);
  next.status = target;
  next.updatedAt = Number(at);
  if (TERMINAL_STATUSES.includes(target)) {
    next.endedAt = Number(at);
    next.endReason = String(reason ?? '') || (target === TICKET_STATUS.DONE ? 'done' : 'cancelled');
  } else {
    next.endedAt = null;
    next.endReason = null;
  }
  if (summary !== '') {
    next.lastReport = {
      status: target === TICKET_STATUS.DONE ? REPORT_STATUS.READY : next.lastReport?.status ?? REPORT_STATUS.PROGRESS,
      summary: String(summary).slice(0, 2000),
      question: '',
      at: Number(at),
      ...(next.lastReport?.assignmentId === undefined ? {} : { assignmentId: next.lastReport.assignmentId }),
    };
  }
  return next;
}

/**
 * 需要人处理的项（看板/工具输出用）。
 *
 * @param {object} ticket - 工单。
 * @param {number} now - 当前时间（ms）。
 * @param {number} stallMs - 停滞阈值（ms）。
 * @returns {{ code: string, detail: string } | undefined} 待人工项。
 */
export function attentionOf(ticket, now, stallMs) {
  if (ticket === null || typeof ticket !== 'object' || isTerminal(ticket)) return undefined;
  const summary = truncate(ticket.lastReport?.summary ?? '', 80);
  // 结构化问题优先于"受阻"归类：人真正要回答的就是这个问题。
  if (ticket.lastReport?.question !== undefined && ticket.lastReport.question !== '') {
    return { code: 'answer', detail: `${ticket.id} 等你回答：${truncate(ticket.lastReport.question, 80)}` };
  }
  if (ticket.status === TICKET_STATUS.BLOCKED) {
    return { code: 'blocked', detail: `${ticket.id} 报回受阻${summary === '' ? '' : `：${summary}`}` };
  }
  if (ticket.status === TICKET_STATUS.FAILED) {
    return { code: 'failed', detail: `${ticket.id} 报回失败${summary === '' ? '' : `：${summary}`}` };
  }
  if (ticket.status === TICKET_STATUS.REVIEW) {
    return { code: 'review', detail: `${ticket.id} 待验收${summary === '' ? '' : `：${summary}`}` };
  }
  if (isStalled(ticket, now, stallMs)) {
    return { code: 'stalled', detail: `${ticket.id} 已派发但超过 ${Math.round(stallMs / 60000)} 分钟没有新回报` };
  }
  return undefined;
}

/**
 * 解析执行者回报里的 `STATUS:` 行。
 *
 * 约定（写进协议与 specialist 工具描述）：
 *
 * ```
 * STATUS: ready
 * 摘要：...
 * ```
 *
 * 容忍 `- ` / `* ` 前缀、`**STATUS:**`、中英文冒号。找不到时返回 `undefined` —— 调用方
 * 应把结果当成"未结构化"，不要猜。
 *
 * @param {unknown} text - 执行者最终答复。
 * @returns {{ status: string, summary: string } | undefined} 解析结果。
 */
export function parseReportStatus(text) {
  if (typeof text !== 'string' || text === '') return undefined;
  const match = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(progress|waiting|ready|blocked|failed|dropped)\b/i.exec(text);
  if (match === null) return undefined;
  const status = match[1].toLowerCase();
  return { status, summary: text.trim().slice(0, 2000) };
}

// ---------------------------------------------------------------- 渲染 ---

/**
 * 渲染「指挥者·工单看板」。
 *
 * 原则（借 Super-agent 面板）：**安静默认** —— 没有工单、没有待人工项、计划已确认且无
 * 停滞时返回空串；有内容时只给结论与下一步动作，不复述任务描述。
 *
 * @param {object} input - 渲染输入。
 * @param {object[]} input.tickets - 本会话的工单（任意顺序）。
 * @param {object | null} [input.mandate] - 当前生效的计划授权。
 * @param {number} input.now - 当前时间（ms）。
 * @param {number} input.stallMs - 停滞阈值（ms）。
 * @param {number} [input.maxItems] - 最多列几项（默认 6）。
 * @returns {string} 看板文本；无内容时 `''`。
 */
export function renderTicketBoard({ tickets, mandate = null, now, stallMs, maxItems = 6 }) {
  const rows = Array.isArray(tickets) ? tickets.filter((ticket) => ticket !== null && typeof ticket === 'object') : [];
  const open = rows.filter(isOpen);
  const done = rows.length - open.length;
  const attention = open
    .map((ticket) => ({ ticket, attention: attentionOf(ticket, now, stallMs) }))
    .filter((row) => row.attention !== undefined);

  if (rows.length === 0 && mandate === null) return '';

  const parts = [];
  const mandateText = mandate === null
    ? '计划授权：**未确认**'
    : `计划授权：已确认（${truncate(mandate.planSummary ?? '', 60)}）`;
  parts.push(mandateText);

  if (open.length === 0) {
    parts.push(`工单：无进行中${done > 0 ? `（已结束 ${done} 项）` : ''}`);
  } else {
    const priority = { answer: 0, blocked: 1, failed: 2, review: 3, stalled: 4, working: 5, idle: 6, queued: 7, ended: 8 };
    const listed = open
      .map((ticket) => ({ ticket, stage: ticketStage(ticket) }))
      .sort((a, b) => (priority[a.stage] ?? 9) - (priority[b.stage] ?? 9) || String(a.ticket.id).localeCompare(String(b.ticket.id)))
      .slice(0, Math.max(1, maxItems));
    parts.push(`工单 ${open.length} 项进行中${done > 0 ? `（已结束 ${done} 项）` : ''}：${listed
      .map(({ ticket, stage }) => `${ticket.id}[${stage}] ${truncate(ticket.title, 30)}`)
      .join('、')}`);
  }

  const header = '【指挥者·工单看板】';
  const body = `${header}${parts.join('；')}。`;

  if (attention.length === 0) return body;

  const actions = attention.slice(0, 6).map(({ attention: item }) => {
    if (item.code === 'blocked' || item.code === 'failed') {
      return `⚠️ ${item.detail} → 先看它的产物与回报；需要用户决策就用 \`ask_user_question\`，能继续就补派或用 \`commander_ticket_update\` 结算/取消。`;
    }
    if (item.code === 'review') {
      return `⚠️ ${item.detail} → 只读核对该工单的产物与验收判据；通过就用 \`commander_ticket_update\` 标记 done，不通过就补派返工。`;
    }
    if (item.code === 'answer') {
      return `⚠️ ${item.detail} → 用 \`ask_user_question\` 把问题转给用户（一次一问），拿到答案后再推进或改派。`;
    }
    if (item.code === 'stalled') {
      return `⚠️ ${item.detail} → 先只读核对产物/任务板，再决定：问用户、补派、或标记 blocked；不要直接重派同一任务。`;
    }
    return `⚠️ ${item.detail}`;
  });
  return `${body}\n${actions.join('\n')}`;
}

/**
 * 工单的简短文本（工具输出用）。
 *
 * @param {object} ticket - 工单。
 * @returns {object} 精简视图。
 */
export function ticketView(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    stage: ticketStage(ticket),
    mandate_id: ticket.mandateId,
    last_report: ticket.lastReport === null ? null : {
      status: ticket.lastReport.status,
      summary: truncate(ticket.lastReport.summary, 200),
      question: ticket.lastReport.question === '' ? undefined : truncate(ticket.lastReport.question, 300),
      at: ticket.lastReport.at,
    },
    assignments: (ticket.assignments ?? []).map((assignment) => ({
      id: assignment.id,
      channel: assignment.channel,
      tool: assignment.toolName,
      ref: assignment.ref,
      started_at: assignment.startedAt,
      ended_at: assignment.endedAt,
    })),
    execution: ticket.execution === null || ticket.execution === undefined ? null : {
      session_id: ticket.execution.sessionId,
      directory: ticket.execution.directory,
      started_at: ticket.execution.startedAt,
      resumed_at: ticket.execution.resumedAt,
    },
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    ended_at: ticket.endedAt,
  };
}

/**
 * 把工单列表按"需要人 → 进行中 → 已结束"排序后转成视图。
 *
 * @param {object[]} tickets - 工单。
 * @returns {object[]} 视图数组。
 */
export function ticketViews(tickets) {
  const rows = Array.isArray(tickets) ? tickets.filter((ticket) => ticket !== null && typeof ticket === 'object') : [];
  return rows.map(ticketView);
}

// ---------------------------------------------------------------- 内部 ---

/** 深拷贝工单（嵌套字段手工复制，避免 JSON 往返丢 undefined 语义）。 */
function cloneTicket(ticket) {
  return {
    ...ticket,
    acceptance: Array.isArray(ticket.acceptance) ? [...ticket.acceptance] : [],
    scope: Array.isArray(ticket.scope) ? [...ticket.scope] : [],
    assignments: (ticket.assignments ?? []).map((assignment) => ({ ...assignment })),
    lastReport: ticket.lastReport === null || ticket.lastReport === undefined ? null : { ...ticket.lastReport },
    execution: ticket.execution === null || ticket.execution === undefined ? null : { ...ticket.execution },
  };
}

/** 截断文本并加省略号。 */
function truncate(text, max) {
  const value = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
