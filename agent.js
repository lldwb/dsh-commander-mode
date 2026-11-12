/**
 * `dsh-commander-mode/agent` —— 「指挥者模式」的**模式行**（agent preset 子行）。
 *
 * ## 它是什么
 *
 * 一个按会话生效的 agent preset 子行，把该会话的 agent 变成**指挥者**：接到任务先分析
 * 与侦察（只读），然后规划与拆分，**停下来让用户确认计划**，再把执行派给子代理；
 * 自己不动手写文件、不跑命令，遇到分歧或不确定就回头问用户。
 *
 * ## 派发通道（7.0.0：指挥官只有一条）
 *
 * 1. **建小组长**（唯一通道）：`subagent` / `subagent_fork` 建人 + `send_message` 派活/续做
 *    + `team_task_*` 管板 + `list_agents` 读状态；`interrupt_agent` 纠偏。
 * 2. **小组长的通道**（L1→L2）：名册生成的 `subagent_<id>` 一次性专家、`workflow` 扇出、
 *    再开下级 —— 由**小组长自己**调用，指挥官调用会被硬门禁拒绝。
 *
 * 7.0.0 起 `workflow` / 名册一次性专家 / Worker Session 都不是指挥官的通道（用户硬要求
 * 「不能另辟蹊径开子智能体」，口径明确「连 Worker Session 一起禁」）。见 `lib/guard.js`
 * 的 `evaluateCommanderChannels()`。
 *
 * ## 本行不持有配置
 *
 * 配置在另一个行里：包根的 `index.js`（profile 顶层，行 id = `commander-mode` =
 * 设置命名空间）。原因见 `lib/settings-service.js` 的模块注释：preset 子行不在 Loader 的
 * entry 树里，声明在这一行上的 `Config` 设置页看不到。
 *
 * 所以本行通过 `commanderSettings` 服务读配置；**服务缺失时用默认值降级**（例如有人把
 * 这个出口当普通插件挂进别的 preset），绝不因为拿不到配置就不激活。
 *
 * ## 模式是怎么表达的
 *
 * 一段 system-prompt section，文本在**每次组装时重新计算**。协议每一步都在场；名册也实时
 * 读服务，所以设置页保存后，**新会话**立刻看到新的 specialist 工具。
 *
 * ## 边界说明（重要）
 *
 * 「指挥者不执行操作」有**两道**保障：协议（每轮重述）+ 门禁（`tools/pre-execute`
 * waterfall 确定性地拒绝 `write` / `edit` / `pwsh` / `bash` / `job_kill` /
 * `plugin_manager`，拒绝理由就是纠正指令）。
 *
 * ## 三层指挥链门禁（3.0.0）
 *
 * 在同一个 `tools/pre-execute` 上再加三条**只对指挥官**生效的门禁（`delegationHierarchy`
 * 可关）：`team_task_update` 的 claim/release/complete/reopen/set_dependencies、
 * `commander_ticket_update` 的六态回报、以及 `subagent_<id>` / `subagent` / `subagent_fork`
 * —— 它们都属于小组长。拒绝理由按 agent 实际可用的工具生成，读不到身份一律放行。
 * 判定逻辑在 `lib/guard.js`，这里只负责接线与顺序。
 *
 * ## 7.0.0：派发通道硬门禁（用户硬要求，不可配置、无开关）
 *
 * 用户 2026-11-12 原话：「不能出现这种另辟蹊径开子智能体的方法，需要把这种指挥官->小组长->
 * 小组长的手下 这种分发没问题」，口径明确「连 Worker Session 一起禁」。所以：
 *
 * - 指挥官的**唯一**派发通道是「建小组长」：`subagent` / `subagent_fork` 建人、
 *   `send_message` 派活/续做、`team_task_*` 管板、`list_agents` 读状态、`interrupt_agent` 纠偏；
 * - `workflow`、名册生成的一次性专家（`subagent_<id>`）、`commander_worker_*` 对指挥官
 *   **一律拒绝**（`evaluateCommanderChannels`，在层级门禁**之前无条件**执行，
 *   `delegationHierarchy: false` 也拦）；
 * - **不再注册**四个 `commander_worker_*` 工具（Worker Session 通道下线）；**7.0.1 起
 *   Worker Session 的实现代码已从仓库删除**（`lib/worker-tools.js` /
 *   `lib/worker-sessions.js`），账本里的历史 `execution` 字段仅按旧数据读出；
 * - 小组长 / 子智能体不受限：它们派自己的手下（含 `workflow` / 名册专家）是 L1→L2。
 *
 * 拒绝理由带「需要小组长 / 小组长失败」的恢复阶梯（建人 → 冷恢复 → 纠偏或换人接管 →
 * blocked 上报），并明确「任何一步都不许换通道」。
 *
 * ## 结算同步（0.4.0）
 *
 * 「任务完成了但任务板 / 计划清单 / 团队状态没同步」是长会话里最贵的一种失误：用户看到的
 * 进度是过期的。这里用两条**确定性**通道兜住，而不是只靠协议：
 *
 * - `systemPrompt.context`：每轮运行时上下文里的「指挥者·同步看板」，给出任务板 / 计划清单 /
 *   团队状态的实时快照，有未同步项时带纠正指令（**事前**）。
 * - `agent/turn-stopping`：回合即将结束仍有未同步项时注入一次提醒（**事后**，每回合一次）。
 *
 * 两条都只对指挥者生效；teammate 通过 `isDelegatedAgent` 排除。逻辑在 `lib/sync.js`。
 *
 * ## 工单与计划授权（0.6.0）
 *
 * 借鉴 Super-agent 原型的 Ticket / Mandate / Assignment / Report 形状，把"派活"变成有状态、
 * 可审计的工单：
 *
 * - 三个工单工具（`lib/ticket-tools.js`）读写配置行提供的 `commanderLedger` 服务；
 * - `tools/pre-execute` 在 `lib/guard.js` 的执行门禁之后再加一道**派发门禁**
 *   （`lib/dispatch-gate.js`）：没有计划授权 / 不带工单 / 旧授权工单 → 确定性拒绝；
 * - `tools/post-execute` 观测计划确认（记录 Mandate）、执行者 `STATUS:` 回报、派发结算；
 * - `systemPrompt.context` 追加「指挥者·工单看板」（`lib/tickets.js` 的纯函数渲染）。
 *
 * 所有新增能力都可配置关闭（`ledger:false` 回退 0.5.0 行为），失败一律降级为 warning。
 *
 * 同样是为了 teammate：preset scope 是共享的，所以在这个 scope 上注册的 prompt section
 * 也会进 teammate 的系统提示（实测 0.3.x 就是这样 —— 执行者被灌了整份"你不执行操作"）。
 * 0.4.0 起 section 的 text 按 agent 判定，子级一律返回空串：既省 token，也不再和它们的人设打架。
 *
 * 为什么不把工具从 preset 里裁掉：队友通过 `agentPresets.composeFrom()` 加入**父会话的
 * 同一个 preset scope**，裁剪会连它们一起废掉（per-child 的工具限制只能收紧、不能扩展）。
 * 而 specialist 走**独立 preset**（`lib/specialists.js`），根本看不到指挥者协议。
 *
 * @module dsh-commander-mode/agent
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BLOCKED_TOOLS,
  DELEGATION_TOOLS,
  agentToolNames,
  evaluateBoardWrite,
  evaluateCommanderChannels,
  evaluatePreExecute,
  evaluateTicketWrite,
  evaluateWaitForbidden,
  hasUsableDispatchChannel,
  isDelegatedAgent,
  isSpecialistDispatchTool,
} from './lib/guard.js';
import {
  evaluateDispatchGate,
  isNewWorkTool,
  sessionIdOf,
  ticketFromDispatchArgs,
} from './lib/dispatch-gate.js';
import { resolveConfig } from './lib/config.js';
import {
  COMMANDER_PROTOCOL,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  renderModeOpening,
} from './lib/protocol.js';
import { buildTicketTools } from './lib/ticket-tools.js';
import { createTeamBoardBridge, isProjectedTask } from './lib/team-board-bridge.js';
import { installSpecialist, outputText, MAX_RESULT_CHARS } from './lib/specialists.js';
import {
  findPlanQuestion,
  isPlanConfirmed,
  isTerminal,
  parseReportStatus,
  planHash,
  renderTicketBoard,
} from './lib/tickets.js';
import {
  DELEGATION_CHANNELS,
  SYNC_CONTEXT_NAME,
  SYNC_CONTEXT_ORDER,
  buildSyncNudge,
  consumeStaleNudge,
  createSyncLedger,
  evaluateSync,
  recordBoard,
  recordDelegation,
  recordPlan,
  renderSyncBoard,
} from './lib/sync.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'commander-mode-agent';

/**
 * 本行缺了就干不了活的服务：没有 `systemPrompt` 就没有模式本身。
 *
 * `commanderSettings` / `tools` / `subagents` / `agentPresets` / `skills` 都是**可选**的
 * （各自用 `ctx.inject` 接线），所以精简部署里模式照样成立，只是少一条通道。
 */
