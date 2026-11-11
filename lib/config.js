/**
 * `dsh-commander-mode` 的配置：schema、默认值、读取器。
 *
 * ## 为什么这里终于声明了 `Config`
 *
 * 0.1.x 故意不声明 schema（零依赖）。0.2.0 加了「可配置的多模型 specialist 名册」，
 * 而 DSH 的规则是：**只有声明了 `Config` 的行才会出现在「设置 → 插件」里**，只有打了
 * `.volatile()` 的字段才能被设置页读写。所以名册必须走 schema。
 *
 * 代价是引入唯一一个依赖 `@deepseek-ai/schemastery`（装进本包 `node_modules` —— profile
 * 下解析不到随附包，见 `dsh-plugin-settings-page` skill §5）。其余能力仍然全部通过
 * `ctx` 拿，不 import 任何随附包。
 *
 * ## 两条硬约束
 *
 * 1. **`cordis.patch.yml` 里写过的每个键这里都必须声明**：按 id 定向的 patch 会**整块
 *    替换** `config`，不做深合并；而声明了 schema 之后，未知键会被 schema 拒绝。
 * 2. **`.volatile()` 只能加在数组这一层**：schemastery 禁止 volatile 嵌套 volatile，
 *    名册元素里的字段不能再各自 volatile。
 *
 * ## 读 volatile 字段要宽容
 *
 * 解析后的 volatile 字段是**引用**（有 `.get()`），但单测与手写解析路径拿到的是普通值。
 * `readSpecialists()` / `readMaxSpecialists()` 同时接受两种形态。
 *
 * @module dsh-commander-mode/lib/config
 */

import z from '@deepseek-ai/schemastery';

import { DEFAULT_BLOCKED_TOOLS } from './guard.js';
import { cloneDefaultSpecialists } from './presets.js';

// 3.1.0：等待门禁相关常量（`MIN_MAX_WAIT_MS` / `MAX_MAX_WAIT_MS` / `maxWaitMs`）已随
// 「禁止等待子智能体、不设开关」整体移除 —— 见 `lib/guard.js` 的 `evaluateWaitForbidden()`。

// ---------------------------------------------------------------- schema ---

/**
 * 一个 specialist 的配置形状。
 *
 * `id` 同时是工具名的后缀（`subagent_<id>`），所以限制成 kebab/snake 风格的小写标识符：
 * 它要能出现在工具名里，也要能被人一眼认出来是谁。
 *
 * ## provider / model 是可空的
 *
 * 出厂预置名册里这两栏是空串，语义 = **继承指挥者（父会话）的模型路由**。原因很实际：
 * 预置名册不能硬编码任何 provider/model —— 不同部署可用的模型完全不同，写死了在别人的
 * 部署里就是一条坏配置。用户想给某个专家绑定专属模型时，在设置页把两栏都填上。
 *
 * 校验上要求**两栏要么都空、要么都填**（一半填一半空 = 路由不完整）：schema 表达不了
 * 这种跨字段约束，由 `lib/specialists.js` 的 `normalizeRoster()` 兜底。
 */
export const SpecialistSchema = z.object({
  id: z.string().required().pattern(/^[a-z][a-z0-9_-]{0,47}$/),
  provider: z.string().default(''),
  model: z.string().default(''),
  description: z.string().required(),
  persona: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
});

/**
 * 本插件 Loader 行的完整配置。
 *
 * `specialists` 是**唯一**的 volatile 字段：设置页只编辑它，其余都是加载期配置
 * （改它们要改 profile patch / 重新加载）。
 *
 * `specialists` 的默认值是**出厂预置名册**（`lib/presets.js`，按主流软件开发生命周期
 * 划分的 6 个专家，模型继承指挥者）。用户要开箱为空，可以在 profile patch 里显式写
 * `specialists: []`。
 */
