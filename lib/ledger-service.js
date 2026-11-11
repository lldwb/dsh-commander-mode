/**
 * `commanderLedger` 服务 —— 工单账本的唯一写者（0.6.0）。
 *
 * ## 谁在用
 *
 * - **模式行**（`agent.js`）：每轮看板读它；`tools/pre-execute` 用它做计划授权与工单归属校验；
 *   `tools/post-execute` 用它记账（计划确认、派发、回报）。
 * - **工单工具**（`lib/ticket-tools.js`）：`commander_ticket_create/update/list`。
 *
 * ## 作用域
 *
 * 一个 profile 一个账本文件，但**每个会话只看自己的工单**（`ticket.sessionId`）。这样
 * 同一部署里开多个指挥者会话不会互相串账。授权（Mandate）也按会话记录。
 *
 * ## 失败策略
 *
 * - **读/写失败不弄挂模式**：载入失败用空账本 + warning；写失败保留内存、记 warning，
 *   下一次操作重试。看板读不到账本时静默（降级回 0.5 行为）。
 * - **非法写入抛可执行错误**：工具层会把消息原样交给模型，所以消息必须说明"下一步做什么"。
 *
 * @module dsh-commander-mode/lib/ledger-service
 */

import {
  emptyLedger,
  loadLedgerFile,
  saveLedgerFile,
} from './ledger.js';
import {
  applyReport,
  applyStatus,
  attentionOf,
  createTicketRecord,
  isOpen,
  isTerminal,
  recordAssignment,
  settleAssignment,
  ticketView,
  ticketViews,
} from './tickets.js';

/** 服务名。 */
export const LEDGER_SERVICE_NAME = 'commanderLedger';

/** 默认最多保留多少工单（超出后裁剪最老的已结束工单）。 */
export const DEFAULT_MAX_TICKETS = 100;

/**
 * 工单账本服务。
 */
export class CommanderLedger {
  /**
   * @param {object} options - 构造参数。
   * @param {string} options.file - 账本文件路径。
   * @param {object} [options.logger] - Cordis logger。
   * @param {() => number} [options.now] - 时钟（测试可注入）。
   * @param {number} [options.maxTickets] - 保留上限。
   * @param {(file: string) => { state: object, warning?: string }} [options.load] - 载入函数（测试注入）。
   * @param {(file: string, state: object) => void} [options.save] - 保存函数（测试注入）。
   */
  constructor({ file, logger, now = () => Date.now(), maxTickets = DEFAULT_MAX_TICKETS, load, save } = {}) {
    /** @type {string} */
    this.file = String(file ?? '');
    this.logger = logger;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.maxTickets = Number.isSafeInteger(maxTickets) && maxTickets >= 1 ? maxTickets : DEFAULT_MAX_TICKETS;
    this._load = typeof load === 'function' ? load : (target) => loadLedgerFile({ file: target, logger: this.logger, now: this.now() });
    this._save = typeof save === 'function' ? save : (target, state) => saveLedgerFile({ file: target, state, logger: this.logger });
    /** @type {object} */
    this.state = emptyLedger();
    /** @type {string[]} */
    this.warnings = [];
    /** @type {string | undefined} */
    this.lastPersistError = undefined;
    /** 上次载入是否成功（诊断用）。 */
    this.loaded = false;
  }

  /**
   * 载入账本（配置行启动时调用一次）。
   *
   * @returns {{ loaded: boolean, warnings: string[] }} 载入结果。
   */
  load() {
    try {
      const result = this._load(this.file);
      this.state = result?.state ?? emptyLedger();
      this.warnings = [];
      if (typeof result?.warning === 'string' && result.warning !== '') this.warnings.push(result.warning);
      this.loaded = true;
      return { loaded: true, warnings: [...this.warnings] };
    } catch (error) {
      this.state = emptyLedger();
      this.warnings = [`账本载入失败，已用空账本启动：${errorMessage(error)}`];
      this.loaded = false;
      this.logger?.warn?.('commander-mode: 工单账本载入失败：%o', error);
      return { loaded: false, warnings: [...this.warnings] };
    }
  }

  /** 当前文件路径（诊断）。 */
  get filePath() {
    return this.file;
  }

  // ------------------------------------------------------------ 授权 ---

