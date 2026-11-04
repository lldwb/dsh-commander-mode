/**
 * Worker Session 执行器（0.8.0，opt-in）——每张工单一个独立 DSH Session + 独立目录。
 *
 * ## 为什么需要
 *
 * specialist / teammate 都与指挥者**共享 cwd**，`writeScopes` 只是提示；长任务并行时会互相
 * 踩文件。0.6/0.7 把派活变成有状态的工单与异步通知，但"执行环境"仍没分离。这一层借鉴
 * Super-agent 的 Executor：**一个工单一个 Session、一个目录、一个槽位**，执行者结束时用
 * `commander_report` 汇报（或至少输出 `STATUS:`），由服务写账本并唤醒指挥者。
 *
 * ## 为什么复用 `standard` preset 而不是新 preset
 *
 * 新建 preset 必须完整重述能力行（本仓库的硬约束），还要在模式菜单里隐藏它。这里改为：
 * 用默认 `standard` 建 Session，再在 `agent/created` 时用 `tools.restrict` 收紧到工作工具、
 * 注入执行者人设 section、注册 `commander_report`、给"工单已结束"加 guard。效果相同，
 * 但少一份要维护的 preset 组合。
 *
 * ## 安全边界
 *
 * 目录与工具收敛**不是安全边界**：worker 仍以操作员身份执行。`workerPermission` 默认
 * `danger-full-access`，与能力的实际需要一致；配置可改。prepare 命令来自用户配置，按
 * 用户自己的 shell 执行。
 *
 * @module dsh-commander-mode/lib/worker-sessions
 */

import { exec as execCallback } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { isTerminal, parseReportStatus, ticketView } from './tickets.js';

const execAsync = promisify(execCallback);

/** 服务名。 */
export const WORKERS_SERVICE_NAME = 'commanderWorkers';

/** Worker Session 的 session id 前缀。 */
export const WORKER_SESSION_PREFIX = 'worker-';

/** Worker 被允许使用的工具（存在才保留；`commander_report` 由本服务注册）。 */
export const WORKER_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'pwsh', 'bash', 'job_output', 'job_list', 'job_kill',
  'web_search', 'web_fetch', 'skill', 'todo_write',
  'commander_report',
]);

/** prepare 命令的默认超时。 */
export const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

/** idle 未汇报的提醒节流。 */
const IDLE_NOTICE_THROTTLE_MS = 10 * 60 * 1000;

/**
 * 解析 worker 工作目录根。
 *
 * @param {object} input - 参数。
 * @param {string} [input.workRoot] - 配置值（空 = 默认）。
 * @param {NodeJS.ProcessEnv} [input.env] - 环境变量。
 * @param {string} [input.home] - 用户目录。
 * @returns {string} 绝对路径。
 */
export function resolveWorkRoot({ workRoot, env = process.env, home = homedir() } = {}) {
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh');
  const base = typeof workRoot === 'string' ? workRoot.trim() : '';
  if (base === '') return join(dshHome, 'commander', 'work');
  return isAbsolute(base) ? base : join(dshHome, base);
}

/**
 * Worker Session 执行器。
 */
export class CommanderWorkers {
  /**
   * @param {object} options - 构造参数。
   * @param {object} options.ctx - 配置行 Cordis 上下文。
   * @param {object} options.ledger - `commanderLedger` 服务。
   * @param {() => object} options.getOptions - 读当前配置（workerSessions/workRoot/...）。
   * @param {object} [options.logger] - logger。
   * @param {() => number} [options.now] - 时钟。
   * @param {NodeJS.ProcessEnv} [options.env] - 环境变量。
   * @param {object} [options.deps] - 测试注入（sessionController/workspaceRegistry/...）。
   */
  constructor({ ctx, ledger, getOptions, logger, now = () => Date.now(), env = process.env, deps = {} }) {
    this.ctx = ctx;
    this.ledger = ledger;
    this.getOptions = getOptions;
    this.logger = logger;
    this.now = now;
    this.env = env;
    this.deps = deps;
    /** agent → disposers（装饰释放）。 */
    this.bindings = new Map();
    /** 每个安装周期只恢复一次（ticketId）。 */
    this.resumed = new Set();
    /** idle 提醒节流（ticketId → at）。 */
    this.idleNoticed = new Map();
    this.disposed = false;
  }