export const Config = z.object({
  specialists: z.array(SpecialistSchema).default(cloneDefaultSpecialists()).volatile(),

  /** 名册条数上限（防御性：每个 specialist 都意味着一个 preset + 一个工具）。 */
  maxSpecialists: z.number().step(1).min(0).default(20),

  /** 是否强制"规划/拆分完成后先让用户确认"——本模式的核心要求。 */
  confirmPlan: z.boolean().default(true),

  /** 是否强制"子代理之间有分歧时交回用户"。 */
  escalateOnConflict: z.boolean().default(true),

  /** 写进协议的建议并行上限。 */
  // 3.0.0：8 → 16。用户 2026-11-11 规则 2：并行上限取运行时「子智能体」设置
  // （`subagent.maxActiveSubagents=16`、`agent-team.maxMembers=16`）；插件不再自己压低上限。
  maxTeammates: z.number().step(1).min(1).max(16).default(16),

  // ---------------------------------------------- 三层指挥链（3.0.0） ---

  /**
   * 是否启用「只有小组长改进度与排期」的确定性门禁（默认开启）。
   *
   * 开启时 `lib/guard.js` 的三条门禁在 `tools/pre-execute` 上生效，只拦**指挥官本人**：
   *
   * - `team_task_update` 的 `claim` / `release` / `complete` / `reopen` / `set_dependencies`
   *   （`evaluateBoardWrite`）；`reassign` / `edit` / `delete` 仍由指挥官做；
   * - `commander_ticket_update` 的六态回报 `progress` / `waiting` / `ready` / `blocked` /
   *   `failed`（`evaluateTicketWrite`，它会投影到共享任务板，绕道同样算改进度）；
   * - `subagent_<id>` / `subagent` / `subagent_fork`（`evaluateSpecialistDispatch`）。
   *
   * 关掉后退化为**只靠协议约束**（2.x 的行为）：文本仍在，但没有硬拦截。子级
   * （小组长 / 子智能体）与身份读不出来的调用一律放行——门禁的默认方向是"宁可漏拦"。
   */
  delegationHierarchy: z.boolean().default(true),

  /**
   * 结算同步看板 + 回合结束前的同步兜底。
   *
   * 开启后：每轮运行时上下文里放一行「指挥者·同步看板」（任务板 / 计划清单 / 团队状态的
   * 实时快照，有未同步项时带 ⚠️ 纠正指令）；回合即将结束时若仍有未同步项，用
   * `agent/turn-stopping` 注入一次提醒。关掉它只去掉这两样，协议文字仍在。
   */
  syncGuard: z.boolean().default(true),

  /** 指挥者**不许自己调用**的工具名；传 `[]` 只留协议约束。 */
  blockedTools: z.array(z.string()).default([...DEFAULT_BLOCKED_TOOLS]),

  /** 是否把长文协议注册成 skill（`commander-mode`）。 */
  registerSkill: z.boolean().default(true),

  // ---------------------------------------------------------- 0.6.0 工单账本 ---

  /**
   * 是否启用工单账本（`commander_ticket_*` 工具 + 看板 + 计划授权门禁）。
   *
   * 关掉后退化为 0.5.0 的行为：只有同步看板与协议，没有工单、没有 Mandate 门禁。
   */
  ledger: z.boolean().default(true),

  /**
   * 账本文件位置。空 = 默认 `<DSH_HOME>/commander/<profile>.json`。
   *
   * 相对路径以 `DSH_HOME` 为基准；以 `.json` 结尾视为文件，否则视为目录（里面放
   * `ledger.json`）。工单是"跨会话的进度状态"，不要放进临时目录。
   */
  stateDir: z.string().default(''),

  /**
   * 派发新工作前是否必须有用户确认的计划授权（Mandate）。
   *
   * 开启时：没有 `ask_user_question`（问题 id=`commander-plan`，选项「确认，开始执行」）
   * 的确认，派发 specialist / subagent / workflow / spawn_teammate 会被**确定性拒绝**。
   * 关掉它只保留协议要求（0.5.0 行为）。
   */
  requireMandate: z.boolean().default(true),

  /** 是否要求每次派发都带工单 id（`[ticket:t-N]` 或 specialist 的 ticket 参数）。 */
  requireTicket: z.boolean().default(true),

  // ------------------------------------------------- 共享任务板投影（1.2.0） ---

  /**
   * 是否把工单自动投影到 Agent Teams 共享任务板（B）。
   *
   * 只在部署里有 `agentTeams` 服务、且当前 agent 是 Team 成员时生效；否则所有投影
   * 都是 no-op，行为与 1.1.x 完全一致。
   */
  teamTaskProjection: z.boolean().default(true),

  /**
   * Team 通道（`spawn_teammate`）派发是否要求工单已有有效投影任务（D-1）。
   *
   * 没有 Agent Teams 时自动跳过；投影创建失败时拒绝会让派发卡住，所以可关掉。
   */
  requireTeamTask: z.boolean().default(true),

  /**
   * Team 通道派发是否要求 prompt 首行带 `[task:task-N]` 且与投影一致（D-2）。
   *
   * 默认关闭：投影已由插件自动建立，强制模型复述 task id 只会增加一轮重试。
   */
  requireTeamTaskMarker: z.boolean().default(false),

  /**
   * 一次性 specialist 是否**异步派发**（0.7.0 默认开）。
   *
   * 开启时工具立即返回 childId；结算时插件用 `agent.steer()` 发一条
   * 「【指挥者·派工完成】」通知唤醒指挥者（并写账本）。关掉回退 0.5.0 的前台阻塞行为。
   */
  asyncDelegation: z.boolean().default(true),

  /** 同一会话同时在飞的一次性 specialist 上限（1–16）。 */
  // 3.0.0：8 → 16。与运行时「子智能体」并行上限对齐（规则 2）；一次性 specialist 是
  // "单点交付"最快的通道，人为压低只会让独立工作流排队。
  maxAsyncTasks: z.number().step(1).min(1).max(16).default(16),

  // ---------------------------------------------------- Worker Session（0.8.0） ---

  /**
   * 是否启用 Worker Session（**1.0.0 起默认开启**）。
   *
   * 开启后每张工单可以开一个独立 DSH Session + 独立目录（`commander_worker_spawn`），
   * 结束时用 `commander_report` 汇报并唤醒指挥者。0.8.0 曾默认关闭（改变执行模型）；
   * 0.9.1 在真实 Web profile + 真实模型里跑通全链路后，1.0.0 起默认开启。
   * 不想要时在 profile patch 里显式写 `workerSessions: false` 回退到 0.7 的派工语义：
   * 不会出现 worker 会话，也不会注册四个 `commander_worker_*` 工具。
   */
  workerSessions: z.boolean().default(true),

  /** Worker 工作目录根；空 = `<DSH_HOME>/commander/work`。相对路径以 `DSH_HOME` 为基准。 */
  workRoot: z.string().default(''),

  /** 每个指挥者会话同时最多几个 Worker Session（1–12）。 */
  // 2.4.0：3 → 6。Worker Session 是每工单一个独立 Session，独立工单之间没有理由排队。
  maxWorkers: z.number().step(1).min(1).max(12).default(6),

  /** 建 worker 目录后执行一次的 prepare 命令（可选；可用 `DSH_COMMANDER_*` 环境变量）。 */
  prepareCommand: z.string().default(''),

  /** Worker Session 的权限预设（默认 danger-full-access；worker 目录不是安全边界）。 */
  workerPermission: z.string().default('danger-full-access'),

  /** 派发后超过多少毫秒没有新回报就算"疑似停滞"（写进看板，只提示不自动处理）。 */
  ticketStallMs: z.number().step(1).min(60_000).default(10 * 60 * 1000),

  /** 账本最多保留多少张工单（超出后裁剪最老的已结束工单）。 */
  maxTickets: z.number().step(1).min(1).default(100),

  // -------------------------------------------- 外部事件（1.1.0） ---

  /**
   * 是否启用外部事件投递（**默认开启**）。
   *
   * 外部系统往 `<stateDir>/events/inbox/` 写 JSON 事件，配置行轮询取走并 `steer` 对应
   * 指挥者会话（空闲会被唤醒）。关掉后轮询不启动、事件文件原样留在 inbox。
   * 它不创建会话/工单，也不替指挥者做决定。
   */
  eventInbox: z.boolean().default(true),

  /** 外部事件轮询间隔（ms；1.1.0 默认 15 秒，最小 1000）。 */
  eventPollMs: z.number().step(1).min(1000).max(600_000).default(15_000),

  // 3.1.0：`maxWaitMs` 已移除。用户 2026-11-11 补充要求「禁止等待子智能体、不设开关」，
  // 所以 `wait_agent` 对指挥官是硬禁用（`lib/guard.js` 的 `evaluateWaitForbidden()`），
  // 不存在任何配置项可以放开——2.0.0 的「等待上限门禁」整体下线。
});

