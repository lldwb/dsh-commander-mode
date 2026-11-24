/**
 * 「指挥官会话的智能体团队**默认启用且不可关闭**」（6.0.0，用户 2026-11-12 硬要求）。
 *
 * ## 为什么这件事必须由本插件做
 *
 * DSH 0.2.2-rc.2 把 Agent Teams 改成**按根会话选择**：新会话默认关闭，选择记在根会话的
 * `team/mode` 事件里（`{ enabled: boolean }`）；Team 的四个 `team_task_*` 工具在关闭时
 * 连 schema 都不出现（`when` 在步骤准备时求值）。而「指挥者模式」的三层指挥链
 * （指挥官 → 小组长 → 子智能体）完全建立在 Team 上 —— 关掉 Team，模式就只剩协议文本。
 *
 * 官方的 `agent-team` 行有 `defaultEnabled` 配置，但它是**全局**的（所有会话都开），
 * 不是"只有指挥官模式"。所以本插件在自己的 profile 顶层行上按 preset 强制开启。
 *
 * ## 三条通道（缺一不可，均为沙箱实测）
 *
 * 1. **创建即开启**：`agent/created` 里，根 agent 且**当前 preset** 是 `commander`
 *    （优先读 `agentPresets.presetForSession()` 投影，回退 `session.header.agentPreset`）
 *    → `ctx.agentTeams.setEnabled(agent, true)`。
 * 2. **切到指挥官即开启**：`session/event` 里出现 `agent-preset/selected` 且目标是 `commander`
 *    → 对**同一个活 agent** 调 `setEnabled(agent, true)`。
 *    rc.2 的 web 流程是「先建默认会话、再在输入框里切模式」，切模式走
 *    `agentPresets.select(liveAgent, …)`，**不会**产生新的 `agent/created` —— 沙箱实测。
 * 3. **关掉即重开**：`session/event` 里，指挥官会话出现 `team/mode { enabled: false }`
 *    → 立刻重新 `setEnabled(agent, true)` 并记日志。
 *
 * 没有"关闭团队"的配置项：这是硬约束，不是可调选项。
 *
 * ## 两个实测踩出来的坑
 *
 * - **必须推迟写操作**：在 `session/event` 观察者里直接调 `setEnabled()` 会被 Session 的
 *   重入保护拒绝（`session append cannot reenter while another append is being published`），
 *   因为观察者是在那条事件的 append 发布过程中被调用的。所以用 `deferToNextTask()`
 *   把写操作挪到下一个宏任务。
 * - **不能只看 `session.header.agentPreset`**：头里是**创建时**的 preset；切模式只 append
 *   `agent-preset/selected`，权威值在 `agentPresets.presetForSession()` 的投影里。
 *
 * ## 为什么按 preset 判断（而不是身份）
 *
 * 子代理**继承**父会话的 preset，所以子代理也会命中 `commander` —— 必须先用
 * `header.origin === 'subagent'` / `rootOf(agent) === agent` 排除，否则会对子级调
 * `setEnabled`（服务会以 `TEAM_LEAD_REQUIRED` 拒绝）。
 *
 * ## 硬依赖，不静默降级
 *
 * `agentTeams` 是 base bundle 自带的服务；本插件把它当**硬依赖**：读不到时记 `error` 日志
 * （而不是悄悄跳过），因为那种部署里指挥者模式根本无法工作，必须让用户看见。
 *
 * @module dsh-commander-mode/lib/team-mode
 */

/** 指挥者模式的 preset id（`preset-commander` 声明里的 `config.id`）。 */
export const COMMANDER_PRESET_ID = 'commander';

/** Team 选择事件名（`@deepseek-ai/dsh-agent-team` 的 `team/mode`）。 */
export const TEAM_MODE_EVENT = 'team/mode';

/** preset 切换事件名（会话日志事件；`@deepseek-ai/dsh-agent-preset-registry` 的投影来源）。 */
export const AGENT_PRESET_SELECTED_EVENT = 'agent-preset/selected';

/** 服务名（Cordis context key）。 */
export const TEAM_SERVICE_NAME = 'agentTeams';

/**
 * 读会话头的 preset id；读不到返回 `undefined`。
 *
 * @param {unknown} session - Session 实例。
 * @returns {string | undefined} preset id。
 */