  /** 读配置。 */
  options() {
    try {
      return this.getOptions() ?? {};
    } catch {
      return {};
    }
  }

  /** 是否启用（opt-in）。 */
  enabled() {
    return this.options().workerSessions === true;
  }

  /** sessionController（可能缺失）。 */
  sessions() {
    return this.deps.sessionController ?? (typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined);
  }

  /** workspaceRegistry（可能缺失）。 */
  workspaces() {
    return this.deps.workspaceRegistry ?? (typeof this.ctx.get === 'function' ? this.ctx.get('workspaceRegistry') : undefined);
  }

  /** agents 服务。 */
  agents() {
    return this.deps.agents ?? (typeof this.ctx.get === 'function' ? this.ctx.get('agents') : undefined);
  }

  /** 权限预设服务。 */
  permissions() {
    return this.deps.permissionPresets ?? (typeof this.ctx.get === 'function' ? this.ctx.get('permissionPresets') : undefined);
  }

  /**
   * 注册事件监听（配置行启动时调用一次）。
   *
   * @returns {() => void} 释放函数。
   */
  install() {
    const offs = [];
    const on = (event, listener) => {
      try {
        const off = this.ctx.on(event, listener);
        if (typeof off === 'function') offs.push(off);
      } catch (error) {
        this.logger?.debug?.('commander-mode: 订阅 %s 失败：%o', event, error);
      }
    };
    on('agent/created', ({ agent }) => {
      void this.handleCreated(agent);
    });
    on('agent/status', (payload) => {
      this.handleStatus(payload);
    });
    on('agent/disposed', ({ agent }) => {
      this.release(agent);
    });
    return () => {
      this.disposed = true;
      for (const off of offs.splice(0).reverse()) {
        try {
          off();
        } catch {
          // 释放失败不影响退出。
        }
      }
      for (const agent of [...this.bindings.keys()]) this.release(agent);
    };
  }