export const inject = ['systemPrompt'];

/**
 * prompt section 的落位：plan 策略（500）与 team 策略（600）之后、工具指导块之前。
 */
export const SECTION_ORDER = 650;

/** prompt section 名。 */
export const SECTION_NAME = 'commander:mode';

/**
 * 拿不到配置行服务时的默认选项。
 *
 * 用 `resolveConfig(undefined)` 而不是手抄一份，保证默认值与 schema 一致。
 */
export const FALLBACK_OPTIONS = Object.freeze(resolveConfig(undefined).options);

/**
 * 注册模式行。
 *
 * @param {object} ctx - Cordis 插件上下文（preset scope）。
 */
export function apply(ctx) {
  // ---------------------------------------------------------- 配置服务 ---

  /**
   * 取配置服务（可能晚到、也可能不存在）。
   *
   * @returns {object | undefined} `commanderSettings` 实例。
   */
  const readSettings = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('commanderSettings') : undefined;
    } catch {
      return undefined;
    }
  };

  /** 当前加载期选项（服务缺失时用默认值）。 */
  const readOptions = () => {
    try {
      return readSettings()?.options?.() ?? FALLBACK_OPTIONS;
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: 读取配置失败，改用默认值：%o', error);
      return FALLBACK_OPTIONS;
    }
  };

  /**
   * 已**成功安装**的 specialist 名册快照。
   *
   * 协议里点名工具之前必须先确认工具真的在：名册里有、但 preset/工具注册失败的条目必须
   * 被排除 —— 否则模型会照着协议去调一个不存在的工具，当场卡住。
   */
  let installedRoster = [];

  /**
   * 取一个可选服务（可能还没被别的行提供，也可能这个部署里根本没有）。
   *
   * @param {string} name - 服务名。
   * @returns {object | undefined} 服务实例。
   */
  const getService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * 工单 → 共享任务板的投影器（1.2.0 B）。
   *
   * 无状态；没有 Agent Teams 服务 / 当前 agent 不是成员时所有方法返回 undefined，
   * 行为与 1.1.x 完全一致。
   */
  const teamBridge = createTeamBoardBridge({ getService, logger: ctx.logger });

  /**
   * D 门禁用的任务板适配器：只有当前 agent 真的能用 Agent Teams 时才返回。
   *
   * @param {object | undefined} agent - 指挥者 agent。
   * @returns {{ getTask: (taskId: string) => object | undefined } | undefined} 适配器。
   */
  const teamBoardFor = (agent) => {
    if (agent === undefined || agent === null || teamBridge.available(agent) === undefined) return undefined;
    return { getTask: (taskId) => teamBridge.readTask(agent, taskId) };
  };

  /**
   * 是否启用投影（配置 `teamTaskProjection`，默认开）。
   *
   * @returns {boolean} 是否启用。
   */
  const projectionEnabled = () => {
    try {
      return readOptions().teamTaskProjection !== false;
    } catch {
      return true;
    }
  };

  /**
   * 把某张工单同步到共享任务板（尽力而为，失败只记日志）。
   *
   * 用在所有工单状态变化点：派发记账、后台结算、失败回报、worker 回报。
   * 工单工具（create/update）自己在工具层同步，不需要经过这里。
   *
   * @param {object} agent - 指挥者 agent。
   * @param {string} ticketId - 工单 id。
   * @returns {void}
   */
  const syncTicketMirror = (agent, ticketId) => {
    try {
      if (!projectionEnabled()) return;
      if (typeof ticketId !== 'string' || ticketId === '') return;
      const ledger = getLedger();
      const sessionId = sessionIdOf(agent);
      if (ledger === undefined || sessionId === undefined) return;
      const ticket = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
      if (ticket === null) return;
      void teamBridge.syncProjection(agent, ticket).then((projected) => {
        if (projected === undefined) return;
        const record = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
        if (record !== null && record.teamTaskId !== projected.taskId) {
          try {
            ledger.attachTeamTask(ticketId, sessionId, projected.taskId);
          } catch {
            // 映射写失败不影响投影本身；下次同步会重试。
          }
        }
      }).catch((error) => {
        ctx.logger?.debug?.('commander-mode: 同步共享任务板失败：%o', error);
      });
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 触发共享任务板同步失败：%o', error);
    }
  };

  // -------------------------------------------------- 结算同步（看板 + 兜底） ---

  //
  // 为什么需要这一块：长会话里任务板一直在动，而计划清单没人更新。实测一次三小时会话
  // （1111 个事件、3 个子代理）：`todo_write` 只调了 5 次，最后一次停在 +61 分钟，之后
  // 100 分钟里任务板完成/删除了 4 个任务，清单一次没动，直到用户亲口问「进度怎么不同步」。
  //
  // 协议只能降低概率，所以这里补两道确定性的：
  //
  // 1. **每轮运行时上下文**（`systemPrompt.context`）——把任务板 / 计划清单 / 团队状态
  //    的实时快照放在模型每一步都能读到的地方；有未同步项时直接给出纠正指令。这是"事前"。
  // 2. **回合结束兜底**（`agent/turn-stopping`）——回合要结束了还有未同步项时注入一条提醒，
  //    让模型在同一个回合里补完。这是"事后"。
  //
  // 两者都**只对指挥者本人**生效：teammate 走同一个 preset scope（`composeFrom`），所以
  // 必须用 `isDelegatedAgent` 区分，否则会给执行者注入"你该去同步任务板"的噪声。

  /** 每个 agent 一份同步账本；agent 是活对象，会话结束自然回收。 */
  const ledgers = new WeakMap();

  /**
   * 取（或创建）某个 agent 的同步账本。
   *
   * @param {object} agent - 活着的 agent。
   * @returns {object} 账本。
   */
  const ledgerOf = (agent) => {
    let ledger = ledgers.get(agent);
    if (ledger === undefined) {
      ledger = createSyncLedger();
      ledgers.set(agent, ledger);
    }
    return ledger;
  };

  /** 已经提醒过的回合（`sessionId:turn`）；只需要覆盖还可能在收尾的轮次。 */
  const nudgedTurns = new Set();

  /**
   * 团队成员的**缓存快照**（6.0.0）。
   *
   * DSH 0.2.2-rc.2 移除了同步的 `agentTeams.listMembers()` 名册 API：成员现在就是
   * subagent 树里的可续做子代理，唯一的读取入口是**异步**的
   * `ctx.subagents.listDescendants(rootSessionId)`。而同步看板是 `systemPrompt.context`
   * 的**同步**文本渲染，所以这里用「异步刷新 + 同步读缓存」：
   *
   * - `refreshTeamMembers()` 在异步位置（`tools/post-execute`）刷新快照；
   * - `readTeam()` 只读最近一份快照（没有就是空数组），并顺手触发一次后台刷新。
   *
   * 快照过期最多让看板少报一次"主人已停手"，不会给出错误结论（判定只会在证据充分时报）。
   */
  const teamMembers = new WeakMap();
  const TEAM_MEMBERS_MAX_AGE_MS = 15000;

  /** 触发一次后台刷新（同一 agent 不并发刷新）。 */
  const refreshingTeams = new WeakSet();

  /**
   * 异步刷新某个指挥者的团队成员快照。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {Promise<void>} 刷新完成（失败静默，按"未知"处理）。
   */
  const refreshTeamMembers = async (agent) => {
    const subagents = getService('subagents');
    if (subagents === undefined || typeof subagents.listDescendants !== 'function') return;
    if (refreshingTeams.has(agent)) return;
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) return;
    refreshingTeams.add(agent);
    try {
      const rows = await subagents.listDescendants(sessionId);
      const members = (Array.isArray(rows) ? rows : [])
        .filter((row) => row !== null && typeof row === 'object' && row.kind === 'child')
        .map((row) => ({
          // `list_agents` 的名字就是相对根的完整路径（`reviewer/checker`）；无名历史用 Session id。
          name: typeof row.path === 'string' && row.path !== '' ? row.path : String(row.id ?? ''),
          status: row.activity === 'running' ? 'running' : 'inactive',
          role: 'member',
          depth: typeof row.depth === 'number' ? row.depth : 1,
        }));
      teamMembers.set(agent, { members, at: Date.now() });
    } catch (error) {
      // 读不到名册按"未知"处理：同步判定只会在证据充分时报警，绝不因为读不到就拦人。
      ctx.logger?.debug?.('commander-mode: 读取 subagent 成员快照失败（按未知处理）：%o', error);
    } finally {
      refreshingTeams.delete(agent);
    }
  };

  /**
   * 读团队视图（任务板 + 成员快照）。
   *
   * 读不到一律返回 `undefined`（"未知"），让同步判定跳过而不是误报。
   *
   * 6.0.0：`agentTeams` 的成员/名册 API 已被 rc.2 移除，成员改读 subagent 树快照；
   * Team 模式由本插件强制开启，所以这里用 `isEnabled(agent)` 判断任务板是否可用。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {{ tasks: object[], members: object[] } | undefined} 团队视图。
   */
  const readTeam = (agent) => {
    const service = getService('agentTeams');
    if (service === undefined) return undefined;
    try {
      // 任务板只在 Team 模式开启时可用（本模式下恒为开启；读不到按"未开启"处理）。
      if (typeof service.isEnabled === 'function' && service.isEnabled(agent) !== true) return undefined;
      const tasks = typeof service.listTasks === 'function' ? service.listTasks(agent) : [];
      const allTasks = Array.isArray(tasks) ? tasks : [];
      // 成员快照：读缓存 + 触发后台刷新（同步文本渲染不能 await）。
      const cached = teamMembers.get(agent);
      if (cached === undefined || Date.now() - cached.at > TEAM_MEMBERS_MAX_AGE_MS) {
        void refreshTeamMembers(agent);
      }
      return {
        tasks: allTasks,
        // 1.2.0：投影任务（`[commander:ticket=...]`）由工单看板负责，同步看板只看"真正的团队任务"，
        // 否则投影的 specialist 工单会被误判成孤儿任务 / 团队闲置。
        nativeTasks: allTasks.filter((task) => !isProjectedTask(task)),
        members: Array.isArray(cached?.members) ? cached.members : [],
      };
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 读取团队状态失败（按未知处理）：%o', error);
      return undefined;
    }
  };

  /**
   * 同步能力的运行时开关：配置开启**且**这个部署里真有团队服务。
   *
   * @returns {boolean} 是否提供「指挥者·同步看板」。
   */
  const syncBoardEnabled = () => {
    try {
      return readOptions().syncGuard !== false && getService('agentTeams') !== undefined;
    } catch {
      return false;
    }
  };

  /**
   * 观测一次同步状态：读团队视图 → 更新账本 → 给出视图。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {{ view: object, members: object[] }} 视图与成员（读不到团队时 members 为空）。
   */
  const inspectSync = (agent) => {
    const ledger = ledgerOf(agent);
    const team = readTeam(agent);
    const now = Date.now();
    if (team !== undefined) recordBoard(ledger, team.nativeTasks, now);
    return { ledger, view: evaluateSync(ledger, { members: team?.members ?? [], now }), members: team?.members ?? [] };
  };

  /**
   * Team 通道的**派活**动作（`wait_agent` / `list_agents` 不算派活，它们是等待与读状态）。
   *
   * 6.0.0：Team 成员就是标准 subagent —— 建小组长是 `subagent` / `subagent_fork`，
   * 续做是 `send_message`（旧 Team 的 `spawn_teammate` 已随 DSH 0.2.2-rc.2 移除）。
   */
  const TEAM_DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'send_message']);
  /** 一次性派活动作：`workflow`（`subagent_<id>` 由前缀识别）。 */
  const ONE_SHOT_DISPATCH_TOOLS = new Set(['workflow']);

  /**
   * 判断一次工具调用是哪条派发通道。
   *
   * @param {string} toolName - 工具名。
   * @returns {string | undefined} `'team'` / `'one-shot'`；不是派活动作时 undefined。
   */
  const classifyDelegation = (toolName) => {
    if (TEAM_DISPATCH_TOOLS.has(toolName)) return DELEGATION_CHANNELS.TEAM;
    if (ONE_SHOT_DISPATCH_TOOLS.has(toolName)) return DELEGATION_CHANNELS.ONE_SHOT;
    if (toolName.startsWith('subagent_')) return DELEGATION_CHANNELS.ONE_SHOT;
    return undefined;
  };

  /**
   * 取工单账本服务（配置行提供；可能因配置关闭或初始化失败而缺失）。
   *
   * @returns {object | undefined} `commanderLedger` 实例。
   */
  const getLedger = () => getService('commanderLedger');

  // ------------------------------------------------------ 异步派工（0.7.0） ---

  /** 异步 activation 的生命周期 signal（与工具调用脱钩；作用域销毁时中止）。 */
  const asyncController = new AbortController();
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try {
          asyncController.abort(new Error('commander-mode scope disposed'));
        } catch {
          // 已中止不影响释放。
        }
      }, 'commander-mode: async delegation lifetime');
    }
  } catch {
    // 没有 effect 的宿主：最多是作用域销毁时 child 继续跑，不影响正常路径。
  }

  /**
   * 在飞异步派发：childId → 元数据。
   *
   * 只用于**展示与上限**；真正的状态写在账本里（工单 Assignment）。进程重启后这里清空，
   * 但工单仍会以"派发后没有新回报"出现在看板（停滞检测兜底）。
   */
  const inFlight = new Map();

  /** 某会话在飞数量。 */
  const asyncCount = (sessionId) => {
    let count = 0;
    for (const entry of inFlight.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  };

  /**
   * 异步容量理由：超过 `maxAsyncTasks` 时拒绝（在启动前调用，避免先记 Assignment）。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {string | undefined} 拒绝理由。
   */
  const asyncCapacityReason = (agent) => {
    try {
      const sessionId = sessionIdOf(agent);
      if (sessionId === undefined) return undefined;
      const limit = Number(readOptions().maxAsyncTasks);
      // 3.0.0：兜底与 schema 默认一致（16）。2.x 这里是 4 的残留常量。
      const max = Number.isSafeInteger(limit) && limit >= 1 ? limit : 16;
      if (asyncCount(sessionId) < max) return undefined;
      return [
        `指挥者模式：在飞的一次性派发已达上限（${max} 个）。`,
        '不要重复派同一任务；等完成通知，或把多阶段/长任务改用 Team 通道（subagent）——它是常驻队友，不受这个上限限制。',
      ].join('\n');
    } catch {
      return undefined;
    }
  };

  /**
   * 用一条运行时通知唤醒指挥者（异步完成 / 失败时）。
   *
   * 用 `agent.steer()`（不是 inject）：steer 会**唤醒**空闲 agent，inject 只写历史。
   * 消息形状与原型 `src/app/delivery.ts` 对齐：id + user role + source。
   *
   * @param {object} agent - 指挥者 agent。
   * @param {string} text - 通知正文。
   * @param {string} summary - 一行摘要（UI/inbox 用）。
   * @returns {boolean} 是否投递成功。
   */
  const steerCommander = (agent, text, summary) => {
    try {
      if (agent === null || typeof agent !== 'object' || typeof agent.steer !== 'function') return false;
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-commander-mode', form: 'notice', summary },
      });
      return true;
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: 投递异步完成通知失败（会话可能已关闭）：%o', error);
      return false;
    }
  };

  /**
   * 异步派发启动成功：登记在飞，并挂后台结算处理。
   *
   * @param {object} info - 参数。
   * @param {object} info.agent - 指挥者 agent（发起派发者）。
   * @param {string} info.childId - 子会话 id。
   * @param {string} info.ticketId - 工单 id（可为空串）。
   * @param {string} info.toolName - 工具名。
   * @param {string} info.specialistId - specialist id。
   * @param {Promise<object>} info.result - activation 的结算 Promise。
   * @returns {void}
   */
  const asyncStarted = ({ agent, childId, ticketId, toolName, specialistId, result }) => {
    const sessionId = sessionIdOf(agent);
    if (sessionId === undefined) throw new Error('无法定位指挥者会话（agent.session.id 为空）');
    const entry = { agent, sessionId, childId, ticketId, toolName, specialistId, startedAt: Date.now() };
    inFlight.set(childId, entry);
    ctx.logger?.info?.('commander-mode: 异步派发已启动 %s（%s，工单 %s）', childId, specialistId, ticketId || '无');
    Promise.resolve(result).then(
      (settled) => asyncCompleted(entry, settled),
      (error) => asyncFailed(entry, error),
    );
  };

  /** 清理在飞记录（幂等）。 */
  const finishInFlight = (entry) => {
    if (entry?.childId !== undefined && inFlight.get(entry.childId) === entry) inFlight.delete(entry.childId);
  };

  /** 把结算文本压成通知里的摘要（截断到预算）。 */
  const settleTextOf = (settled) => {
    let text = outputText(settled?.output).trim();
    if (text === '') {
      const reason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'unknown';
      text = reason === 'completed' ? '（子代理没有留下收尾文本）' : `（没有收尾文本；停止原因：${reason}）`;
    }
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（已截断，原始 ${text.length} 字符）`;
    return text;
  };

  /**
   * 异步结算成功：写账本 + 唤醒指挥者。
   *
   * @param {object} entry - 在飞记录。
   * @param {object} settled - activation 结算结果。
   * @returns {void}
   */
  const asyncCompleted = (entry, settled) => {
    try {
      finishInFlight(entry);
      const text = settleTextOf(settled);
      const stopReason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'unknown';
      const parsed = parseReportStatus(text);
      const ledger = getLedger();
      if (ledger !== undefined && entry.ticketId !== '') {
        try {
          ledger.markAssignmentSettled(entry.ticketId, entry.sessionId, entry.childId);
          ledger.recordReport(entry.ticketId, entry.sessionId, {
            status: parsed?.status ?? 'progress',
            summary: parsed === undefined
              ? `异步执行者结算但未按约定给出 STATUS 行；结果见会话。${text.slice(0, 400)}`
              : text.slice(0, 2000),
          });
          // 1.2.0 B：异步结算也同步共享任务板。
          syncTicketMirror(entry.agent, entry.ticketId);
        } catch (error) {
          ctx.logger?.debug?.('commander-mode: 写异步结算到账本失败：%o', error);
        }
      }
      const statusLine = parsed === undefined ? '未给出 STATUS 行' : `STATUS: ${parsed.status}`;
      const ticketLine = entry.ticketId === '' ? '工单：无' : `工单：${entry.ticketId}`;
      const notice = [
        `【指挥者·派工完成】${entry.toolName} 已结算（child ${entry.childId}，stopReason ${stopReason}）。`,
        `${ticketLine}；${statusLine}。`,
        '',
        text,
        '',
        '下一步：核对产物与验收判据 → 用 `commander_ticket_update` 更新工单；'
          + '需要用户决策就 `ask_user_question`；不要用 `wait_agent` / `list_agents` 轮询。',
      ].join('\n');
      steerCommander(entry.agent, notice, `派工完成：${entry.toolName}`);
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: 处理异步结算失败：%o', error);
    }
  };

  /**
   * 异步结算失败：记 failed（若挂了工单）+ 唤醒指挥者。
   *
   * @param {object} entry - 在飞记录。
   * @param {unknown} error - 错误。
   * @returns {void}
   */
  const asyncFailed = (entry, error) => {
    try {
      finishInFlight(entry);
      const message = error instanceof Error ? error.message : String(error);
      const ledger = getLedger();
      if (ledger !== undefined && entry.ticketId !== '') {
        try {
          ledger.markAssignmentSettled(entry.ticketId, entry.sessionId, entry.childId);
          ledger.recordReport(entry.ticketId, entry.sessionId, {
            status: 'failed',
            summary: `异步执行者结算失败：${message}`,
            question: '这个任务接下来怎么办：重派、改派，还是先看产物？',
          });
          syncTicketMirror(entry.agent, entry.ticketId);
        } catch (ledgerError) {
          ctx.logger?.debug?.('commander-mode: 写异步失败到账本失败：%o', ledgerError);
        }
      }
      steerCommander(
        entry.agent,
        [
          `【指挥者·派工完成】${entry.toolName} 异步结算**失败**（child ${entry.childId}）。`,
          `工单：${entry.ticketId === '' ? '无' : entry.ticketId}；错误：${message}`,
          '',
          '下一步：先只读核对产物；能继续就补派，需要用户决定就用 `ask_user_question` 上报。不要重复派同一任务。',
        ].join('\n'),
        `派工失败：${entry.toolName}`,
      );
    } catch (error_) {
      ctx.logger?.warn?.('commander-mode: 处理异步失败通知时出错：%o', error_);
    }
  };

  /**
   * 计划确认 → 记录 Mandate（0.6.0 的授权来源）。
   *
   * 只认**显式确认**：`ask_user_question` 里问题 id 必须是 `commander-plan`，答案的
   * `selected` 必须精确包含「确认，开始执行」（或用户自定义答案以"确认"开头）。
   * 其余情况（跳过、选"需要调整"、自定义否定）都不授权。
   *
   * @param {object} exec - `tools/post-execute` 的执行上下文。
   * @param {object} result - 工具结果（`{ isError, value, content }`）。
   * @returns {void}
   */
  const observePlanConfirmation = (exec, result) => {
    try {
      if (exec?.name !== 'ask_user_question' || result?.isError === true) return;
      const question = findPlanQuestion(exec.arguments);
      if (question === undefined) return;
      const sessionId = sessionIdOf(exec.agent);
      const ledger = getLedger();
      if (sessionId === undefined || ledger === undefined) return;
      const { confirmed } = isPlanConfirmed(question, result?.value);
      if (!confirmed) {
        ctx.logger?.info?.('commander-mode: 计划确认未通过（用户未选择「确认，开始执行」），不记录授权');
        return;
      }
      const mandate = ledger.recordMandate({
        sessionId,
        planHash: planHash(question),
        planSummary: typeof question.question === 'string' ? question.question : '',
      });
      ctx.logger?.info?.('commander-mode: 已记录计划授权 %s（会话 %s）', mandate.id, sessionId);
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 记录计划授权失败：%o', error);
    }
  };

  /**
   * 从工具返回值里尽力提取文本（不同通道返回形状不同）。
   *
   * @param {unknown} value - 工具返回值。
   * @returns {string} 文本。
   */
  const extractText = (value) => {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.result === 'string') return value.result;
    if (typeof value.output === 'string') return value.output;
    if (Array.isArray(value.content)) {
      return value.content
        .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
        .join('\n');
    }
    return '';
  };

  /**
   * 执行者结算 → 解析 `STATUS:` 行并更新工单（0.6.0 的结构化回报）。
   *
   * 7.0.1 起从 `observeWorkerReport` 改名：它从来不是 Worker Session 的逻辑，而是解析
   * **同步结算通道**（名册一次性专家 / workflow）工具返回值里的 `STATUS:` 行。旧名字容易
   * 让人以为与 Worker Session 有关（Worker 实现已在 7.0.1 删除）。
   *
   * @param {object} exec - `tools/post-execute` 的执行上下文。
   * @param {object} result - 工具结果。
   * @returns {void}
   */
  const observeOneShotSettlement = (exec, result) => {
    try {
      // 异步受理结果不是"结算"：真正的回报在 asyncCompleted 里记录（带 childId/ticket）。
      if (result?.value?.async === true) return;
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      // 6.0.0：`subagent` / `subagent_fork` 是**后台 activation**——工具立即返回
      // `{ kind:'activation', name }`，小组长的结算结果由运行时完成通知送达，不是工具返回值。
      // 所以"从工具结果里解析 STATUS 回报"只适用于同步结算的通道：名册一次性专家与 workflow。
      // ⚠️ 用 isSpecialistDispatchTool() 而不是 startsWith('subagent_')：`subagent_fork`
      // 也以该前缀开头，但它是 Team 通道的建人工具（后台 activation），不是一次性专家。
      //
      // 7.0.0：名册一次性专家与 workflow 对**指挥官**已被硬门禁关闭
      // （`evaluateCommanderChannels`），所以本观察器对新会话不再触发。保留它是为了
      // **兼容旧账本数据**：升级前已在飞的派发 / 旧会话的回报仍需能被记账。
      const isSpecialist = isSpecialistDispatchTool(toolName);
      const isWorkflow = toolName === 'workflow';
      if (!isSpecialist && !isWorkflow) return;
      if (result?.isError === true) return;
      const ticketId = ticketFromDispatchArgs(exec.arguments);
      if (ticketId === undefined) return;
      const sessionId = sessionIdOf(exec.agent);
      const ledger = getLedger();
      if (sessionId === undefined || ledger === undefined) return;
      const text = extractText(result?.value);
      const parsed = parseReportStatus(text);
      if (parsed !== undefined) {
        ledger.recordReport(ticketId, sessionId, { status: parsed.status, summary: parsed.summary });
      } else {
        // 没有结构化回报：如实记一条 progress，并在摘要里点名"格式缺失"，让看板/下一轮知道
        // 这次结算没有可解析的状态，而不是假装它 ready。
        ledger.recordReport(ticketId, sessionId, {
          status: 'progress',
          summary: `执行者结算但未按约定给出 STATUS 行；结果见会话。${text.slice(0, 400)}`,
        });
      }
      // 1.2.0 B：回报状态同步到共享任务板。
      syncTicketMirror(exec.agent, ticketId);
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 记录执行者回报失败：%o', error);
    }
  };

  /**
   * 派发工具结算 → 补写 Assignment 的执行者引用（childId / teammate 名）。
   *
   * @param {object} exec - `tools/post-execute` 的执行上下文。
   * @param {object} result - 工具结果。
   * @returns {void}
   */
  const settleObservedDispatch = (exec, result) => {
    try {
      // 异步受理时 Assignment 才刚开始，结算要等 asyncCompleted（否则看板会立刻显示"已结算"）。
      if (result?.value?.async === true) return;
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      if (!isNewWorkTool(toolName) || result?.isError === true) return;
      const ticketId = ticketFromDispatchArgs(exec.arguments);
      if (ticketId === undefined) return;
      const sessionId = sessionIdOf(exec.agent);
      const ledger = getLedger();
      if (sessionId === undefined || ledger === undefined) return;
      const value = result?.value;
      // 6.0.0：`subagent` / `subagent_fork` 的返回值是 `{ kind: 'activation', name }`
      // （rc.2 的 `tool-subagent` schema）——`name` 就是 `list_agents` 里那个可寻址名字，
      // 也是 `send_message({ agent })` 的目标。旧 Team 的 `{ member: { target } }` 已移除。
      const memberName = typeof value?.name === 'string' && value.name !== '' ? value.name : undefined;
      const ref = typeof value?.childId === 'string'
        ? value.childId
        : typeof value?.sessionId === 'string'
          ? value.sessionId
          : typeof value?.name === 'string'
            ? value.name
            : undefined;
      ledger.markAssignmentSettled(ticketId, sessionId, ref);
      // 1.2.0 D：Team 通道建人后把投影任务的 owner 自动绑到这个小组长（"建板必有主"）。
      if ((toolName === 'subagent' || toolName === 'subagent_fork') && memberName !== undefined && projectionEnabled()) {
        const record = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
        if (record !== null) {
          void teamBridge.bindOwner(exec.agent, record, memberName).then((bound) => {
            if (bound === undefined) return;
            syncTicketMirror(exec.agent, ticketId);
          }).catch((error) => {
            ctx.logger?.debug?.('commander-mode: 自动绑定任务 owner 失败：%o', error);
          });
        }
      }
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 结算工单派发失败：%o', error);
    }
  };

  /**
   * 派发工具**报错** → 把工单从"working 幽灵"里拉回来：结算 Assignment 并记 failed。
   *
   * 0.8.0 E2E 抓到的真实问题：一个派发工具已记录 Assignment 后报错（当时的现场是
   * Worker Session 缺宿主服务；Worker 实现已在 7.0.1 删除），工单看板一直显示 `working`，
   * 但根本没有执行者。这里在 post-execute 兜住：
   * 有未结算 Assignment、且没有比它更新的 Report 时，记 `failed` + 一个待用户决定的问题。
   *
   * @param {object} exec - `tools/post-execute` 的执行上下文。
   * @param {object} result - 工具结果。
   * @returns {void}
   */
  const reportDispatchFailure = (exec, result) => {
    try {
      if (result?.isError !== true) return;
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      if (!isNewWorkTool(toolName)) return;
      const ticketId = ticketFromDispatchArgs(exec.arguments);
      if (ticketId === undefined) return;
      const sessionId = sessionIdOf(exec.agent);
      const ledger = getLedger();
      if (sessionId === undefined || ledger === undefined) return;
      const ticket = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
      if (ticket === null || isTerminal(ticket) || ticket.assignments.length === 0) return;
      const last = ticket.assignments[ticket.assignments.length - 1];
      if (last.endedAt !== null) return;
      const reportedAt = ticket.lastReport?.at ?? 0;
      if (reportedAt >= (last.startedAt ?? 0)) return; // 已有更新的回报，不覆盖
      const raw = result?.error?.message ?? extractText(result);
      const message = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 500) || '工具报错（无错误文本）';
      ledger.markAssignmentSettled(ticketId, sessionId);
      ledger.recordReport(ticketId, sessionId, {
        status: 'failed',
        summary: `派发失败（${toolName}）：${message}`,
        question: '这一步要重试、换一个小组长重派，还是先核对产物？',
      });
      syncTicketMirror(exec.agent, ticketId);
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 记录派发失败状态失败：%o', error);
    }
  };

  /**
   * 渲染本会话的工单看板（无内容时返回空串）。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {string} 看板文本。
   */
  const renderLedgerBoard = (agent) => {
    try {
      if (!ledgerEnabled()) return '';
      const ledger = getLedger();
      const sessionId = sessionIdOf(agent);
      if (ledger === undefined || sessionId === undefined) return '';
      const options = readOptions();
      return renderTicketBoard({
        tickets: ledger.listTickets(sessionId),
        mandate: ledger.activeMandate(sessionId),
        now: Date.now(),
        stallMs: options.ticketStallMs,
      });
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 渲染工单看板失败：%o', error);
      return '';
    }
  };

  /**
   * 这次配置是否启用了工单账本。
   *
   * @returns {boolean} 是否启用。
   */
  const ledgerEnabled = () => {
    try {
      return readOptions().ledger !== false;
    } catch {
      return true;
    }
  };

  /**
   * 把一次派发记到工单上（尽力而为：账本写失败不影响派发本身）。
   *
   * @param {object} exec - `tools/pre-execute` 的执行上下文。
   * @returns {void}
   */
  const observeAssignment = (exec) => {
    if (!ledgerEnabled()) return;
    try {
      const agent = exec?.agent;
      if (agent === undefined || isDelegatedAgent(agent)) return;
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      if (!isNewWorkTool(toolName)) return;
      const ticketId = ticketFromDispatchArgs(exec.arguments);
      if (ticketId === undefined) return; // 门禁关闭/降级时允许无工单派发，这里不记账。
      const sessionId = sessionIdOf(agent);
      const ledger = getLedger();
      if (sessionId === undefined || ledger === undefined) return;
      // 7.0.1：`worker` 通道随 Worker Session 实现一起删除（历史工单里可能还有该 channel，
      // 读取侧由 `lib/ledger.js` / `lib/team-board-bridge.js` 的兼容分支处理）。
      const channel = isSpecialistDispatchTool(toolName)
        ? 'specialist'
        : classifyDelegation(toolName) === DELEGATION_CHANNELS.TEAM ? 'team' : 'one-shot';
      ledger.recordAssignment(ticketId, sessionId, { channel, toolName });
      // 1.2.0 B：工单进入"已派发"状态后同步投影（板上能看到它在跑）。
      syncTicketMirror(agent, ticketId);
    } catch (error) {
      // 记账失败不能影响派发；门禁已经单独校验过授权。
      ctx.logger?.debug?.('commander-mode: 记录工单派发失败：%o', error);
    }
  };

  /**
   * 观测一次派发（只统计指挥者自己的派活动作）。
   *
   * @param {object} exec - `tools/pre-execute` 的执行上下文。
   * @returns {void}
   */
  const observeDelegation = (exec) => {
    try {
      const agent = exec?.agent;
      if (agent === undefined || isDelegatedAgent(agent)) return;
      if (readOptions().syncGuard === false) return;
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      const kind = classifyDelegation(toolName);
      if (kind === undefined) return;
      recordDelegation(ledgerOf(agent), kind, toolName);
    } catch (error) {
      // 观测失败不影响派活本身。
      ctx.logger?.debug?.('commander-mode: 记录派发通道失败：%o', error);
    }
  };

  // ---------------------------------------------------------------- 提示词 ---

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        // 0.4.0 修复：teammate / specialist 与指挥者共用同一个 preset scope，也会被问到
        // 这份 section。此前它们会收到完整的「指挥者模式」协议（"你不执行操作"），
        // 既浪费每个请求约 4 KB，又和它们自己的执行者人设冲突。子级一律返回空串。
        const agent = context?.agent;
        if (agent !== undefined && isDelegatedAgent(agent)) return '';
        return renderModeOpening({
          ...readOptions(),
          specialists: installedRoster,
          hasSpecialistTools: installedRoster.length > 0,
          syncBoard: syncBoardEnabled(),
          // 1.2.0：Agent Teams 可用时，协议里补一段"共享任务板是工单投影"的说明。
          teamBoard: teamBridge.available(agent) !== undefined,
          // 6.0.0：Team 是 base 自带、且本模式强制开启 —— 不再有"这个部署没有 Team"的
          // 降级形态（旧的 hasTeamTools 探测已删除；rc.2 里 `subagent` / `send_message` /
          // `team_task_*` 恒在）。
        });
      } catch (error) {
        // prompt section 抛错会让该会话的每一步都失败，所以渲染失败就退化成
        // 「模式关闭」，而不是把会话弄挂。
        ctx.logger?.warn?.('commander-mode: 渲染 prompt section 失败：%o', error);
        return '';
      }
    },
  });

  // ------------------------------------------------------------ 同步看板 ---

  // `systemPrompt.context` 是**每轮**下发的运行时上下文（与用户请求同一条消息），
  // 实测比 section 的遵从率高得多；这里用它把"当前有没有未同步项"放在模型眼前。
  if (typeof ctx.systemPrompt.context === 'function') {
    ctx.systemPrompt.context({
      name: SYNC_CONTEXT_NAME,
      order: SYNC_CONTEXT_ORDER,
      text: (context) => {
        try {
          const agent = context?.agent;
          if (agent === undefined || isDelegatedAgent(agent)) return '';
          const parts = [];
          if (syncBoardEnabled()) {
            const { view, members } = inspectSync(agent);
            const syncText = renderSyncBoard(view, members);
            if (syncText !== '') parts.push(syncText);
          }
          // 0.6.0：工单看板（计划授权 / 进行中 / 待人工 / 停滞）独立于同步看板 ——
          // 即使部署里没有「智能体团队」，工单状态也照样要出现在每一步。
          const ticketText = renderLedgerBoard(agent);
          if (ticketText !== '') parts.push(ticketText);
          return parts.join('\n');
        } catch (error) {
          // 运行时上下文抛错会让每个请求都失败；读不到就当没有可报的。
          ctx.logger?.warn?.('commander-mode: 渲染看板失败：%o', error);
          return '';
        }
      },
    });
  }

  // 计划清单只在 `todo_write` 成功之后才算更新（整表替换语义）。记它的作用有两个：
  // ① 判断"任务结算之后计划清单有没有更新过"；② 看板里给出清单的完成进度。
  ctx.on('tools/post-execute', (exec, _result, next) => {
    try {
      const agent = exec?.agent;
      if (agent !== undefined && !isDelegatedAgent(agent) && ledgerEnabled()) {
        observePlanConfirmation(exec, _result);
        observeOneShotSettlement(exec, _result);
        settleObservedDispatch(exec, _result);
        reportDispatchFailure(exec, _result);
      }
      // 6.0.0：成员名册只能异步读（`ctx.subagents.listDescendants`），这里在异步位置刷新
      // 同步看板用的快照 —— 工具调用之后正是团队状态最容易变化的时候。
      if (agent !== undefined && !isDelegatedAgent(agent) && syncBoardEnabled()) {
        void refreshTeamMembers(agent);
      }
      if (exec?.name === 'todo_write') {
        const agent = exec.agent;
        if (agent !== undefined && !isDelegatedAgent(agent) && readOptions().syncGuard !== false) {
          const todos = exec.arguments?.todos;
          if (Array.isArray(todos)) {
            const ledger = ledgerOf(agent);
            // ⚠️ 顺序陷阱：模型可能在**同一步**里"先 task_update 结算、再 todo_write 同步"。
            // 任务板的变化要等到下一次求值（看板/兜底）才会被账本观测到；如果只在那一刻
            // 算 epoch，这次已经完全同步的写入会被误判成"清单落后于结算"。
            // 所以写清单时先把**当时真实的板**记成新基线：它代表"这次同步之后"的状态。
            const team = readTeam(agent);
            if (team !== undefined) recordBoard(ledger, team.nativeTasks, Date.now());
            recordPlan(ledger, todos);
          }
        }
      }
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 记录计划清单失败：%o', error);
    }
    return typeof next === 'function' ? next() : undefined;
  });

  // 回合要结束了、结算却还没同步 → 在同一个回合里补一次提醒（每回合最多一次）。
  // 这是"事后"的兜底：正常情况下运行时时上下文里的同步看板已经让模型在回复前就同步完。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent;
      if (agent === undefined || isDelegatedAgent(agent)) return;
      if (payload?.signal?.aborted === true) return;
      if (readOptions().syncGuard === false) return;
      if (!syncBoardEnabled()) return;
      if (typeof agent.inject !== 'function') return;

      const turn = payload?.turn;
      const key = `${String(agent.session?.id ?? agent.id)}:${String(turn)}`;
      if (nudgedTurns.has(key)) return; // 同一回合只兜一次，否则会死循环

      const { ledger, view } = inspectSync(agent);
      // 孤儿任务（未结算 + 无人认领/主人已停手）每条会话强制提醒一次；之后它仍会留在
      // 每一步的看板里，但不该每回合都用注入拦人。
      const text = buildSyncNudge(view, { includeStale: consumeStaleNudge(ledger, view) });
      if (text === '') return;

      // 账本只需要覆盖那些还可能正在收尾的轮次。
      if (nudgedTurns.size > 256) nudgedTurns.clear();
      nudgedTurns.add(key);

      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        // 不是 `kind: 'user'`：这是插件提醒，不是用户发言（技能手势扫描只读真正的用户输入）。
        source: { kind: 'dsh-commander-mode', form: 'notice', summary: '结算同步提醒' },
      });
      ctx.logger?.info?.('commander-mode: 结算未同步，已注入一次兜底提醒（turn=%s）', String(turn));
    } catch (error) {
      // 兜底钩子自己出错绝不能把回合弄挂 —— 最坏情况是少一次提醒。
      ctx.logger?.warn?.('commander-mode: 结算同步兜底失败：%o', error);
    }
  });

  // ---------------------------------------------------------------- 门禁 ---

  /**
   * 该 agent 实际能用的工具名，以及其中有没有"把活派出去"的通道。
   *
   * 读 `agent.ctx.tools.schemas()` —— 在 agent 自己的作用域里求值，所以能看见 agent
   * 作用域注册的工具（Team 工具不在 preset scope 的视图里）。
   *
   * 读不到时返回 `undefined`（未知），判定按"有"处理；读到空视图同样当作"读不到"——
   * 0.1.x 的教训：`dsh-web-app` 把能力行全局禁用、工具在 preset 层，空视图被当成事实会
   * 让门禁整个失效。
   *
   * specialist 工具名是动态的（`subagent_<id>`），这里按前缀识别：只要工具视图里有
   * `subagent_*`，它就有派发通道 —— 不看配置名册，因为"配置里有"不等于"这个会话里有"。
   */
  const inspectAgentTools = (agent) => {
    const availableTools = agentToolNames(agent);
    if (availableTools === undefined) return { availableTools, canDelegate: undefined };
    // 3.4.0：不能只看"视图里有"——用户可能把派发工具写进 `blockedTools`。
    // 7.0.0：指挥官的通道只剩建小组长（`subagent` / `subagent_fork` / `send_message`）；
    // `workflow` / 名册专家 / Worker Session 都是硬门禁拒绝，不算通道（否则会误判死锁）。
    let blocked = [];
    try {
      const options = readOptions();
      blocked = Array.isArray(options.blockedTools) ? options.blockedTools : [];
    } catch {
      // 读不到配置时按默认（有派活通道）处理，宁可漏拦。
    }
    return {
      availableTools,
      canDelegate: hasUsableDispatchChannel({ availableTools, blocked }),
    };
  };

  /**
   * 这个工具名是否落在 3.0.0 的三层指挥链门禁里。
   *
   * 用名字先做一次廉价过滤：绝大多数工具调用不该为了判定去读一次工具视图。
   *
   * 7.0.0：`subagent_<id>` 已从这份清单移出 —— 它改由**无条件**的
   * `evaluateCommanderChannels()` 硬门禁处理（不再受 `delegationHierarchy` 控制）。
   *
   * @param {string} toolName - 工具名。
   * @returns {boolean} 是否需要跑 `evaluateBoardWrite` / `evaluateTicketWrite`。
   */
  const isHierarchyGatedTool = (toolName) => toolName === 'team_task_update'
    || toolName === 'commander_ticket_update';

  // 3.3.0：监听器改成 async —— 派发门禁需要 await「补建任务板投影」（自愈）。
  // 事件本身是 waterfall（返回 Promise<PreToolDecision>），异步监听器是受支持的。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const toolName = typeof exec?.name === 'string' ? exec.name : '';

      // ---------------------------------------------------------------- 7.0.0 ---
      // 派发通道**硬门禁**（用户硬要求，不可配置、无开关）：指挥官只能建小组长。
      // 在**所有其它判定之前**无条件执行 —— 它不属于 `delegationHierarchy` 的可选子集：
      // 关掉层级门禁也不能让指挥官用 workflow / 一次性专家 / Worker Session 绕开小组长层。
      // 只拦指挥官本人（`isDelegatedAgent` 命中即放行：小组长派自己的手下是 L1→L2）。
      // 拒绝理由按 agent 实际拥有的工具生成，并带「需要小组长 / 小组长失败」的恢复阶梯。
      const channelDecision = evaluateCommanderChannels({
        agent: exec?.agent,
        name: toolName,
        availableTools: agentToolNames(exec?.agent),
      });
      if (channelDecision !== undefined) {
        ctx.logger?.info?.('commander-mode: 拒绝指挥官换派发通道（%s）', toolName);
        return channelDecision;
      }

      // 3.0.0 三层指挥链门禁：任务板进展/排期、工单推进状态都归小组长。
      // 只对指挥官本人生效（门禁内部按 isDelegatedAgent 放行子级），受
      // `delegationHierarchy` 控制（false = 只留协议约束，回到 2.x 行为）。
      // ⚠️ 必须在 `observeDelegation` **之前**判定：被拒的派发尝试不能进入派发通道统计，
      // 否则看板会把"被门禁拒掉的一次性派发"误报成"派活全走一次性 specialist"。
      // 两条都排在"记 Assignment"之前，避免"先记账、再拒绝"留下幽灵派发。
      if (readOptions().delegationHierarchy !== false && isHierarchyGatedTool(toolName)) {
        const hierarchyAgent = exec?.agent;
        // 拒绝理由必须按 agent **实际拥有**的工具生成，否则会点名一个它没有的工具。
        const hierarchyTools = agentToolNames(hierarchyAgent);
        const hierarchyDecision = evaluateBoardWrite({
          agent: hierarchyAgent,
          name: toolName,
          args: exec?.arguments,
          availableTools: hierarchyTools,
        })
          ?? evaluateTicketWrite({
            agent: hierarchyAgent,
            name: toolName,
            args: exec?.arguments,
            availableTools: hierarchyTools,
          });
        if (hierarchyDecision !== undefined) {
          ctx.logger?.info?.('commander-mode: 拒绝指挥官自己写团队进度（%s）', toolName);
          return hierarchyDecision;
        }
      }

      // 0.5.0：记一笔派发通道（Team / 一次性），供"团队闲置"判定使用。
      // 走到这里说明层级门禁已经放行（被拒的尝试在上面 return 了，不计入统计）。
      observeDelegation(exec);

      const blockedSet = new Set(readOptions().blockedTools ?? DEFAULT_BLOCKED_TOOLS);
      // 快路径：绝大多数调用既不在拦截清单里，也不是 Lead 发起的。
      if (blockedSet.has(toolName) && !isDelegatedAgent(exec?.agent)) {
        const { availableTools, canDelegate } = inspectAgentTools(exec.agent);
        const decision = evaluatePreExecute({
          agent: exec.agent,
          name: toolName,
          blocked: blockedSet,
          canDelegate,
          availableTools,
        });
        if (decision !== undefined) {
          ctx.logger?.info?.('commander-mode: 拒绝指挥者自己调用 %s（已要求改为派发）', toolName);
          return decision;
        }
      }

      // 3.1.0 / 3.2.0「禁止等待子智能体」：本模式里任何 agent 调 `wait_agent` **无条件拒绝**。
      // 用户 2026-11-11 补充要求：禁止等待、不设开关；随后追加「不要等」→ 整条链都不许等
      // （指挥官、小组长、子智能体一视同仁）。所以这里不读任何配置项
      // （`delegationHierarchy` / `blockedTools` / 已移除的 `maxWaitMs` 都不影响它）。
      const waitDecision = evaluateWaitForbidden({ name: toolName });
      if (waitDecision !== undefined) {
        ctx.logger?.info?.('commander-mode: 拒绝 wait_agent（禁止等待，无开关，整条链生效）');
        return waitDecision;
      }

      // 0.7.0 异步容量：一次性 specialist 在飞数量达上限时**在启动前**拒绝，
      // 避免"先启动 child、再发现超限"或"先记 Assignment 再失败"。
      // 异步容量只约束**名册生成的一次性专家**（`subagent_<id>`）；`subagent_fork` 是 Team 通道。
      if (isSpecialistDispatchTool(toolName) && readOptions().asyncDelegation !== false) {
        const capacityReason = asyncCapacityReason(exec?.agent);
        if (typeof capacityReason === 'string' && capacityReason !== '') {
          ctx.logger?.info?.('commander-mode: 异步派发达到上限，拒绝 %s', toolName);
          return { kind: 'deny', reason: capacityReason };
        }
      }

      // 0.6.0 派发门禁：没有计划授权 / 没有工单 → 确定性拒绝。
      // 只对指挥者本人生效；子代理、缺失账本、身份不明一律放行（宁可漏拦）。
      if (ledgerEnabled()) {
        const options = readOptions();
        const mandateDecision = await evaluateDispatchGate({
          agent: exec?.agent,
          name: toolName,
          args: exec?.arguments,
          requireMandate: options.requireMandate !== false,
          requireTicket: options.requireTicket !== false,
          ledger: getLedger(),
          // 1.2.0 D：Team 通道必须落在共享任务板上；没有 Agent Teams 时适配器为 undefined → 整段跳过。
          requireTeamTask: options.requireTeamTask !== false,
          requireTeamTaskMarker: options.requireTeamTaskMarker === true,
          teamBoard: teamBoardFor(exec?.agent),
          // 3.4.0 降级：没有 `ask_user_question` 的部署永远无法记录计划授权，
          // 门禁据此跳过授权检查（否则整个模式派不出活）。工具视图读不到时按"有"处理。
          availableTools: agentToolNames(exec?.agent),
          // 3.3.0 自愈：缺投影时由插件补建，而不是让模型去调一个可能被层级门禁禁止的动作
          // （会话 def6609d 的"两条门禁互相矛盾"就是这么来的）。
          ensureTeamTask: async (gateAgent, gateTicket) => {
            try {
              const projected = await teamBridge.createProjection(gateAgent, gateTicket);
              return projected?.taskId;
            } catch {
              return undefined;
            }
          },
        });
        if (mandateDecision !== undefined) {
          ctx.logger?.info?.('commander-mode: 派发被计划授权/工单门禁拒绝（%s）', toolName);
          return mandateDecision;
        }
        // 门禁通过后记一次 Assignment（写失败不影响派发）。
        observeAssignment(exec);
      }
    } catch (error) {
      // 门禁自己出错时绝不能让工具调用失败——放行，交回默认行为。
      ctx.logger?.warn?.('commander-mode: 门禁判定失败，已放行：%o', error);
    }
    return typeof next === 'function' ? next() : undefined;
  });

  // ---------------------------------------------------------------- skill ---

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      // `registerSkill` 是加载期开关：拿不到配置服务时按默认（注册）处理。
      const enabled = (() => {
        try {
          return readSettings()?.options?.().registerSkill !== false;
        } catch {
          return true;
        }
      })();
      if (!enabled) return;
      try {
        skillCtx.effect(
          () =>
            skillCtx.skills.register({
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              whenToUse: SKILL_WHEN_TO_USE,
              source: 'runtime',
              content: COMMANDER_PROTOCOL,
              invocation: { modelInvocable: true, userInvocable: true },
            }),
          `commander-mode: skill ${SKILL_NAME}`,
        );
      } catch (error) {
        ctx.logger?.warn?.('commander-mode: 无法注册 %s skill：%o', SKILL_NAME, error);
      }
    });
  }

  // ------------------------------------------------------------ specialist ---

  /**
   * specialist 的安装与重建。
   *
   * 配置在配置行里、名册是 volatile：设置页保存后 Loader 只热更新配置行的引用，然后配置行
   * 通过服务广播。这里订阅该广播，释放旧 preset/工具、按新名册重新注册。已经打开的会话保留
   * 它启动时的工具（DSH 的既定语义，设置页文案里也写明）。
   *
   * 缺服务时的降级：`tools` / `subagents` / `agentPresets` / `commanderSettings` 任何一个
   * 不存在，就只注册协议与门禁、不注册 specialist 工具 —— 模式退化为「只会做协议的普通
   * agent」，而不是把会话弄挂。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools', 'subagents', 'agentPresets', 'commanderSettings'], (toolCtx) => {
      try {
        /** 已安装 specialist 的异步释放函数。 */
        let disposers = [];
        /** 串行化重建，避免两次通知交错注册。 */
        let queue = Promise.resolve();
        /** 子级作用域已销毁。 */
        let disposed = false;

        const settings = toolCtx.commanderSettings;

        /**
         * 取 `subagents` 服务（可能晚于本行出现）。
         *
         * @returns {object | undefined} 服务实例。
         */
        const getSubagents = () => {
          try {
            return typeof toolCtx.get === 'function' ? toolCtx.get('subagents') : toolCtx.subagents;
          } catch {
            return undefined;
          }
        };

        /** 释放当前已安装的全部 specialist（失败不阻断其余释放）。 */
        const releaseAll = async () => {
          const previous = disposers;
          disposers = [];
          for (const dispose of previous) {
            try {
              await dispose();
            } catch (error) {
              toolCtx.logger?.warn?.('commander-mode: 释放 specialist 失败：%o', error);
            }
          }
        };

        /** 按当前名册重建 specialist preset 与工具。 */
        const rebuild = () => {
          queue = queue.then(async () => {
            if (disposed) return;
            await releaseAll();
            // 先清空协议视图：重建期间旧工具已经释放，此时协议不能还点名它们。
            installedRoster = [];
            const roster = settings.specialists();
            const enabled = new Set(roster.map((specialist) => specialist.id));
            const installed = [];
            for (const specialist of roster) {
              try {
                disposers.push(
                  await installSpecialist({
                    ctx: toolCtx,
                    specialist,
                    getSubagents,
                    isEnabled: () => enabled.has(specialist.id) && settings.specialists().some((entry) => entry.id === specialist.id),
                    // 0.7.0：默认异步派发（工具立即返回，完成通知 steer 唤醒指挥者）；
                    // 配置 asyncDelegation:false 回退 0.5.0 的前台阻塞行为。
                    asyncMode: readOptions().asyncDelegation !== false,
                    onAsyncStarted: asyncStarted,
                    asyncCapacityReason,
                    asyncSignal: () => asyncController.signal,
                  }),
                );
                installed.push(specialist);
              } catch (error) {
                // 单个 specialist 注册失败（例如 preset id 冲突）不应拖垮整个模式，也不能
                // 留在协议里 —— 协议点名一个没挂上的工具会让模型当场卡住。
                toolCtx.logger?.warn?.('commander-mode: 安装 specialist "%s" 失败：%o', specialist.id, error);
              }
            }
            installedRoster = installed;
            toolCtx.logger?.info?.('commander-mode: 已安装 %d 个 specialist 工具', installed.length);
          }).catch((error) => {
            toolCtx.logger?.warn?.('commander-mode: 重建 specialist 失败：%o', error);
          });
          return queue;
        };

        // 配置行广播"名册变了" → 重建。退订函数跟着本行作用域释放。
        toolCtx.effect(() => settings.subscribe(() => void rebuild()), 'commander-mode: roster subscription');

        toolCtx.effect(() => {
          void rebuild();
          return () => {
            disposed = true;
            void queue.then(releaseAll).catch(() => {});
          };
        }, 'commander-mode: specialist tools');
      } catch (error) {
        // 接线层自己出错时只损失 specialist 通道，**不能**让整行 broken ——
        // 那会让指挥者协议与门禁一起消失，模式整个失效。
        ctx.logger?.warn?.('commander-mode: specialist 接线失败，本会话退化为无 specialist 通道：%o', error);
      }
    });
  }

  // ------------------------------------------------------------ 工单工具 ---

  // 0.6.0：把工单账本暴露成三个模型可见工具。注册失败只损失工单通道，不影响模式本身。
  //
  // 7.0.0：**Worker Session 通道下线**（用户硬要求「不能另辟蹊径开子智能体」，
  // 口径明确「连 Worker Session 一起禁」）；**7.0.1 起实现已删除**
  // （`lib/worker-tools.js` / `lib/worker-sessions.js` 已从仓库移除）。这里只剩工单工具；
  // 账本里的历史 `execution` 字段仍按旧数据读出（`lib/ledger.js` 的 `sanitizeExecution`），
  // 但不再有任何写入方。
  if (typeof ctx.inject === 'function' && readOptions().ledger !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        toolCtx.effect(() => {
          const disposers = [];
          const definitions = buildTicketTools({ getLedger, getOptions: readOptions, getTeamBridge: () => teamBridge });
          for (const definition of definitions) {
            try {
              disposers.push(toolCtx.tools.register(definition));
            } catch (error) {
              toolCtx.logger?.warn?.('commander-mode: 注册工单工具 %s 失败：%o', definition.name, error);
            }
          }
          return () => {
            for (const dispose of disposers.splice(0).reverse()) {
              try {
                dispose?.();
              } catch {
                // 工具可能已随作用域销毁。
              }
            }
          };
        }, 'commander-mode: ticket tools');
        toolCtx.logger?.info?.('commander-mode: 工单工具已注册（commander_ticket_create/update/list）');
      } catch (error) {
        ctx.logger?.warn?.('commander-mode: 工单工具接线失败，本会话没有工单通道：%o', error);
      }
    });
  }

  ctx.logger?.info?.('commander-mode: 模式行就绪（配置来自 commanderSettings 服务）');
}