  /**
   * 某会话当前生效的计划授权（最近一条 active）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object | null} 授权记录或 null。
   */
  activeMandate(sessionId) {
    const id = String(sessionId ?? '');
    if (id === '') return null;
    for (let index = this.state.mandates.length - 1; index >= 0; index -= 1) {
      const mandate = this.state.mandates[index];
      if (mandate.sessionId === id && mandate.status === 'active') return { ...mandate };
    }
    return null;
  }

  /**
   * 记录一次计划确认（新授权取代旧授权）。
   *
   * @param {object} input - 参数。
   * @param {string} input.sessionId - 会话 id。
   * @param {string} input.planHash - 计划哈希。
   * @param {string} input.planSummary - 计划摘要（给看板/审计）。
   * @returns {object} 新授权。
   */
  recordMandate({ sessionId, planHash, planSummary = '' }) {
    const session = requireSessionId(sessionId);
    const at = this.now();
    for (const mandate of this.state.mandates) {
      if (mandate.sessionId === session && mandate.status === 'active') mandate.status = 'superseded';
    }
    const mandate = {
      id: `m-${this.state.nextMandate}`,
      sessionId: session,
      planHash: String(planHash),
      planSummary: String(planSummary).slice(0, 4000),
      confirmedAt: at,
      status: 'active',
    };
    this.state.nextMandate += 1;
    this.state.mandates.push(mandate);
    this.persist();
    return { ...mandate };
  }

  /**
   * 撤销当前授权（用户明确叫停计划时）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {string} [reason] - 原因。
   * @returns {object | null} 被撤销的授权。
   */
  revokeMandate(sessionId, reason = '') {
    const session = requireSessionId(sessionId);
    const at = this.now();
    for (let index = this.state.mandates.length - 1; index >= 0; index -= 1) {
      const mandate = this.state.mandates[index];
      if (mandate.sessionId !== session || mandate.status !== 'active') continue;
      mandate.status = 'revoked';
      mandate.revokedAt = at;
      mandate.planSummary = mandate.planSummary;
      if (reason !== '') mandate.planSummary = `${mandate.planSummary}（撤销：${String(reason).slice(0, 200)}）`;
      this.persist();
      return { ...mandate };
    }
    return null;
  }

  // ------------------------------------------------------------ 工单 ---

  /**
   * 创建工单（自动继承当前会话的 active 授权）。
   *
   * @param {object} input - 参数。
   * @param {string} input.sessionId - 会话 id。
   * @param {string} input.title - 标题。
   * @param {string} [input.intent] - 目标/背景。
   * @param {string[]} [input.acceptance] - 验收判据。
   * @param {string[]} [input.scope] - 写作用域。
   * @returns {object} 工单视图。
   */
  createTicket({ sessionId, title, intent = '', acceptance = [], scope = [] }) {
    const session = requireSessionId(sessionId);
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (cleanTitle === '') throw new Error('工单标题不能为空：用一句话写清这件活要交付什么。');
    if (cleanTitle.length > 200) throw new Error('工单标题过长（≤200 字符）：把细节写进 intent 或 acceptance。');
    const mandate = this.activeMandate(session);
    const ticket = createTicketRecord({
      id: `t-${this.state.nextTicket}`,
      sessionId: session,
      title: cleanTitle,
      intent,
      acceptance,
      scope,
      mandateId: mandate === null ? null : mandate.id,
      at: this.now(),
    });
    this.state.nextTicket += 1;
    this.state.tickets.push(ticket);
    this.prune();
    this.persist();
    return ticketView(ticket);
  }

