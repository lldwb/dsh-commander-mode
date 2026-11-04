/**
 * 外部事件（1.1.0）—— 轻量 Trigger 的**纯函数**部分。
 *
 * ## 为什么不做 SourceKind 全框架
 *
 * Super-agent 的 Source → Trigger → Thread → Eval → Ticket 五段式是为"多源、多仓、多
 * 频道"设计的；指挥官模式是**会话内模式**，用户就在会话里。1.1.0 只补它缺的那一块：
 * **外部事件能把空闲的指挥者叫醒**（CI 失败、Issue 新评论、告警、定时巡检结果）。
 * 所以只定义一个"事件文件"契约 + 一个轮询投递器，不引入 Source/Policy/评估器。
 *
 * ## 契约（文件即队列）
 *
 * 外部系统把 JSON 写进 `<events>/inbox/<id>.json`，插件轮询取走、`steer` 指挥者会话，
 * 成功投递后把文件移到 `<events>/delivered/`。事件格式：
 *
 * ```json
 * {
 *   "version": 1,
 *   "id": "evt-1793787000000-ab12",
 *   "kind": "ci-failed",
 *   "summary": "build #42 失败：test/auth 3 个用例",
 *   "detail": "可选的长文本（≤4000 字符）",
 *   "ticket": "t-3",
 *   "session": "session-...",
 *   "source": "github-actions / build-bot",
 *   "createdAt": 1793787000000
 * }
 * ```
 *
 * - `kind` / `summary` 必填；`ticket` 与 `session` 二选一（都写时 `session` 优先），
 *   用来决定投递给哪个指挥者会话；
 * - `id` 缺省时用文件名（不含 `.json`）兜底，再缺省则按时间生成；
 * - 投递是**尽力而为**：目标会话不在（已关闭 / 从未存在）时文件留在 inbox，等下次轮询；
 *   格式坏了才移进 `rejected/`，不会无限重试。
 *
 * 这个模块只做纯计算（路径、校验、渲染），文件 IO 在 `lib/event-inbox.js`。
 *
 * @module dsh-commander-mode/lib/events
 */

import { dirname, join } from 'node:path';

import { resolveLedgerFile } from './ledger.js';

/** 事件文件 schema 版本。 */
export const EVENT_VERSION = 1;

/** 事件目录名（在账本文件所在目录下）。 */
export const EVENT_DIR_NAME = 'events';

/** 未投递事件子目录。 */
export const EVENT_INBOX_DIR = 'inbox';

/** 已投递事件子目录（保留最近若干条用于审计）。 */
export const EVENT_DELIVERED_DIR = 'delivered';

/** 被拒绝事件子目录（格式错误 / 无法解析）。 */
export const EVENT_REJECTED_DIR = 'rejected';

/** 字段长度上限。 */
export const EVENT_LIMITS = Object.freeze({
  id: 200,
  kind: 60,
  summary: 1000,
  detail: 4000,
  source: 200,
  ticket: 100,
  session: 300,
});

/**
 * 事件目录：与账本同级的 `events/`。
 *
 * 复用账本路径解析，所以 `stateDir` 的三种写法（空 / 目录 / 以 `.json` 结尾的文件）都会
 * 落在正确位置：`dirname(ledgerFile)/events`。
 *
 * @param {object} [input] - 解析参数。
 * @param {string} [input.stateDir] - 配置里的 stateDir。
 * @param {NodeJS.ProcessEnv} [input.env] - 环境变量。
 * @param {string} [input.home] - 用户目录。
 * @returns {string} 事件目录绝对路径。
 */
export function resolveEventDir({ stateDir, env = process.env, home } = {}) {
  const ledgerFile = resolveLedgerFile({ stateDir, env, home });
  return join(dirname(ledgerFile), EVENT_DIR_NAME);
}

/** 取一个字符串字段（去空白 + 截断），非字符串返回空串。 */
function textField(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

/**
 * 校验并清洗一条事件。
 *
 * 宽容策略与账本一致：能用的字段尽量保留，但**必填缺失直接判无效**（否则投递出去是一句
 * 无法行动的噪声）。返回 `errors` 时调用方应把文件移进 `rejected/` 并记 warning。
 *
 * @param {unknown} raw - 解析后的事件对象。
 * @param {object} [options] - 选项。
 * @param {string} [options.fallbackId] - 文件名（不含 `.json`），`id` 缺省时用它。
 * @param {number} [options.now] - 当前时间（生成缺省 id / createdAt）。
 * @returns {{ event: object | null, errors: string[] }} 清洗后的事件或错误列表。
 */
export function normalizeEvent(raw, { fallbackId, now = Date.now() } = {}) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { event: null, errors: ['事件必须是 JSON 对象'] };
  }
  const kind = textField(raw.kind, EVENT_LIMITS.kind);
  if (kind === '') errors.push('kind 必填（事件类型，例如 ci-failed / issue-comment / alert）');
  const summary = textField(raw.summary, EVENT_LIMITS.summary);
  if (summary === '') errors.push('summary 必填（一句话说清发生了什么、要人/指挥者做什么）');

  const ticket = textField(raw.ticket, EVENT_LIMITS.ticket);
  const session = textField(raw.session, EVENT_LIMITS.session);
  if (ticket === '' && session === '') {
    errors.push('ticket 与 session 至少写一个（事件要投递给哪个指挥者会话）');
  }

  const id = textField(raw.id, EVENT_LIMITS.id)
    || textField(typeof fallbackId === 'string' ? fallbackId : '', EVENT_LIMITS.id)
    || `evt-${now}-${Math.random().toString(36).slice(2, 8)}`;

  if (errors.length > 0) return { event: null, errors };

  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.round(raw.createdAt) : now;
  return {
    event: {
      version: EVENT_VERSION,
      id,
      kind,
      summary,
      detail: textField(raw.detail, EVENT_LIMITS.detail),
      ticket,
      session,
      source: textField(raw.source, EVENT_LIMITS.source),
      createdAt,
    },
    errors: [],
  };
}

/**
 * 渲染给指挥者看的事件消息（`steer` 的正文）。
 *
 * 写成"这不是用户消息"是刻意的：它由外部系统触发，若被当成用户指令，指挥者可能跳过
 * 规划/确认；写成"通知 + 下一步动作"，与 0.7.0 的派工完成通知风格一致。
 *
 * @param {object} event - `normalizeEvent` 清洗后的事件。
 * @returns {string} 消息正文。
 */
export function renderEventNotice(event) {
  const lines = [
    `【指挥者·外部事件】${event.kind}`,
    event.summary,
  ];
  if (event.detail !== '') lines.push('', event.detail);
  if (event.ticket !== '') lines.push('', `关联工单：${event.ticket}`);
  if (event.source !== '') lines.push(`来源：${event.source}`);
  lines.push(`事件 ID：${event.id}`);
  lines.push(
    '',
    '这是外部系统推送的事件，不是用户消息；先只读核对（产物 / 状态 / 日志），再决定：更新工单、派活、或标记受阻。'
    + '需要用户决定时用 ask_user_question（一次一问）；不要因为这条事件重复派同一任务。',
  );
  return lines.join('\n');
}

/** 事件 id 是否可安全用作文件名（只允许字母数字与 `-_.`，防路径穿越）。 */
export function isSafeEventId(id) {
  return typeof id === 'string' && id !== '' && /^[A-Za-z0-9._-]+$/u.test(id) && id !== '.' && id !== '..';
}

/** 事件文件名：`<id>.json`。 */
export function eventFileName(event) {
  return `${isSafeEventId(event.id) ? event.id : `evt-${Date.now()}`}.json`;
}
