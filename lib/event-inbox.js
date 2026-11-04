/**
 * 外部事件投递器（1.1.0）—— 文件队列 → `steer` 指挥者会话。
 *
 * ## 它解决什么
 *
 * 0.7.0 起指挥者会被「执行者完成通知」唤醒；但**外部世界**（CI 失败、Issue 新评论、告警、
 * 定时巡检）没有入口。没有 dsh 进程内的常驻事件源时，最稳的做法是**文件队列**：
 * 外部系统往 `<events>/inbox/` 写一个 JSON，本服务轮询取走、投递给对应的指挥者会话。
 *
 * ## 为什么是轮询而不是 fs.watch
 *
 * - `fs.watch` 在 Windows/网络盘上会漏事件、要处理 rename 风暴；事件频率是"分钟级"，轮询
 *   足够（默认 15 秒）。
 * - 轮询天然可重试：目标会话暂时不在时文件留在 inbox 下，下一次再试；投递成功后移进
 *   `delivered/`，所以不会重复投递（进程内再加一个 `deliveredIds` 集合兜底）。
 *
 * ## 与"会话内模式"的关系
 *
 * 它不创建会话、不建工单、不替指挥者做决定 —— 只把"外部发生了什么"送到指挥者眼前。
 * 会话已关闭时事件会留在 inbox（`commander-status` 能看到待投递数量），不会静默丢失。
 *
 * ## 生命周期
 *
 * 由配置行（`index.js`）在 `apply()` 里 `install()`，用 `ctx.effect` 绑定释放；配置行是
 * profile 顶层、进程级常驻，所以轮询跟着进程走，不依赖任何 agent 是否挂载。
 *
 * @module dsh-commander-mode/lib/event-inbox
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  EVENT_DELIVERED_DIR,
  EVENT_INBOX_DIR,
  EVENT_REJECTED_DIR,
  eventFileName,
  normalizeEvent,
  renderEventNotice,
  resolveEventDir,
} from './events.js';

/** 服务名（配置行 `provide`，诊断/看板可读）。 */
export const EVENTS_SERVICE_NAME = 'commanderEvents';

/** 默认轮询间隔（ms）。 */
export const DEFAULT_EVENT_POLL_MS = 15_000;

/** 轮询下限（防配置写 0 造成忙等）。 */
export const MIN_EVENT_POLL_MS = 500;

/** delivered / rejected 目录各保留多少条（审计用，避免无限增长）。 */
export const EVENT_KEEP_FILES = 200;

/**
 * 读 inbox 目录（只读；状态 CLI 与 `--list` 共用）。
 *
 * @param {string} dir - 事件目录（`.../events`）。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.withEvents] - 是否解析事件内容（默认 true）。
 * @param {number} [options.limit] - 最多返回多少条（默认 200）。
 * @returns {{ dir: string, entries: object[] }} 目录与条目。
 */
