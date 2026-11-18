/**
 * 工单账本的持久化原语 —— 0.6.0 的存储层。
 *
 * ## 存哪、存什么
 *
 * 每个 profile 一个 JSON 文件，默认 `<DSH_HOME>/commander/<profile>.json`（可用配置
 * `stateDir` 覆盖）。只存**工单/授权/派发/回报**这类状态事实；**不存**会话内容、计划正文、
 * 子代理输出 —— 那些以 DSH 的会话日志为准（Model-visible means logged）。
 *
 * ## 三条硬要求
 *
 * 1. **原子写**：先写同目录临时文件，再 `rename` 覆盖。避免进程在写一半时被杀导致
 *    JSON 截断；Windows 上 `rename` 覆盖已存在文件是允许的。
 * 2. **损坏可恢复**：解析失败/版本不认识时，把原文件改名成 `*.corrupt-<时间戳>` 备份，
 *    然后从空账本启动。绝不因为账本坏了让整个模式起不来。
 * 3. **schema 校验**：外部文件可能被手改过。载入时逐条清洗，丢弃非法记录并给出 warning，
 *    但保留其余合法数据。
 *
 * ## 为什么不用 SQLite
 *
 * 0.6.0 的账本规模是"几十个工单"，JSON 足够；用 `node:sqlite` 会引入生命周期、锁与迁移
 * 成本（Super-agent 用它是为了 effect 队列/outbox 那套跨重启副作用，本阶段不需要）。
 * 若将来需要更强查询，再单独评估。
 *
 * @module dsh-commander-mode/lib/ledger
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** 当前账本 schema 版本。 */
export const LEDGER_SCHEMA_VERSION = 1;

/** 账本文件名（stateDir 指向目录时使用）。 */
export const LEDGER_FILE_NAME = 'ledger.json';

/**
 * 空账本。
 *
 * @returns {object} 空状态。
 */
export function emptyLedger() {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    nextTicket: 1,
    nextMandate: 1,
    nextAssignment: 1,
    mandates: [],
    tickets: [],
    /**
     * 7.12.0：**同步账本的持久化快照**（`lib/sync-store.js` 的形状），按会话隔离。
     *
     * 为什么存在：同步账本原本是 `agent.js` 里的 `WeakMap` + 纯内存对象，宿主重启就全丢
     * —— 实测 `session-1d8c8c60` 重启后看板上的「计划清单」整段消失、`plan-stale`
     * 52 小时里一次都没触发。这些是**跨回合的判断依据**，必须落盘。
     */
    syncSnapshots: [],
    /**
     * 7.19.0：**待投递的子智能体结算通知**（按会话）。
     *
     * 运行时 `notifySettlement()` 在父级回合不跑时**静默丢弃**完成通知
     * （守卫 `parent.ctx.fiber.state !== 2` 直接 return）。实测 `9fbe2191` 小组长
     * 6 个子智能体只收到 2 个，最后靠上级提醒才知道其余 4 个完成了。
     * 这里把送不出去的通知存下来，等父级下次渲染上下文时补投。
     */
    pendingNotices: [],
    updatedAt: 0,
  };
}

/**
 * 解析账本文件位置。
 *
 * 优先级：显式 `stateDir`（绝对路径，或以 `DSH_HOME`/用户目录为基准的相对路径）>
 * `<DSH_HOME>/commander/<profile>.json`。
 *
 * @param {object} input - 解析参数。
 * @param {string} [input.stateDir] - 配置里的 stateDir。
 * @param {NodeJS.ProcessEnv} [input.env] - 环境变量（默认 `process.env`）。
 * @param {string} [input.home] - 用户目录（默认 `os.homedir()`）。
 * @returns {string} 账本文件绝对路径。
 */
export function resolveLedgerFile({ stateDir, env = process.env, home = homedir() } = {}) {
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh');
  const profile = typeof env?.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '' ? env.DSH_PROFILE : 'default';
  const base = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (base === '') return join(dshHome, 'commander', `${safeSegment(profile)}.json`);
  const resolved = isAbsolute(base) ? base : join(dshHome, base);
  // 以 `.json` 结尾视为文件；否则视为目录，里面放 ledger.json。
  return /\.json$/i.test(resolved) ? resolved : join(resolved, LEDGER_FILE_NAME);
}