// ---------------------------------------------------------------- 读取 ---

/** 取引用或普通值背后的真实值。 */
function liveValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

/**
 * 读当前名册（未经清洗，保持用户写入的原样）。
 *
 * @param {unknown} config - `apply` 收到的配置对象（字段可能是引用）。
 * @returns {object[]} 名册数组；不是数组时返回 `[]`。
 */
export function readSpecialists(config) {
  const value = liveValue(config?.specialists);
  return Array.isArray(value) ? value : [];
}

/**
 * 读名册条数上限。
 *
 * @param {unknown} config - `apply` 收到的配置对象。
 * @returns {number} 上限（非负整数，异常时 20）。
 */
export function readMaxSpecialists(config) {
  const value = liveValue(config?.maxSpecialists);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 20;
}

/**
 * 读一个布尔开关。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {boolean} fallback - 缺省值。
 * @returns {boolean} 开关值。
 */
export function readFlag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 读 `blockedTools`：非空字符串数组，去重保序；非法值退回默认清单。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {string[]} [fallback] - 回退清单。
 * @returns {{ tools: string[], warning: string | undefined }} 工具名与（可选的）解析警告。
 */
export function readBlockedTools(value, fallback = [...DEFAULT_BLOCKED_TOOLS]) {
  const live = liveValue(value);
  if (live === undefined || live === null) return { tools: fallback, warning: undefined };
  if (!Array.isArray(live)) return { tools: fallback, warning: `blockedTools 必须是字符串数组；已改用默认拦截清单` };
  const tools = [];
  for (const entry of live) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    if (!tools.includes(entry.trim())) tools.push(entry.trim());
  }
  return { tools, warning: undefined };
}