  /** agent 创建：worker 装饰 / 指挥者恢复。 */
  async handleCreated(agent) {
    try {
      if (this.disposed || agent === undefined || agent === null) return;
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined) return;
      if (sessionId.startsWith(WORKER_SESSION_PREFIX)) {
        this.decorate(agent);
        return;
      }
      await this.resumeForCommander(agent);
    } catch (error) {
      this.logger?.warn?.('commander-mode: 处理 agent/created 失败：%o', error);
    }
  }

  /** worker 空闲但没汇报 → 提醒指挥者（节流）。 */
  handleStatus({ agent, status } = {}) {
    try {
      if (this.disposed || status !== 'idle') return;
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined || !sessionId.startsWith(WORKER_SESSION_PREFIX)) return;
      const ticket = this.ledger.findByWorkerSession(sessionId);
      if (ticket === null || isTerminal(ticket)) return;
      const startedAt = ticket.execution?.startedAt ?? 0;
      const reportedAt = ticket.lastReport?.at ?? 0;
      if (reportedAt >= startedAt) return;
      const last = this.idleNoticed.get(ticket.id) ?? 0;
      if (this.now() - last < IDLE_NOTICE_THROTTLE_MS) return;
      this.idleNoticed.set(ticket.id, this.now());
      void this.notifyParent(ticket, [
        `【指挥者·执行者静默】工单 ${ticket.id} 的 Worker Session 空转了，但没有调用 commander_report / 输出 STATUS。`,
        '先只读核对它的目录与产物，再决定：send 追问、标记 blocked，或补派。不要直接重派同一任务。',
      ].join('\n'), '执行者静默未汇报');
    } catch (error) {
      this.logger?.debug?.('commander-mode: idle 兜底失败：%o', error);
    }
  }

  /**
   * 为一张工单创建 Worker Session（spawn）。
   *
   * @param {object} input - 参数。
   * @param {object} input.parentAgent - 指挥者 agent。
   * @param {string} input.ticketId - 工单 id。
   * @param {string} input.task - 任务说明（自包含）。
   * @param {string} [input.title] - 会话标题。
   * @returns {Promise<object>} `{ ticket, sessionId, directory }`。
   */
  async spawn({ parentAgent, ticketId, task, title }) {
    if (!this.enabled()) throw new Error('Worker Session 未启用（配置 workerSessions: true 后才可用）。');
    const parentSessionId = sessionIdOf(parentAgent);
    if (parentSessionId === undefined) throw new Error('无法定位指挥者会话（agent.session.id 为空）。');
    const ticket = this.ledger.getTicket(ticketId, parentSessionId);
    if (isTerminal(ticket)) throw new Error(`工单 ${ticket.id} 已结束，不能再创建 Worker Session。`);
    if (ticket.execution !== null) throw new Error(`工单 ${ticket.id} 已有 Worker Session（${ticket.execution.sessionId}）；要追加指令用 commander_worker_send。`);
    const sessions = this.sessions();
    const workspaces = this.workspaces();
    if (sessions === undefined || workspaces === undefined) {
      throw new Error('这个部署缺少 sessionController / workspaceRegistry，Worker Session 不可用；改用 specialist 或 Team。');
    }
    const max = positive(this.options().maxWorkers, 3);
    const active = this.ledger.executionTickets(parentSessionId).filter((item) => !isTerminal(item)).length;
    if (active >= max) {
      throw new Error(`Worker Session 已达上限（${max} 个）。先等现有 worker 汇报/停止，或把任务改用 Team 通道。`);
    }

    const options = this.options();
    const workRoot = resolveWorkRoot({ workRoot: options.workRoot, env: this.env });
    const directory = join(workRoot, ticketId);
    const sessionId = `${WORKER_SESSION_PREFIX}${ticketId}`;
    await this.prepareDirectory({ directory, ticket, options });
    const workspace = await workspaces.create(directory);
    await sessions.create({ sessionId, workspaceId: workspace.id });
    const resolved = await sessions.resolveAgent(sessionId);
    if (resolved === undefined || resolved === null || resolved.error !== undefined || resolved.agent === undefined) {
      throw new Error(`Worker Session ${sessionId} 创建后无法解析：${JSON.stringify(resolved?.error ?? {})}`);
    }
    const agent = resolved.agent;
    try {
      this.permissions()?.set(agent.session, options.workerPermission === undefined ? 'danger-full-access' : options.workerPermission);
    } catch (error) {
      this.logger?.warn?.('commander-mode: 设置 Worker 权限失败（继续）：%o', error);
    }
    try {
      await sessions.rename({ sessionId, title: `执行 ${ticket.id}：${truncate(ticket.title, 40)}` });
    } catch (error) {
      this.logger?.debug?.('commander-mode: 重命名 Worker Session 失败：%o', error);
    }
    this.ledger.setExecution(ticket.id, parentSessionId, {
      sessionId,
      directory,
      permission: options.workerPermission ?? 'danger-full-access',
    });
    await this.deliver(agent, assignmentText({ ticket, task, directory, title }), 'assignment');
    this.logger?.info?.('commander-mode: 已为工单 %s 创建 Worker Session %s（%s）', ticket.id, sessionId, directory);
    return { ticket: ticketView(this.ledger.getTicket(ticket.id, parentSessionId)), sessionId, directory };
  }

  /** 准备目录（mkdir + 可选 prepare 命令）。 */
  async prepareDirectory({ directory, ticket, options }) {
    const mkdirImpl = this.deps.mkdir ?? mkdir;
    await mkdirImpl(directory, { recursive: true });
    const command = typeof options.prepareCommand === 'string' ? options.prepareCommand.trim() : '';
    if (command === '') return;
    const run = this.deps.execCommand ?? execAsync;
    const env = {
      ...this.env,
      DSH_COMMANDER_TICKET: ticket.id,
      DSH_COMMANDER_DIR: directory,
      DSH_COMMANDER_TITLE: ticket.title,
    };
    try {
      await run(command, { cwd: dirname(directory), env, timeout: PREPARE_TIMEOUT_MS, windowsHide: true });
    } catch (error) {
      const output = typeof error?.stderr === 'string' && error.stderr !== '' ? error.stderr.slice(0, 2000) : String(error?.message ?? error);
      throw new Error(`prepareCommand 失败（目录 ${directory}）：${output}。修正命令后重试；不要反复重试同一条。`);
    }
  }

  /** 给已有 Worker Session 追加指令。 */
  async send({ parentAgent, ticketId, text }) {
    if (!this.enabled()) throw new Error('Worker Session 未启用。');
    const parentSessionId = sessionIdOf(parentAgent);
    const ticket = this.ledger.getTicket(ticketId, parentSessionId);
    if (isTerminal(ticket)) throw new Error(`工单 ${ticket.id} 已结束，不能追加指令。`);
    if (ticket.execution === null) throw new Error(`工单 ${ticket.id} 还没有 Worker Session；先 commander_worker_spawn。`);
    const agent = await this.resolveWorker(ticket.execution.sessionId);
    if (agent === null) throw new Error(`Worker Session ${ticket.execution.sessionId} 当前不可用（可能已关闭）；用 commander_worker_status 查看。`);
    await this.deliver(agent, `【指挥者·追加指令】工单 ${ticket.id}\n\n${String(text)}`, 'followup');
    return { ticket_id: ticket.id, session_id: ticket.execution.sessionId };
  }

  /** 查询 Worker Session 状态。 */
  async status({ parentAgent, ticketId }) {
    if (!this.enabled()) throw new Error('Worker Session 未启用。');
    const parentSessionId = sessionIdOf(parentAgent);
    const ticket = this.ledger.getTicket(ticketId, parentSessionId);
    if (ticket.execution === null) return { ticket: ticketView(ticket), worker: null };
    let agent = null;
    try {
      agent = await this.resolveWorker(ticket.execution.sessionId);
    } catch {
      agent = null;
    }
    return {
      ticket: ticketView(ticket),
      worker: {
        session_id: ticket.execution.sessionId,
        directory: ticket.execution.directory,
        available: agent !== null,
        status: agent === null ? 'unavailable' : (typeof agent.status === 'string' ? agent.status : 'unknown'),
      },
    };
  }

  /** 停止 Worker 当前回合。 */
  async stop({ parentAgent, ticketId, reason = '由指挥者停止' }) {
    if (!this.enabled()) throw new Error('Worker Session 未启用。');
    const parentSessionId = sessionIdOf(parentAgent);
    const ticket = this.ledger.getTicket(ticketId, parentSessionId);
    if (ticket.execution === null) throw new Error(`工单 ${ticket.id} 还没有 Worker Session。`);
    const agent = await this.resolveWorker(ticket.execution.sessionId);
    if (agent === null) throw new Error(`Worker Session ${ticket.execution.sessionId} 当前不可用。`);
    try {
      agent.cancel(reason);
    } catch (error) {
      throw new Error(`停止 Worker Session 失败：${error instanceof Error ? error.message : String(error)}。`);
    }
    this.ledger.recordReport(ticket.id, parentSessionId, {
      status: 'blocked',
      summary: `指挥者停止了 Worker 当前回合：${reason}`,
      question: '这个任务接下来怎么办：追问、重派，还是先核对产物？',
    });
    return { ticket_id: ticket.id, session_id: ticket.execution.sessionId };
  }

  /** 暂停/恢复（restart 后为 open 工单的 worker 发恢复提示）。 */
  async resumeForCommander(commanderAgent) {
    const sessionId = sessionIdOf(commanderAgent);
    if (sessionId === undefined) return;
    const tickets = this.ledger.executionTickets(sessionId);
    for (const ticket of tickets) {
      if (isTerminal(ticket) || this.resumed.has(ticket.id)) continue;
      this.resumed.add(ticket.id);
      try {
        const agent = await this.resolveWorker(ticket.execution.sessionId);
        if (agent === null) continue;
        this.ledger.markExecutionResumed(ticket.id, sessionId);
        await this.deliver(agent, [
          `【指挥者·恢复】工单 ${ticket.id} 的 Worker Session 在 DSH 重启后恢复。`,
          `目录：${ticket.execution.directory}`,
          '先检查目录、git 状态与已有产物，再继续；结束前调用 commander_report（或输出 STATUS:）。',
        ].join('\n'), 'recovery');
      } catch (error) {
        this.logger?.debug?.('commander-mode: 恢复 worker 失败（%s）：%o', ticket.id, error);
      }
    }
  }

  /** 装饰一个 worker agent：人设 section、工具收敛、report 工具、结束 guard。 */
  decorate(agent) {
    if (this.bindings.has(agent)) return;
    const ticket = this.ledger.findByWorkerSession(sessionIdOf(agent) ?? '');
    if (ticket === null) return;
    const disposers = [];
    const binding = { disposers, ticketId: ticket.id };
    this.bindings.set(agent, binding);
    const workerCtx = agent.ctx;
    try {
      disposers.push(workerCtx.systemPrompt.section({
        name: 'commander:worker',
        order: 650,
        text: () => WorkerPrompt({ ticket, directory: ticket.execution?.directory ?? '' }),
      }));
    } catch (error) {
      this.logger?.warn?.('commander-mode: 注入 Worker 人设失败：%o', error);
    }
    try {
      const allow = WORKER_TOOLS.filter((name) => {
        try {
          return typeof workerCtx.tools.get === 'function' ? workerCtx.tools.get(name) !== undefined : true;
        } catch {
          return true;
        }
      });
      if (typeof workerCtx.tools.restrict === 'function') disposers.push(workerCtx.tools.restrict({ allow }));
    } catch (error) {
      this.logger?.warn?.('commander-mode: 收紧 Worker 工具失败：%o', error);
    }
    try {
      disposers.push(workerCtx.tools.register(this.reportTool(agent, ticket.id)));
    } catch (error) {
      this.logger?.warn?.('commander-mode: 注册 commander_report 失败：%o', error);
    }
    try {
      if (typeof workerCtx.tools.guard === 'function') {
        disposers.push(workerCtx.tools.guard(() => {
          const current = this.ledger.getTicket(ticket.id, ticket.sessionId, { allowMissing: true });
          return current === null || isTerminal(current) ? '工单已结束；新工作需指挥者新建工单。' : undefined;
        }));
      }
    } catch (error) {
      this.logger?.warn?.('commander-mode: Worker 结束 guard 失败：%o', error);
    }
  }

  /** worker 侧 `commander_report` 工具定义。 */
  reportTool(agent, ticketId) {
    // 闭包捕获：工具以 `tool.execute(args)` 调用，`this` 是工具对象而不是服务实例。
    const ledger = this.ledger;
    const service = this;
    return {
      name: 'commander_report',
      description:
        '向指挥者汇报本工单的状态（结束前必须调用一次；之后不要再改文件）。'
        + 'status 六态：progress（在推进）/ waiting（等外部条件）/ ready（可验收）/ blocked（受阻等用户）/ failed（失败）/ dropped（无需处理）。'
        + 'summary 写做了什么、改了哪些文件、怎么验证；blocked/failed 用 question 写清需要用户决定什么。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] },
          summary: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['status', 'summary'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute(args) {
        const ticket = ledger.findByWorkerSession(sessionIdOf(agent) ?? '');
        if (ticket === null) throw new Error('找不到本 Worker Session 对应的工单；不要继续，先向指挥者报告。');
        if (isTerminal(ticket)) return { ok: false, reason: 'ticket-ended' };
        const parsed = parseReportStatus(`STATUS: ${args?.status}`);
        if (parsed === undefined) throw new Error('status 必须是 progress / waiting / ready / blocked / failed / dropped 之一。');
        ledger.recordReport(ticket.id, ticket.sessionId, {
          status: parsed.status,
          summary: typeof args?.summary === 'string' ? args.summary : '',
          question: typeof args?.question === 'string' ? args.question : '',
        });
        void service.notifyParent(ticket, [
          `【指挥者·执行者汇报】工单 ${ticket.id} → STATUS: ${parsed.status}。`,
          typeof args?.summary === 'string' ? args.summary : '',
          typeof args?.question === 'string' && args.question !== '' ? `等你回答：${args.question}` : '',
          '下一步：核对产物与验收判据 → commander_ticket_update；不要重复派同一任务。',
        ].filter((line) => line !== '').join('\n'), `执行者汇报：${ticket.id}`);
        return { ok: true, ticket: ticket.id, status: parsed.status };
      },
    };
  }

  /** 向工单所属指挥者会话投递通知（steer 唤醒）。 */
  async notifyParent(ticket, text, summary) {
    let agent = this.agents()?.get?.(ticket.sessionId) ?? null;
    if (agent === null) {
      try {
        const sessions = this.sessions();
        if (sessions === undefined) return false;
        const resolved = await sessions.resolveAgent(ticket.sessionId);
        if (resolved?.agent !== undefined) agent = resolved.agent;
      } catch {
        return false;
      }
    }
    if (agent === null || typeof agent.steer !== 'function') return false;
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-commander-mode', form: 'notice', summary },
      });
      return true;
    } catch (error) {
      this.logger?.warn?.('commander-mode: 通知指挥者失败：%o', error);
      return false;
    }
  }

  /** 解析 worker agent；不可用时 null。 */
  async resolveWorker(sessionId) {
    const sessions = this.sessions();
    const live = this.agents()?.get?.(sessionId);
    if (live !== undefined && live !== null) return live;
    if (sessions === undefined) return null;
    try {
      const resolved = await sessions.resolveAgent(sessionId);
      return resolved?.agent ?? null;
    } catch {
      return null;
    }
  }

  /** 投递一条用户角色消息：running → followup/steer；不存在时忽略。 */
  async deliver(agent, text, summary) {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-commander-mode', form: 'assignment', summary },
    };
    if (typeof agent.steer === 'function') agent.steer(message);
    else if (typeof agent.followup === 'function') agent.followup(message);
  }

  /** 释放一个 agent 的绑定。 */
  release(agent) {
    const binding = this.bindings.get(agent);
    if (binding === undefined) return;
    this.bindings.delete(agent);
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try {
        dispose?.();
      } catch {
        // 忽略释放失败。
      }
    }
  }
}