export function agentPresetOf(session) {
  try {
    const preset = session?.header?.agentPreset;
    return typeof preset === 'string' && preset !== '' ? preset : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读会话**当前**的 preset id；读不到返回 `undefined`。
 *
 * 优先读 `agentPresets.presetForSession()` 的投影（`agent-preset/selected` 的权威值），
 * 没有 `agentPresets` 服务时回退到会话头（创建时的 preset）。
 *
 * @param {object} ctx - 插件上下文（可选地能 `ctx.get('agentPresets')`）。
 * @param {unknown} session - Session 实例。
 * @returns {string | undefined} preset id。
 */
export function currentAgentPreset(ctx, session) {
  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined;
    if (presets !== undefined && typeof presets.presetForSession === 'function') {
      const projected = presets.presetForSession(session);
      if (typeof projected === 'string' && projected !== '') return projected;
    }
  } catch {
    // 投影读不到就退回 header。
  }
  return agentPresetOf(session);
}

/**
 * 判断会话是不是**指挥官根会话**。
 *
 * @param {object} ctx - 插件上下文（可选地能 `ctx.get('agentPresets')`）。
 * @param {unknown} session - Session 实例。
 * @returns {boolean} 是否指挥官模式的根会话。
 */
export function isCommanderSession(ctx, session) {
  try {
    // 子代理继承父 preset，所以必须先排除子会话（否则会命中它的 header）。
    if (session?.header?.origin === 'subagent') return false;
    return currentAgentPreset(ctx, session) === COMMANDER_PRESET_ID;
  } catch {
    return false;
  }
}

/**
 * 判断 agent 是不是它那棵 subagent 树的根。
 *
 * `rootOf()` 对"还没有运行时归属的子代理"会抛错（子级归属在 `agent/created` 结算之后才
 * 登记），所以这里任何异常都按"不是根"处理 —— 宁可漏一次，也不对子级调 `setEnabled`。
 *
 * @param {object} ctx - 插件上下文（要能 `ctx.get('subagents')`）。
 * @param {unknown} agent - Agent 实例。
 * @returns {boolean} 是否是根 agent。
 */
export function isRootAgent(ctx, agent) {
  try {
    if (agent?.session?.header?.origin === 'subagent') return false;
    const subagents = typeof ctx?.get === 'function' ? ctx.get('subagents') : undefined;
    if (subagents === undefined || typeof subagents.rootOf !== 'function') {
      // 没有 subagents 服务时退回 header 判据：非 subagent 来源即视为根。
      return true;
    }
    return subagents.rootOf(agent) === agent;
  } catch {
    return false;
  }
}

/**
 * 取某个会话**当前活着的** agent（没有返回 `undefined`）。
 *
 * @param {object} ctx - 插件上下文（要能 `ctx.get('agents')`）。
 * @param {unknown} session - Session 实例。
 * @returns {object | undefined} 活 agent。
 */
export function liveAgentOf(ctx, session) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
    if (agents === undefined || typeof agents.get !== 'function') return undefined;
    const id = session?.id;
    if (id === undefined || id === null) return undefined;
    return agents.get(id) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把一次写操作推迟到**当前 session append 的发布完成之后**。
 *
 * 在 `session/event` 观察者里直接调 `setEnabled()` 时，服务会往同一个会话 append
 * `team/mode`，而 Session 有重入保护：
 *
 * ```text
 * session append cannot reenter while another append is being published
 * ```
 *
 * 观察者正是在那条事件的 append 发布过程中被调用的，所以必须把写操作挪到下一个宏任务
 * （microtask 仍可能落在发布链路里）。沙箱实测：不推迟 → `setEnabled` 抛上述错误；
 * 推迟后 → `team/mode {enabled:true}` 正常落盘。
 *
 * @param {() => void} task - 要推迟的任务。
 * @returns {void}
 */
export function deferToNextTask(task) {
  if (typeof setImmediate === 'function') setImmediate(task);
  else setTimeout(task, 0);
}

/**
 * 安装「团队默认开、不可关」的三条监听。
 *
 * @param {object} ctx - profile 顶层的插件上下文。
 * @returns {void}
 */
export function installForcedTeamMode(ctx) {
  /** 正在处理中的会话（防同一会话并发重开 / 重复 append）。 */
  const inFlight = new Set();

  /**
   * 取团队服务；缺失时记**显式错误**（硬依赖，不静默降级）。
   *
   * @param {string} where - 触发位置（日志用）。
   * @returns {object | undefined} 服务实例。
   */
  const requireTeams = (where) => {
    let service;
    try {
      service = typeof ctx?.get === 'function' ? ctx.get(TEAM_SERVICE_NAME) : undefined;
    } catch (error) {
      ctx.logger?.error?.('commander-mode: 读取 agentTeams 服务失败（%s）：%o', where, error);
      return undefined;
    }
    if (service === undefined || service === null || typeof service !== 'object') {
      ctx.logger?.error?.(
        'commander-mode: 缺少 agentTeams 服务（%s）——「指挥者模式」把智能体团队当硬依赖（团队默认开、不可关），'
          + '这个部署里模式无法工作。请检查 profile 是否加载了 @deepseek-ai/dsh-agent-team（DSH 0.2.2-rc.2 起由 base bundle 自带）。',
        where,
      );
      return undefined;
    }
    if (typeof service.setEnabled !== 'function') {
      ctx.logger?.error?.('commander-mode: agentTeams 服务没有 setEnabled()（%s），无法强制开启团队。', where);
      return undefined;
    }
    return service;
  };

  /**
   * 把一个 agent 的 Team 模式置为开启（幂等：已经是开的不重复 append）。
   *
   * @param {object} agent - 根 agent。
   * @param {string} where - 触发位置（日志用）。
   * @returns {Promise<boolean>} 是否已确认开启。
   */
  const enableTeam = async (agent, where) => {
    const service = requireTeams(where);
    if (service === undefined) return false;
    try {
      if (typeof service.isEnabled === 'function' && service.isEnabled(agent) === true) return true;
    } catch {
      // 读不到状态不阻断：下面 setEnabled 自己会判断是否真的需要 append。
    }
    try {
      await service.setEnabled(agent, true);
      return true;
    } catch (error) {
      ctx.logger?.error?.('commander-mode: 强制开启智能体团队失败（%s）：%o', where, error);
      return false;
    }
  };

  /**
   * 在下一个宏任务里对一个根 agent 开启团队，并登记/清理在飞标记。
   *
   * @param {object} agent - 根 agent。
   * @param {string} where - 触发位置（日志用）。
   * @param {string} sessionId - 会话 id（在飞标记的键）。
   * @param {string} okMessage - 成功后的日志。
   * @returns {void}
   */
  const scheduleEnable = (agent, where, sessionId, okMessage) => {
    deferToNextTask(() => {
      void enableTeam(agent, where)
        .then((ok) => {
          if (ok) ctx.logger?.info?.('%s', okMessage);
        })
        .finally(() => inFlight.delete(sessionId));
    });
  };

  // ---- 通道 1：会话创建即开启 ------------------------------------------------
  ctx.on('agent/created', async ({ agent } = {}) => {
    try {
      if (agent === null || agent === undefined) return;
      if (!isCommanderSession(ctx, agent.session)) return;
      if (!isRootAgent(ctx, agent)) return;
      const ok = await enableTeam(agent, 'agent/created');
      if (ok) ctx.logger?.info?.('commander-mode: 已为指挥官会话开启智能体团队（默认启用、不可关闭）');
    } catch (error) {
      // 创建监听抛错会让 agent 创建失败，所以这里兜住：最坏是团队没开，不能把会话弄挂。
      ctx.logger?.error?.('commander-mode: agent/created 强制开启团队时出错：%o', error);
    }
  });

  // ---- 通道 2/3：切到指挥官即开启 / 被关闭即重开 ------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      if (event === null || typeof event !== 'object') return;

      // 2. 在输入框里切到「指挥者模式」：rc.2 走 agentPresets.select(liveAgent, …)，
      //    不会产生新的 agent/created，所以必须在这里补。
      if (event.type === AGENT_PRESET_SELECTED_EVENT) {
        if (event.data?.agentPreset !== COMMANDER_PRESET_ID) return; // 只在切到指挥官时动作
        const live = liveAgentOf(ctx, session);
        if (live === undefined) return; // 尚无活 agent：随后的 agent/created 会处理
        if (!isRootAgent(ctx, live)) return;
        const sessionId = String(session?.id ?? '');
        if (inFlight.has(sessionId)) return;
        inFlight.add(sessionId);
        ctx.logger?.info?.('commander-mode: 会话切换到指挥官模式，正在开启智能体团队');
        scheduleEnable(live, AGENT_PRESET_SELECTED_EVENT, sessionId, 'commander-mode: 已为指挥官会话开启智能体团队（默认启用、不可关闭）');
        return;
      }

      // 3. 被关掉即重开：只在**当前确实是关的**时候动作，避免事件循环。
      if (event.type !== TEAM_MODE_EVENT) return;
      if (event.data?.enabled !== false) return; // 开着的（包括我们自己写回去的）忽略
      if (!isCommanderSession(ctx, session)) return;

      const sessionId = String(session?.id ?? '');
      if (inFlight.has(sessionId)) return;
      inFlight.add(sessionId);

      const agent = liveAgentOf(ctx, session);
      if (agent === undefined) {
        ctx.logger?.warn?.('commander-mode: 指挥官会话的 team/mode 被关闭，但该会话当前没有活着的 agent，无法立刻重开（下次创建时会重新开启）');
        inFlight.delete(sessionId);
        return;
      }

      ctx.logger?.warn?.('commander-mode: 检测到指挥官会话的 team/mode 被关闭 —— 本模式要求团队默认启用且不可关闭，正在重新开启');
      scheduleEnable(agent, 'session/event', sessionId, 'commander-mode: 已重新开启智能体团队（不可关闭）');
    } catch (error) {
      ctx.logger?.error?.('commander-mode: session/event 重开团队时出错：%o', error);
    }
  });
}