/**
 * 读 `maxTeammates`：夹到 1–16。
 *
 * @param {unknown} value - 引用或普通值。
 * @returns {number} 建议并行上限。
 */
export function readMaxTeammates(value) {
  const live = liveValue(value);
  // null 按"未配置"处理：手写 patch 里留空一行会得到 YAML null，而 Number(null) === 0
  // 会让协议静默变成"建议并行 1 个"，与 undefined/NaN 的默认值不一致。
  if (live === undefined || live === null) return 16;
  const number = typeof live === 'number' ? live : Number(live);
  if (!Number.isFinite(number)) return 16;
  return Math.min(16, Math.max(1, Math.round(number)));
}

/**
 * 已知的配置键（= `Config` 声明的全部字段）。
 *
 * schemastery 对未知键是**保留**而不是拒绝（实测：`Config({nope:1})` 的结果里仍有
 * `nope`），所以拼错的键会静默存在。这里显式列出来，让 `resolveConfig` 能把它报成
 * warning —— 配置拼错时"看起来没生效"是最难查的一类问题。
 */
export const KNOWN_CONFIG_KEYS = Object.freeze([
  'specialists',
  'maxSpecialists',
  'confirmPlan',
  'escalateOnConflict',
  'maxTeammates',
  'delegationHierarchy',
  'syncGuard',
  'blockedTools',
  'registerSkill',
  'ledger',
  'stateDir',
  'requireMandate',
  'requireTicket',
  'teamTaskProjection',
  'requireTeamTask',
  'requireTeamTaskMarker',
  'asyncDelegation',
  'maxAsyncTasks',
  'workerSessions',
  'workRoot',
  'maxWorkers',
  'prepareCommand',
  'workerPermission',
  'ticketStallMs',
  'maxTickets',
  'eventInbox',
  'eventPollMs',
]);