export function readInbox(dir, { withEvents = true, limit = 200 } = {}) {
  const inbox = join(dir, EVENT_INBOX_DIR);
  if (!existsSync(inbox)) return { dir, entries: [] };
  let names;
  try {
    names = readdirSync(inbox).filter((name) => name.toLowerCase().endsWith('.json')).sort();
  } catch {
    return { dir, entries: [] };
  }
  const entries = [];
  for (const name of names.slice(0, Math.max(1, limit))) {
    const file = join(inbox, name);
    const entry = { file, name };
    if (withEvents) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const normalized = normalizeEvent(raw, { fallbackId: name.replace(/\.json$/iu, '') });
        entry.event = normalized.event;
        entry.errors = normalized.errors;
      } catch (error) {
        entry.event = null;
        entry.errors = [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`];
      }
    }
    entries.push(entry);
  }
  return { dir, entries };
}

/** 文件名安全化（移动归档时用）。 */
function archiveName(name) {
  return name.replace(/[\\/:*?"<>|]/gu, '_');
}

/** 正整数。 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
}

/**
 * 外部事件投递器。
 */
export class CommanderEventInbox {
  /**
   * @param {object} input - 依赖。
   * @param {object} input.ctx - 配置行 ctx（取 agents / sessions）。
   * @param {object} input.ledger - 账本服务（ticket → session 路由）。
   * @param {() => object} input.getOptions - 读当前配置。
   * @param {object} [input.logger] - Cordis logger。
   * @param {object} [input.deps] - 测试注入的 fs / 定时器 / 时钟。
   */
  constructor({ ctx, ledger, getOptions, logger, deps = {} }) {
    this.ctx = ctx;
    this.ledger = ledger;
    this.getOptions = typeof getOptions === 'function' ? getOptions : () => ({});
    this.logger = logger;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.timer = null;
    this.disposed = false;
    this.scanning = false;
    /** 已投递过的事件 id（进程内兜底，防 rename 失败导致重复投递）。 */
    this.deliveredIds = new Set();
    this.stats = { delivered: 0, rejected: 0, deferred: 0, lastScanAt: 0 };
  }

  /** 事件目录（每次按当前配置解析，stateDir 改动无需重启也能跟上）。 */
  directory() {
    const options = this.options();
    return resolveEventDir({ stateDir: options.stateDir, env: this.env });
  }

  /** 宿主环境变量（测试可注入）。 */
  get env() {
    return this.deps.env ?? process.env;
  }

  /** 当前配置。 */
  options() {
    try {
      return this.getOptions() ?? {};
    } catch {
      return {};
    }
  }

  /** 是否启用。 */
  enabled() {
    return this.options().eventInbox !== false;
  }

  /** 轮询间隔（配置值，夹到下限以上）。 */
  pollMs() {
    return Math.max(MIN_EVENT_POLL_MS, positive(this.options().eventPollMs, DEFAULT_EVENT_POLL_MS));
  }

  /**
   * 启动轮询。
   *
   * @returns {() => void} 释放函数（清定时器）。
   */
  install() {
    if (!this.enabled()) {
      this.logger?.debug?.('commander-mode: eventInbox 已关闭，不启动外部事件轮询');
      return () => {};
    }
    this.ensureDirectories();
    // 立即扫一次：进程刚起来时可能已经有积压事件（例如上一进程退出期间 CI 失败了）。
    void this.scanOnce();
    const interval = this.deps.setInterval ?? setInterval;
    this.timer = interval(() => {
      void this.scanOnce();
    }, this.pollMs());
    // 轮询不应该单独撑着进程不退出；宿主进程常驻，这里只是保险。
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    this.logger?.info?.('commander-mode: 外部事件轮询已启动（%s，%d ms）', this.directory(), this.pollMs());
    return () => this.close();
  }

  /** 停止轮询。 */
  close() {
    this.disposed = true;
    if (this.timer !== null) {
      const clear = this.deps.clearInterval ?? clearInterval;
      clear(this.timer);
      this.timer = null;
    }
  }

  /** 建目录（失败只降级：没有目录时 scanOnce 会记录一次 defer）。 */
  ensureDirectories() {
    const mkdir = this.deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
    const dir = this.directory();
    for (const name of [EVENT_INBOX_DIR, EVENT_DELIVERED_DIR, EVENT_REJECTED_DIR]) {
      try {
        mkdir(join(dir, name));
      } catch (error) {
        this.logger?.warn?.('commander-mode: 创建事件目录失败（%s）：%o', join(dir, name), error);
        return false;
      }
    }
    return true;
  }

  /** 待投递事件数（同步；状态 CLI 用 `readInbox`）。 */
  pendingCount() {
    const readdir = this.deps.readdir ?? readdirSync;
    try {
      return readdir(join(this.directory(), EVENT_INBOX_DIR)).filter((name) => name.toLowerCase().endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  /**
   * 扫一次 inbox：投递所有可路由的事件。
   *
   * @returns {Promise<{delivered: number, rejected: number, deferred: number}>} 本轮结果。
   */
  async scanOnce() {
    if (this.disposed || this.scanning) return { delivered: 0, rejected: 0, deferred: 0 };
    this.scanning = true;
    const result = { delivered: 0, rejected: 0, deferred: 0 };
    try {
      this.ensureDirectories();
      const readdir = this.deps.readdir ?? readdirSync;
      let names = [];
      try {
        names = readdir(this.inboxDir())
          .filter((name) => name.toLowerCase().endsWith('.json'))
          .sort();
      } catch (error) {
        // 目录不存在 = 还没有事件；不报错，避免每 15 秒刷日志。
        if (error?.code !== 'ENOENT') this.logger?.warn?.('commander-mode: 读取事件 inbox 失败：%o', error);
        return result;
      }
      for (const name of names) {
        const outcome = await this.consumeFile(name);
        result[outcome] += 1;
      }
      this.stats.lastScanAt = this.now();
      return result;
    } finally {
      this.scanning = false;
    }
  }

  /** 消费一个事件文件：正常投递返回 'delivered'，坏格式 'rejected'，暂时无法投递 'deferred'。 */
  async consumeFile(name) {
    const file = join(this.inboxDir(), name);
    let raw;
    try {
      const readFile = this.deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
      raw = JSON.parse(readFile(file, 'utf8'));
    } catch (error) {
      return this.reject(name, [`事件文件不可读或不是 JSON：${error instanceof Error ? error.message : String(error)}`]);
    }
    const fallbackId = name.replace(/\.json$/iu, '');
    const { event, errors } = normalizeEvent(raw, { fallbackId, now: this.now() });
    if (event === null) return this.reject(name, errors);
    if (this.deliveredIds.has(event.id)) {
      // 上次投递成功但归档失败：不再重复投递，直接归档。
      this.deliverFile(name);
      return 'delivered';
    }
    const sessionId = this.routeSession(event);
    if (sessionId === null) {
      this.stats.deferred += 1;
      this.logger?.debug?.('commander-mode: 事件 %s 暂时没有可投递的会话（ticket=%s）', event.id, event.ticket);
      return 'deferred';
    }
    const agent = await this.resolveAgent(sessionId);
    if (agent === null) {
      this.stats.deferred += 1;
      this.logger?.debug?.('commander-mode: 事件 %s 的目标会话 %s 当前不可用，留待下次重试', event.id, sessionId);
      return 'deferred';
    }
    try {
      this.steer(agent, event);
    } catch (error) {
      this.logger?.warn?.('commander-mode: 投递外部事件失败（%s → %s）：%o', event.id, sessionId, error);
      return 'deferred';
    }
    this.deliveredIds.add(event.id);
    this.stats.delivered += 1;
    this.deliverFile(name);
    this.logger?.info?.('commander-mode: 已投递外部事件 %s（%s → %s）', event.id, event.kind, sessionId);
    return 'delivered';
  }

  /** 事件 → 目标指挥者会话 id；无法路由返回 null。 */
  routeSession(event) {
    if (event.session !== '') return event.session;
    if (event.ticket !== '') {
      try {
        const sessionId = typeof this.ledger?.sessionOfTicket === 'function'
          ? this.ledger.sessionOfTicket(event.ticket)
          : null;
        return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 解析指挥者 agent：先查实时注册表，再尝试恢复会话。 */
  async resolveAgent(sessionId) {
    try {
      const live = this.agents()?.get?.(sessionId);
      if (live !== undefined && live !== null) return live;
    } catch {
      // 实时注册表不可读时继续走 resolveAgent。
    }
    try {
      const sessions = this.sessions();
      if (sessions === undefined) return null;
      const resolved = await sessions.resolveAgent(sessionId);
      return resolved?.agent ?? null;
    } catch {
      return null;
    }
  }

  /** `steer` 一条用户角色消息：空闲会话会被唤醒，忙碌会话在最近步骤边界送达。 */
  steer(agent, event) {
    if (typeof agent?.steer !== 'function') throw new Error('目标 agent 不支持 steer');
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: renderEventNotice(event) }],
      source: { kind: 'dsh-commander-mode', form: 'notice', summary: `外部事件：${event.kind}` },
    });
  }

  /** 移进 rejected/ 并记 warning。 */
  reject(name, errors) {
    this.stats.rejected += 1;
    this.logger?.warn?.('commander-mode: 拒绝外部事件 %s：%s', name, errors.join('；'));
    this.archive(name, EVENT_REJECTED_DIR);
    return 'rejected';
  }

  /** 移进 delivered/。 */
  deliverFile(name) {
    this.archive(name, EVENT_DELIVERED_DIR);
  }

  /** 归档一个 inbox 文件；失败只记 warning（事件不会丢，下次扫描还会看到 id 已投递）。 */
  archive(name, subdir) {
    const rename = this.deps.rename ?? renameSync;
    const targetDir = join(this.directory(), subdir);
    try {
      rename(join(this.inboxDir(), name), join(targetDir, archiveName(name)));
      this.prune(subdir);
    } catch (error) {
      this.logger?.warn?.('commander-mode: 归档事件文件失败（%s → %s）：%o', name, subdir, error);
    }
  }

  /** 只保留最近 EVENT_KEEP_FILES 个归档文件。 */
  prune(subdir) {
    const readdir = this.deps.readdir ?? readdirSync;
    const unlink = this.deps.unlink ?? unlinkSync;
    try {
      const dir = join(this.directory(), subdir);
      const names = readdir(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
      for (const name of names.slice(0, Math.max(0, names.length - EVENT_KEEP_FILES))) {
        try {
          unlink(join(dir, name));
        } catch {
          // 单个删除失败不影响其它。
        }
      }
    } catch {
      // 归档目录不存在或不可读：忽略。
    }
  }

  /** inbox 目录路径。 */
  inboxDir() {
    return join(this.directory(), EVENT_INBOX_DIR);
  }

  /** 取实时 agents 服务（可选）。 */
  agents() {
    try {
      return typeof this.ctx?.get === 'function' ? this.ctx.get('agents') : undefined;
    } catch {
      return undefined;
    }
  }

  /** 取会话服务（可选）。 */
  sessions() {
    try {
      return typeof this.ctx?.get === 'function' ? this.ctx.get('sessions') : undefined;
    } catch {
      return undefined;
    }
  }
}

/** 供测试/诊断使用：事件文件名。 */
export { eventFileName };