/**
 * 载入账本文件。
 *
 * @param {object} input - 载入参数。
 * @param {string} input.file - 账本路径。
 * @param {object} [input.logger] - Cordis logger（可选）。
 * @param {number} [input.now] - 当前时间（ms）。
 * @param {boolean} [input.backupCorrupt] - 损坏时是否备份原文件（默认 true；只读巡检传 false）。
 * @returns {{ state: object, warning: string | undefined }} 清洗后的状态与 warning。
 */
export function loadLedgerFile({ file, logger, now = Date.now(), backupCorrupt = true }) {
  if (typeof file !== 'string' || file.trim() === '') {
    return { state: emptyLedger(), warning: '账本路径为空，已用空账本启动' };
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: emptyLedger(), warning: undefined };
    logger?.warn?.('commander-mode: 读取工单账本失败（%s），已用空账本启动：%o', file, error);
    return { state: emptyLedger(), warning: `账本读取失败：${String(error?.message ?? error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (backupCorrupt) {
      const backup = backupCorruptFile(file, now);
      logger?.warn?.('commander-mode: 工单账本 JSON 损坏，已备份到 %s，用空账本启动', backup);
      return { state: emptyLedger(), warning: `账本 JSON 损坏，已备份到 ${backup}` };
    }
    return { state: emptyLedger(), warning: `账本 JSON 损坏（未备份：只读巡检）` };
  }
  const sanitized = sanitizeLedger(parsed);
  if (sanitized.warning !== undefined) {
    logger?.warn?.('commander-mode: 工单账本有无效记录：%s', sanitized.warning);
  }
  return { state: sanitized.state, warning: sanitized.warning };
}

/**
 * 原子写账本文件。
 *
 * @param {object} input - 写入参数。
 * @param {string} input.file - 目标路径。
 * @param {object} input.state - 账本状态。
 * @param {object} [input.logger] - Cordis logger（可选）。
 * @throws {Error} 写盘失败时抛出（由服务层决定降级还是上报）。
 */
export function saveLedgerFile({ file, state, logger }) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('账本路径为空，无法保存');
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(temporary, 'w');
    writeSync(fd, text, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原始错误。
      }
    }
    logger?.warn?.('commander-mode: 保存工单账本失败（%s）：%o', file, error);
    throw error;
  }
}

/**
 * 清洗外部账本：丢弃非法工单/授权，补齐计数器。
 *
 * @param {unknown} raw - 解析后的 JSON。
 * @returns {{ state: object, warning: string | undefined }} 清洗结果。
 */
/** 账本里最多保留多少份「同步账本快照」（7.12.0，按会话）。 */
export const MAX_SYNC_SNAPSHOTS = 20;

/** 账本里最多保留多少条待投递结算通知（7.19.0，全会话合计）。 */
export const MAX_PENDING_NOTICES_TOTAL = 100;

export function sanitizeLedger(raw) {
  const warnings = [];
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const version = Number(source.schemaVersion);
  if (version !== LEDGER_SCHEMA_VERSION) {
    return { state: emptyLedger(), warning: `账本 schemaVersion=${String(source.schemaVersion)} 不受支持（当前 ${LEDGER_SCHEMA_VERSION}）` };
  }
  const state = emptyLedger();

  // 授权：只保留字段完整的 active/superseded/revoked 记录。
  const mandates = Array.isArray(source.mandates) ? source.mandates : [];
  for (const mandate of mandates) {
    if (mandate === null || typeof mandate !== 'object') {
      warnings.push('丢弃 1 条非法授权（不是对象）');
      continue;
    }
    if (typeof mandate.id !== 'string' || typeof mandate.sessionId !== 'string' || typeof mandate.planHash !== 'string') {
      warnings.push('丢弃 1 条缺少 id/sessionId/planHash 的授权');
      continue;
    }
    state.mandates.push({
      id: mandate.id,
      sessionId: mandate.sessionId,
      planHash: mandate.planHash,
      planSummary: typeof mandate.planSummary === 'string' ? mandate.planSummary.slice(0, 4000) : '',
      confirmedAt: Number(mandate.confirmedAt) || 0,
      status: ['active', 'superseded', 'revoked'].includes(mandate.status) ? mandate.status : 'superseded',
      ...(mandate.revokedAt === undefined ? {} : { revokedAt: Number(mandate.revokedAt) || 0 }),
    });
  }

  const tickets = Array.isArray(source.tickets) ? source.tickets : [];
  for (const ticket of tickets) {
    if (ticket === null || typeof ticket !== 'object') {
      warnings.push('丢弃 1 条非法工单（不是对象）');
      continue;
    }
    if (typeof ticket.id !== 'string' || typeof ticket.sessionId !== 'string' || typeof ticket.title !== 'string') {
      warnings.push('丢弃 1 条缺少 id/sessionId/title 的工单');
      continue;
    }
    const status = typeof ticket.status === 'string' ? ticket.status : 'open';
    state.tickets.push({
      id: ticket.id,
      sessionId: ticket.sessionId,
      title: ticket.title.slice(0, 200),
      intent: typeof ticket.intent === 'string' ? ticket.intent.slice(0, 4000) : '',
      acceptance: Array.isArray(ticket.acceptance) ? ticket.acceptance.filter((item) => typeof item === 'string').slice(0, 40) : [],
      scope: Array.isArray(ticket.scope) ? ticket.scope.filter((item) => typeof item === 'string').slice(0, 40) : [],
      status: [
        'open', 'working', 'waiting', 'review', 'blocked', 'failed', 'done', 'cancelled',
      ].includes(status) ? status : 'open',
      mandateId: typeof ticket.mandateId === 'string' ? ticket.mandateId : null,
      teamTaskId: typeof ticket.teamTaskId === 'string' && /^task-\d+$/u.test(ticket.teamTaskId) ? ticket.teamTaskId : null,
      assignments: Array.isArray(ticket.assignments) ? ticket.assignments.filter((assignment) => assignment !== null && typeof assignment === 'object').map((assignment) => ({
        id: String(assignment.id ?? 'a-?'),
        channel: typeof assignment.channel === 'string' ? assignment.channel : 'specialist',
        toolName: typeof assignment.toolName === 'string' ? assignment.toolName : '',
        ref: typeof assignment.ref === 'string' ? assignment.ref : null,
        startedAt: Number(assignment.startedAt) || 0,
        endedAt: assignment.endedAt === null || assignment.endedAt === undefined ? null : Number(assignment.endedAt) || 0,
      })) : [],
      lastReport: sanitizeReport(ticket.lastReport),
      execution: sanitizeExecution(ticket.execution),
      createdAt: Number(ticket.createdAt) || 0,
      updatedAt: Number(ticket.updatedAt) || 0,
      endedAt: ticket.endedAt === null || ticket.endedAt === undefined ? null : Number(ticket.endedAt) || 0,
      endReason: typeof ticket.endReason === 'string' ? ticket.endReason : null,
    });
  }

  state.nextTicket = nextCounter(source.nextTicket, state.tickets, 't-');
  state.nextMandate = nextCounter(source.nextMandate, state.mandates, 'm-');
  const assignmentIds = state.tickets.flatMap((ticket) => ticket.assignments.map((assignment) => assignment.id));
  state.nextAssignment = nextCounter(source.nextAssignment, assignmentIds.map((id) => ({ id })), 'a-');

  // 7.12.0：同步账本快照按会话保留。**只做形状校验，不解释内容**——  // 语义由 `lib/sync-store.js` 的 `applySnapshot()` 负责（它自己容错）。
  const snapshots = Array.isArray(source.syncSnapshots) ? source.syncSnapshots : [];
  for (const entry of snapshots) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue;
    if (entry.snapshot === null || typeof entry.snapshot !== 'object') continue;
    state.syncSnapshots.push({
      sessionId: entry.sessionId,
      savedAt: Number(entry.savedAt) || 0,
      snapshot: entry.snapshot,
    });
  }
  // 只保留最近的若干份，防止长期使用把账本撑大。
  if (state.syncSnapshots.length > MAX_SYNC_SNAPSHOTS) {
    state.syncSnapshots = state.syncSnapshots
      .sort((a, b) => a.savedAt - b.savedAt)
      .slice(-MAX_SYNC_SNAPSHOTS);
  }

  // 7.19.0：待投递结算通知（按会话）。只做形状校验。
  const notices = Array.isArray(source.pendingNotices) ? source.pendingNotices : [];
  for (const notice of notices) {
    if (notice === null || typeof notice !== 'object') continue;
    if (typeof notice.sessionId !== 'string' || notice.sessionId === '') continue;
    if (typeof notice.childId !== 'string' || notice.childId === '') continue;
    state.pendingNotices.push({
      sessionId: notice.sessionId,
      childId: notice.childId,
      name: typeof notice.name === 'string' ? notice.name.slice(0, 120) : '',
      stopReason: typeof notice.stopReason === 'string' ? notice.stopReason.slice(0, 40) : '',
      at: Number(notice.at) || 0,
    });
  }
  if (state.pendingNotices.length > MAX_PENDING_NOTICES_TOTAL) {
    state.pendingNotices = state.pendingNotices.sort((a, b) => a.at - b.at).slice(-MAX_PENDING_NOTICES_TOTAL);
  }

  state.updatedAt = Number(source.updatedAt) || 0;
  return { state, warning: warnings.length > 0 ? warnings.join('；') : undefined };
}

/**
 * 清洗历史工单里的 `execution` 字段（0.8.0 的 Worker Session 执行信息）。
 *
 * ⚠️ **仅兼容旧数据**：Worker Session 通道 7.0.0 下线、7.0.1 实现已删除，
 * 现在没有任何代码会写入这个字段。保留清洗是为了让升级前落盘的账本能被原样读出
 * （`commander-status` / `commander_tickets` 仍能看到历史工单的 worker 会话 id），
 * 不要据此认为 Worker 通道还在。
 *
 * @param {unknown} execution - 历史 `execution` 字段。
 * @returns {object | null} 清洗后的记录；没有有效 sessionId 时 null。
 */
function sanitizeExecution(execution) {
  if (execution === null || execution === undefined || typeof execution !== 'object') return null;
  const sessionId = typeof execution.sessionId === 'string' && execution.sessionId !== '' ? execution.sessionId : '';
  const directory = typeof execution.directory === 'string' ? execution.directory : '';
  if (sessionId === '') return null;
  return {
    sessionId,
    directory,
    startedAt: Number(execution.startedAt) || 0,
    permission: typeof execution.permission === 'string' ? execution.permission : '',
    resumedAt: execution.resumedAt === null || execution.resumedAt === undefined ? null : Number(execution.resumedAt) || 0,
  };
}

/** 清洗一条 Report。 */
function sanitizeReport(report) {
  if (report === null || report === undefined || typeof report !== 'object') return null;
  const status = typeof report.status === 'string' ? report.status.toLowerCase() : '';
  if (!['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(status)) return null;
  return {
    status,
    summary: typeof report.summary === 'string' ? report.summary.slice(0, 2000) : '',
    question: typeof report.question === 'string' ? report.question.slice(0, 2000) : '',
    at: Number(report.at) || 0,
    ...(typeof report.assignmentId === 'string' ? { assignmentId: report.assignmentId } : {}),
  };
}

/** 从 `t-12` 这类 id 推下一个计数器，且不低于文件里记录的值。 */
function nextCounter(recorded, rows, prefix) {
  let max = Number(recorded) || 1;
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    const value = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(value) && value >= max) max = value + 1;
  }
  return max;
}

/** 备份损坏文件（失败只记日志，不阻断）。 */
function backupCorruptFile(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  try {
    if (existsSync(file)) renameSync(file, target);
  } catch {
    return target;
  }
  return target;
}

/** 把任意字符串变成安全的文件名片段。 */
function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'default';
}

/** 供测试：直接写一个状态（绕开服务层）。 */
export function writeLedgerForTest(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