  /**
   * 绑定工单与共享任务板上的投影任务（1.2.0）。
   *
   * 投影器是尽力而为的：这里只负责把映射关系持久化，失败由调用方决定是否忽略。
   * 幂等：同一个 task id 重复绑定不会产生写入。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id（校验归属）。
   * @param {string} taskId - 任务 id（`task-N`）。
   * @returns {object} 工单视图。
   */
  attachTeamTask(ticketId, sessionId, taskId) {
    const ticket = this.getTicket(ticketId, sessionId);
    const clean = String(taskId ?? '').trim();
    if (!/^task-\d+$/u.test(clean)) {
      throw new Error(`attachTeamTask 需要任务 id（task-N），收到：${clean === '' ? '(空)' : clean}`);
    }
    if (ticket.teamTaskId === clean) return ticketView(ticket);
    const next = { ...ticket, teamTaskId: clean, updatedAt: this.now() };
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 取工单（可按会话校验归属）。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} [sessionId] - 期望归属会话；不匹配时抛错。
   * @param {object} [options] - 选项。
   * @param {boolean} [options.allowMissing] - 不存在时返回 null 而不是抛错。
   * @returns {object | null} 工单（内部记录副本）。
   */
  getTicket(ticketId, sessionId, { allowMissing = false } = {}) {
    const id = String(ticketId ?? '').trim();
    const ticket = this.state.tickets.find((item) => item.id === id) ?? null;
    if (ticket === null) {
      if (allowMissing) return null;
      throw new Error(`找不到工单 ${id === '' ? '(空)' : id}：先用 commander_ticket_create 建工单，或 commander_tickets 查看现有工单。`);
    }
    if (sessionId !== undefined && String(ticket.sessionId) !== String(sessionId)) {
      if (allowMissing) return null;
      throw new Error(`工单 ${id} 不属于当前会话，不能在这里操作。先用 commander_tickets 看当前会话的工单。`);
    }
    return ticket;
  }