/**
 * 把配置解析成插件运行时使用的选项对象。
 *
 * 与 0.1.x 的区别：`specialists` 不再在这里清洗（它随设置页实时变化，见
 * `lib/specialists.js` 的 `resolveRoster()`），这里只给出稳定的加载期选项与警告。
 *
 * @param {unknown} raw - `apply` 收到的配置对象。
 * @returns {{ options: object, warnings: string[] }} 选项与非致命问题。
 */
export function resolveConfig(raw) {
  const warnings = [];
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    warnings.push(`config 必须是对象，实际是 ${typeof raw}；改用默认值`);
  }

  const unknown = Object.keys(config).filter((key) => !KNOWN_CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    warnings.push(`未知配置键 ${unknown.join(', ')} —— 已知键：${KNOWN_CONFIG_KEYS.join(', ')}`);
  }

  const blocked = readBlockedTools(config.blockedTools);
  if (blocked.warning !== undefined) warnings.push(blocked.warning);

  return {
    options: {
      confirmPlan: readFlag(liveValue(config.confirmPlan), true),
      escalateOnConflict: readFlag(liveValue(config.escalateOnConflict), true),
      registerSkill: readFlag(liveValue(config.registerSkill), true),
      syncGuard: readFlag(liveValue(config.syncGuard), true),
      maxTeammates: readMaxTeammates(config.maxTeammates),
      delegationHierarchy: readFlag(liveValue(config.delegationHierarchy), true),
      blockedTools: blocked.tools,
      maxSpecialists: readMaxSpecialists(config),
      ledger: readFlag(liveValue(config.ledger), true),
      stateDir: readString(config.stateDir, ''),
      requireMandate: readFlag(liveValue(config.requireMandate), true),
      requireTicket: readFlag(liveValue(config.requireTicket), true),
      teamTaskProjection: readFlag(liveValue(config.teamTaskProjection), true),
      requireTeamTask: readFlag(liveValue(config.requireTeamTask), true),
      requireTeamTaskMarker: readFlag(liveValue(config.requireTeamTaskMarker), false),
      asyncDelegation: readFlag(liveValue(config.asyncDelegation), true),
      maxAsyncTasks: readPositiveNumber(config.maxAsyncTasks, 16, 1),
      workerSessions: readFlag(liveValue(config.workerSessions), true),
      workRoot: readString(config.workRoot, ''),
      maxWorkers: readPositiveNumber(config.maxWorkers, 6, 1),
      prepareCommand: readString(config.prepareCommand, ''),
      workerPermission: readString(config.workerPermission, 'danger-full-access'),
      ticketStallMs: readPositiveNumber(config.ticketStallMs, 10 * 60 * 1000, 60_000),
      maxTickets: readPositiveNumber(config.maxTickets, 100, 1),
      eventInbox: readFlag(liveValue(config.eventInbox), true),
      eventPollMs: readPositiveNumber(config.eventPollMs, 15_000, 1000),
    },
    warnings,
  };
}

/**
 * 读字符串配置（空白按缺省值处理）。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {string} fallback - 缺省值。
 * @returns {string} 字符串。
 */
export function readString(value, fallback = '') {
  const live = liveValue(value);
  return typeof live === 'string' ? live.trim() : fallback;
}

/**
 * 读正数配置（夹到最小值）。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {number} fallback - 缺省值。
 * @param {number} minimum - 最小值。
 * @returns {number} 数值。
 */
export function readPositiveNumber(value, fallback, minimum) {
  const live = liveValue(value);
  const number = typeof live === 'number' ? live : Number(live);
  if (!Number.isFinite(number) || number < minimum) return fallback;
  return Math.round(number);
}

// 3.1.0：`readWaitCap()` 已删除。等待上限配置随「禁止等待子智能体、不设开关」整体下线，
// `wait_agent` 由 `lib/guard.js` 的 `evaluateWaitForbidden()` 无条件拒绝。