/** 取 agent 的会话 id。 */
function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 正数（默认值）。 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
}

/** 截断。 */
function truncate(text, max) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Worker 的固定人设 + 工单信息。 */
function WorkerPrompt({ ticket, directory }) {
  return [
    '## 你是指挥者模式下的执行者（Worker Session）',
    '',
    `你只负责一张工单：**${ticket.id} — ${ticket.title}**。`,
    directory === '' ? '' : `工作目录：\`${directory}\`（只在这个目录里改文件）。`,
    ticket.intent === '' ? '' : `背景：${ticket.intent}`,
    ticket.acceptance.length === 0 ? '' : `验收判据：\n${ticket.acceptance.map((item) => `- ${item}`).join('\n')}`,
    '',
    '纪律：',
    '- 只做这张工单范围内的事；不做无关重构，不改这个目录之外的文件。',
    '- 结束前**必须**调用 `commander_report`（status + summary；受阻/失败用 question 写清要用户决定什么）。',
    '- 不要向用户提问（你不是根 agent）；有阻塞就 `commander_report` 报 blocked/failed。',
    '- 不要调用 `commander_ticket_*` 或 `commander_worker_*`（那是指挥者的工具）。',
  ].filter((line) => line !== '').join('\n');
}

/** 首次派工消息。 */
function assignmentText({ ticket, task, directory, title }) {
  return [
    `【指挥者·派工】工单 ${ticket.id}${title === undefined || title === '' ? '' : `（${title}）`}`,
    '',
    `目录：${directory}`,
    ticket.acceptance.length === 0 ? '' : `验收判据：\n${ticket.acceptance.map((item) => `- ${item}`).join('\n')}`,
    '',
    '任务：',
    String(task),
    '',
    '结束前调用 `commander_report`（或至少输出一行 `STATUS: progress|waiting|ready|blocked|failed|dropped`）。',
  ].filter((line) => line !== '').join('\n');
}