  /**
   * 记录一次派发。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id（校验归属）。
   * @param {object} input - 派发参数。
   * @param {string} input.channel - 通道。
   * @param {string} input.toolName - 工具名。
   * @param {string} [input.ref] - 执行者引用。
   * @returns {object} 工单视图。
   */
  recordAssignment(ticketId, sessionId, { channel, toolName, ref }) {
    const ticket = this.getTicket(ticketId, sessionId);
    if (isTerminal(ticket)) throw new Error(`工单 ${ticket.id} 已结束，不能再派发。需要继续就新建工单（并在计划里说明）。`);
    const next = recordAssignment(ticket, {
      id: `a-${this.state.nextAssignment}`,
      channel,
      toolName,
      ref,
      at: this.now(),
    });
    this.state.nextAssignment += 1;
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 结算最后一次派发（补写执行者引用）。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id。
   * @param {string} [ref] - 执行者引用。
   * @returns {object} 工单视图。
   */
  markAssignmentSettled(ticketId, sessionId, ref) {
    const ticket = this.getTicket(ticketId, sessionId);
    const next = settleAssignment(ticket, this.now(), ref);
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 记录一次结构化回报。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id。
   * @param {object} report - 回报（status/summary/question/assignmentId）。
   * @returns {object} 工单视图。
   */
  recordReport(ticketId, sessionId, report) {
    const ticket = this.getTicket(ticketId, sessionId);
    if (isTerminal(ticket)) return ticketView(ticket);
    const next = applyReport(ticket, { ...report, at: this.now() });
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 手动更新工单状态。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id。
   * @param {string} status - 目标状态。
   * @param {object} [options] - 选项。
   * @param {string} [options.reason] - 结束原因。
   * @param {string} [options.summary] - 摘要。
   * @returns {object} 工单视图。
   */
  setStatus(ticketId, sessionId, status, { reason = '', summary = '' } = {}) {
    const ticket = this.getTicket(ticketId, sessionId);
    const next = applyStatus(ticket, status, { reason, summary, at: this.now() });
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 更新工单的描述字段（标题/验收/范围）。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 会话 id。
   * @param {object} patch - 字段。
   * @returns {object} 工单视图。
   */
  updateTicket(ticketId, sessionId, patch = {}) {
    const ticket = this.getTicket(ticketId, sessionId);
    if (isTerminal(ticket)) throw new Error(`工单 ${ticket.id} 已结束，不能修改。`);
    const next = { ...ticket };
    if (typeof patch.title === 'string' && patch.title.trim() !== '') next.title = patch.title.trim().slice(0, 200);
    if (typeof patch.intent === 'string') next.intent = patch.intent.slice(0, 4000);
    if (Array.isArray(patch.acceptance)) next.acceptance = patch.acceptance.filter((item) => typeof item === 'string').slice(0, 40);
    if (Array.isArray(patch.scope)) next.scope = patch.scope.filter((item) => typeof item === 'string').slice(0, 40);
    next.updatedAt = this.now();
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  // ------------------------------------------------------------ Worker Session（0.8.0） ---

  /**
   * 记录/更新工单的 Worker Session 执行信息。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 指挥者会话 id（归属校验）。
   * @param {object} execution - `{ sessionId, directory, permission }`。
   * @returns {object} 工单视图。
   */
  setExecution(ticketId, sessionId, execution) {
    const ticket = this.getTicket(ticketId, sessionId);
    const workerSessionId = typeof execution?.sessionId === 'string' ? execution.sessionId : '';
    if (workerSessionId === '') throw new Error('setExecution 需要 execution.sessionId');
    const next = {
      ...ticket,
      execution: {
        sessionId: workerSessionId,
        directory: typeof execution?.directory === 'string' ? execution.directory : '',
        permission: typeof execution?.permission === 'string' ? execution.permission : '',
        startedAt: this.now(),
        resumedAt: null,
      },
      updatedAt: this.now(),
    };
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 标记一次恢复（重启后指挥者回到该工单时）。
   *
   * @param {string} ticketId - 工单 id。
   * @param {string} sessionId - 指挥者会话 id。
   * @returns {object | null} 工单视图；没有执行信息时 null。
   */
  markExecutionResumed(ticketId, sessionId) {
    const ticket = this.getTicket(ticketId, sessionId, { allowMissing: true });
    if (ticket === null || ticket.execution === null) return null;
    const next = { ...ticket, execution: { ...ticket.execution, resumedAt: this.now() }, updatedAt: this.now() };
    this.replace(next);
    this.persist();
    return ticketView(next);
  }

  /**
   * 按 Worker Session id 反查工单（worker 侧装饰/report 用）。
   *
   * @param {string} workerSessionId - worker 会话 id。
   * @returns {object | null} 工单记录副本。
   */
  findByWorkerSession(workerSessionId) {
    const id = String(workerSessionId ?? '');
    if (id === '') return null;
    const ticket = this.state.tickets.find((item) => item.execution?.sessionId === id) ?? null;
    if (ticket === null) return null;
    return {
      ...ticket,
      assignments: ticket.assignments.map((assignment) => ({ ...assignment })),
      lastReport: ticket.lastReport === null ? null : { ...ticket.lastReport },
      execution: { ...ticket.execution },
    };
  }

  /**
   * 某指挥者会话下所有带 Worker Session 的未结束工单（恢复/槽位用）。
   *
   * @param {string} sessionId - 指挥者会话 id。
   * @returns {object[]} 工单记录副本。
   */
  executionTickets(sessionId) {
    return this.listTickets(sessionId).filter((ticket) => ticket.execution !== null);
  }

  /**
   * **所有会话**里「带 Worker Session 且未结束」的工单（3.3.0 停滞看门狗用）。
   *
   * 为什么需要跨会话：看门狗是插件级的定时器，它不知道当前有哪些指挥者会话；
   * 而工单自己记录了 `sessionId`，所以一次扫描就能覆盖所有在跑的 worker。
   *
   * @returns {object[]} 工单记录副本（含 execution）。
   */
  activeExecutions() {
    return this.state.tickets
      .filter((ticket) => !isTerminal(ticket) && ticket.execution !== null && ticket.execution !== undefined)
      .map((ticket) => ({
        ...ticket,
        assignments: ticket.assignments.map((assignment) => ({ ...assignment })),
        lastReport: ticket.lastReport === null ? null : { ...ticket.lastReport },
        execution: { ...ticket.execution },
      }));
  }

  // ------------------------------------------------------------ 查询 ---

  /**
   * 按工单 id 查它所属的指挥者会话（外部事件路由用，1.1.0）。
   *
   * 与 `getTicket` 的区别：这里**不需要**先知道会话 id —— 外部事件只知道 ticket，
   * 必须反查会话才能 `steer`。找不到返回 null（事件留在 inbox 等下次重试）。
   *
   * @param {string} ticketId - 工单 id。
   * @returns {string | null} 会话 id。
   */
  sessionOfTicket(ticketId) {
    const id = String(ticketId ?? '').trim();
    if (id === '') return null;
    const ticket = this.state.tickets.find((item) => item.id === id) ?? null;
    if (ticket === null) return null;
    const sessionId = String(ticket.sessionId ?? '');
    return sessionId === '' ? null : sessionId;
  }

  /**
   * 某会话的工单列表（默认只含未结束）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {object} [options] - 选项。
   * @param {boolean} [options.includeEnded] - 是否包含已结束。
   * @returns {object[]} 工单记录（内部副本）。
   */
  listTickets(sessionId, { includeEnded = false } = {}) {
    const session = String(sessionId ?? '');
    if (session === '') return [];
    return this.state.tickets
      .filter((ticket) => ticket.sessionId === session && (includeEnded || !isTerminal(ticket)))
      .map((ticket) => ({ ...ticket, assignments: ticket.assignments.map((assignment) => ({ ...assignment })), lastReport: ticket.lastReport === null ? null : { ...ticket.lastReport } }));
  }

  /**
   * 待人工项（看板/工具输出用）。
   *
   * @param {string} sessionId - 会话 id。
   * @param {number} stallMs - 停滞阈值（ms）。
   * @returns {object[]} `{ id, code, detail }[]`。
   */
  attention(sessionId, stallMs) {
    const now = this.now();
    return this.listTickets(sessionId)
      .map((ticket) => ({ id: ticket.id, ...(attentionOf(ticket, now, stallMs) ?? {}) }))
      .filter((item) => typeof item.code === 'string');
  }

  /**
   * 会话摘要（工具输出/诊断）。
   *
   * @param {string} sessionId - 会话 id。
   * @returns {object} 摘要。
   */
  summary(sessionId) {
    const tickets = this.listTickets(sessionId);
    const counts = {};
    for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    const mandate = this.activeMandate(sessionId);
    return {
      session_id: String(sessionId ?? ''),
      open: tickets.length,
      counts,
      mandate: mandate === null ? null : {
        id: mandate.id,
        confirmed_at: mandate.confirmedAt,
        plan_hash: mandate.planHash,
        plan_summary: mandate.planSummary.slice(0, 500),
      },
      tickets: ticketViews(tickets),
      state_file: this.file,
      loaded: this.loaded,
      warnings: [...this.warnings],
    };
  }

  /** 诊断（不抛错）。 */
  diagnostics() {
    return {
      file: this.file,
      loaded: this.loaded,
      warnings: [...this.warnings],
      last_persist_error: this.lastPersistError,
      tickets: this.state.tickets.length,
      mandates: this.state.mandates.length,
    };
  }

  // ------------------------------------------------------------ 内部 ---

  /** 用新记录替换旧记录。 */
  replace(next) {
    const index = this.state.tickets.findIndex((ticket) => ticket.id === next.id);
    if (index >= 0) this.state.tickets[index] = next;
    else this.state.tickets.push(next);
  }

  /** 裁剪：保留全部未结束工单，已结束按时间倒序保留到上限。 */
  prune() {
    if (this.state.tickets.length <= this.maxTickets) return;
    const ended = this.state.tickets
      .filter((ticket) => isTerminal(ticket))
      .sort((a, b) => (b.endedAt ?? b.updatedAt ?? 0) - (a.endedAt ?? a.updatedAt ?? 0));
    const keepEnded = new Set(ended.slice(0, Math.max(0, this.maxTickets - this.state.tickets.filter((ticket) => !isTerminal(ticket)).length)).map((ticket) => ticket.id));
    this.state.tickets = this.state.tickets.filter((ticket) => !isTerminal(ticket) || keepEnded.has(ticket.id));
  }

  /** 保存；失败降级为 warning（内存仍是最新）。 */
  persist() {
    try {
      this._save(this.file, this.state);
      this.lastPersistError = undefined;
    } catch (error) {
      this.lastPersistError = errorMessage(error);
      this.logger?.warn?.('commander-mode: 工单账本保存失败，本回合在内存中继续：%s', this.lastPersistError);
    }
  }
}

/** 校验会话 id。 */
function requireSessionId(sessionId) {
  const value = String(sessionId ?? '').trim();
  if (value === '') throw new Error('无法定位当前会话：工单必须属于一个指挥者会话（agent.session.id 为空）。');
  return value;
}

/** 统一错误文案。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
