/**
 * 工单 → Agent Teams 共享任务板的**投影器**（1.2.0，B 阶段）。
 *
 * ## 它解决什么
 *
 * 工单账本是权威（跨会话 JSON、门禁的同步数据源），但用户在「智能体团队」面板里看不到
 * 它。这一层把每张工单**确定性**地镜像成任务板上的一张任务：账本继续负责授权/验收/
 * 停滞，任务板负责"一块看得见的板"。
 *
 * ## 三条铁律
 *
 * 1. **单向**：只从账本流向任务板；任务板上的改动不回写账本（模型改了也会被下次同步覆盖，
 *    协议里明确要求改进度用 `commander_ticket_update`）。
 * 2. **尽力而为**：任何一步失败都只记日志、返回 `undefined`，**绝不向调用方抛错** ——
 *    投影坏掉不能影响工单工具、派发门禁与派发本身。
 * 3. **零硬依赖**：`ctx.get('agentTeams')` 不存在 / 当前 agent 不是成员 / 方法缺失
 *    → 全部 no-op，行为与 1.1.1 完全一致。
 *
 * ## 为什么任务板状态只有 4 个
 *
 * 随附包的任务只有 `pending / in_progress / completed / deleted`。工单的
 * `review / blocked / failed / waiting` 在板上没有对应状态，所以：
 *
 * - 任务 status 只表达"在板上所处阶段"；
 * - **真实工单状态**写进描述的 `[commander:status=...]` 行（前三行 marker 之一），
 *   读板的人永远能看到真实状态。
 *
 * ## 收养（避免重复任务）
 *
 * 模型可能已经按旧协议自己建过任务（描述里含 `[ticket:t-N]` 或"工单 t-N"）。建投影前
 * 先扫描：命中就**接管**（把 marker 插到描述最前），而不是并排再建一份。
 *
 * @module dsh-commander-mode/lib/team-board-bridge
 */

/** 投影标记前缀（描述第一行）。 */
export const PROJECTION_PREFIX = '[commander:ticket=';

/** 任务板上限（与随附包默认值一致，用于截断描述）。 */
export const MAX_TASK_DESCRIPTION = 16_384;

/** 描述第一行的识别正则。 */
const PROJECTION_RE = /^\[commander:ticket=(t-\d+)\]/u;

/** 合法任务 id。 */
const TASK_ID_RE = /^task-\d+$/u;

/** 我们生成的描述里一定包含的一节。 */
const ACCEPTANCE_HEADING = '## 验收判据';

/** 通道取值（与工单 Assignment.channel 对齐）。 */
const CHANNELS = new Set(['team', 'specialist', 'one-shot', 'worker']);

/**
 * 读错误码（真实 `TeamError` 与测试替身都带 `code`；有的实现放在 `cause` 上）。
 *
 * @param {unknown} error - 错误。
 * @returns {string} 错误码；拿不到返回空串。
 */
export function teamErrorCode(error) {
  if (error === null || error === undefined || typeof error !== 'object') return '';
  const direct = error.code;
  if (typeof direct === 'string') return direct;
  const caused = error.cause;
  if (caused !== null && caused !== undefined && typeof caused === 'object' && typeof caused.code === 'string') {
    return caused.code;
  }
  return '';
}

/**
 * 这个任务是不是本插件投影出来的。
 *
 * @param {unknown} task - `agentTeams.listTasks()` 的视图。
 * @returns {boolean} 是否投影任务。
 */
export function isProjectedTask(task) {
  return task !== null
    && typeof task === 'object'
    && typeof task.description === 'string'
    && PROJECTION_RE.test(task.description);
}

/**
 * 从投影任务里读回工单 id。
 *
 * @param {unknown} task - 任务视图。
 * @returns {string | null} `t-N` 或 null。
 */
export function projectedTicketId(task) {
  if (task === null || typeof task !== 'object' || typeof task.description !== 'string') return null;
  const match = PROJECTION_RE.exec(task.description);
  return match === null ? null : match[1];
}

/**
 * 工单最后一次派发走的通道。
 *
 * @param {object} ticket - 工单记录。
 * @returns {'team'|'specialist'|'one-shot'|'worker'|'none'} 通道。
 */
export function channelOf(ticket) {
  const assignments = Array.isArray(ticket?.assignments) ? ticket.assignments : [];
  const last = assignments[assignments.length - 1];
  if (last === null || last === undefined || typeof last !== 'object') return 'none';
  const channel = last.channel;
  return CHANNELS.has(channel) ? channel : 'none';
}

/**
 * 「执行者」那一段的文案。
 *
 * @param {object} ticket - 工单记录。
 * @param {string} channel - `channelOf()` 的结果。
 * @returns {string} 一行文案。
 */
function executorLine(ticket, channel) {
  const assignments = Array.isArray(ticket?.assignments) ? ticket.assignments : [];
  const last = assignments[assignments.length - 1];
  const toolName = typeof last?.toolName === 'string' && last.toolName !== '' ? last.toolName : '未知工具';
  if (channel === 'team') return 'Team 通道：owner 由插件自动绑定（队友用 `team_task_list` 可看到自己名下的任务）';
  if (channel === 'worker') {
    const sessionId = typeof ticket?.execution?.sessionId === 'string' ? ticket.execution.sessionId : '';
    return `Worker Session：${sessionId === '' ? '（未记录）' : sessionId}`;
  }
  if (channel === 'specialist') return `一次性 specialist：${toolName}`;
  if (channel === 'one-shot') return `一次性子代理：${toolName}`;
  return '未指派';
}

/**
 * 纯函数：把工单的 `scope` 清洗成**合法的工作区相对路径**（3.3.0）。
 *
 * ## 为什么必须清洗（2026-11-11 会话 def6609d 的死锁根因）
 *
 * 运行时 `agentTeams.createTask()` 对 `writeScopes` 的校验是（`writeScope()`）：
 * 把 `\` 换成 `/`、去掉前导 `./` 与尾随 `/` 之后，
 * **不能以 `/` 开头、不能是 `E:` 这种盘符开头、不能有空段 / `.` / `..` 段**，
 * 否则抛 `TEAM_INVALID_WRITE_SCOPE`。
 *
 * 而工单的 scope 往往是用户给的 **Windows 绝对路径**（`E:\repo\src`）——原样透传会让
 * `createTask()` 直接抛错，投影静默失败，于是：
 *
 * 1. 派发门禁看到"工单没有任务板投影" → 拒绝 `subagent`；
 * 2. 它给的补救动作是"更新工单状态触发投影"，而 3.0.0 起指挥官改工单推进状态被层级门禁拒绝
 *    → **两条门禁互相矛盾，Team 通道永久不可用**（会话 def6609d 实际卡死在这里）。
 *
 * 所以这里**只保留合法的相对路径**，绝对路径一律丢弃：`writeScopes` 只是 advisory
 * （用于板上"写作用域重叠"提示），工单本身仍保留完整 `scope`，任务描述里也有背景说明。
 * 清洗是**非抛错**的——丢一条作用域远好于整条 Team 通道不可用。
 *
 * @param {unknown} scopes - 工单 scope（任意值）。
 * @param {number} [limit] - 最多保留多少条（默认 40，与投影描述截断口径一致）。
 * @returns {string[]} 清洗后的相对路径（去重、保序）。
 */
export function sanitizeWriteScopes(scopes, limit = 40) {
  const out = [];
  const seen = new Set();
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : 40;
  for (const raw of Array.isArray(scopes) ? scopes : []) {
    const text = String(raw ?? '').trim();
    if (text === '') continue;
    const normalized = text.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
    // 与运行时 `writeScope()` 的拒绝条件逐条对齐。
    if (normalized === '') continue;
    if (normalized.startsWith('/')) continue;
    if (/^[a-z]:/iu.test(normalized)) continue;
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 纯函数：工单 → 任务内容。
 *
 * @param {object} ticket - 工单记录（账本内部记录，含 intent/acceptance/scope）。
 * @returns {{ subject: string, description: string, writeScopes: string[], channel: string, status: string }} 任务内容。
 */
export function projectContent(ticket) {
  const title = String(ticket?.title ?? '').trim();
  const status = String(ticket?.status ?? 'open');
  const channel = channelOf(ticket);
  const intent = String(ticket?.intent ?? '').trim();
  const acceptance = (Array.isArray(ticket?.acceptance) ? ticket.acceptance : [])
    .map((item) => String(item).trim())
    .filter((item) => item !== '');
  const lines = [
    `${PROJECTION_PREFIX}${String(ticket?.id ?? '')}]`,
    `[commander:channel=${channel}]`,
    `[commander:status=${status}]`,
    '',
    intent === '' ? '（无背景说明）' : intent,
    '',
    ACCEPTANCE_HEADING,
    ...(acceptance.length > 0 ? acceptance.map((item) => `- ${item}`) : ['- （未填写）']),
    '',
    '## 执行者',
    executorLine(ticket, channel),
  ];
  // 3.3.0：只把合法的工作区相对路径交给任务板；绝对路径会让 createTask 抛
  // TEAM_INVALID_WRITE_SCOPE，进而让投影失败、Team 通道被派发门禁挡死。
  const writeScopes = sanitizeWriteScopes(ticket?.scope);
  return {
    subject: (title === '' ? '未命名工单' : title).slice(0, 200),
    description: lines.join('\n').slice(0, MAX_TASK_DESCRIPTION),
    writeScopes,
    channel,
    status,
  };
}

/**
 * 计算描述该怎么写。
 *
 * - 描述为空 → 用完整模板；
 * - 描述已是**我们生成的**（有 marker 且有验收判据节）→ 全量刷新（让 intent/acceptance 的修改生效）；
 * - 描述是**收养来的**（有 marker 但没有我们的验收节）→ 只刷新前三行 marker，保留正文；
 * - 描述不是投影（模型自己建的）→ marker 插到最前，保留正文。
 *
 * @param {string} current - 当前描述。
 * @param {{ description: string, channel: string, status: string }} content - `projectContent()` 结果。
 * @param {string} ticketId - 工单 id。
 * @returns {string} 新描述。
 */
export function mergeDescription(current, content, ticketId) {
  if (typeof current !== 'string' || current === '') return content.description;
  const header = `${PROJECTION_PREFIX}${ticketId}]\n[commander:channel=${content.channel}]\n[commander:status=${content.status}]`;
  if (!current.startsWith(PROJECTION_PREFIX)) {
    return `${header}\n\n${current}`.slice(0, MAX_TASK_DESCRIPTION);
  }
  if (current.includes(ACCEPTANCE_HEADING)) return content.description;
  const body = current.replace(/^(?:\[commander:[^\]]*\]\n)+/u, '').replace(/^\n+/u, '');
  return `${header}\n\n${body}`.slice(0, MAX_TASK_DESCRIPTION);
}

/**
 * 任务描述里是否提到了某张工单（收养旧任务用）。
 *
 * @param {string} description - 任务描述。
 * @param {string} ticketId - `t-N`。
 * @returns {boolean} 是否提到。
 */
function mentionsTicket(description, ticketId) {
  if (typeof description !== 'string' || description === '') return false;
  if (description.includes(`[ticket:${ticketId}]`)) return true;
  const escaped = ticketId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`工单\\s*${escaped}(?![0-9])`, 'u').test(description);
}

/**
 * 创建投影器。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getService - 取任意可选服务（`ctx.get`）。
 * @param {object} [deps.logger] - Cordis logger。
 * @returns {object} 投影器 API。
 */
export function createTeamBoardBridge({ getService, logger } = {}) {
  /** 只在 debug 记失败：投影失败是预期内的降级路径。 */
  const debug = (message, ...args) => {
    try {
      logger?.debug?.(message, ...args);
    } catch {
      // logger 自己出错也不能影响调用方。
    }
  };

  /**
   * 投影失败时记 **warn**（3.3.0）。
   *
   * 为什么不再只记 debug：投影失败不是无害的降级——派发门禁要求 `subagent` 前
   * 工单已有任务板投影，投影失败会让 Team 通道被**确定性拒绝**（会话 def6609d 因此卡死）。
   * 失败原因（尤其是 `TEAM_INVALID_WRITE_SCOPE` 这类参数错误）必须能在日志里看到，
   * 否则用户只能看到"门禁自相矛盾"。
   *
   * @param {string} what - 失败动作（创建 / 同步 / 更新）。
   * @param {unknown} error - 原始错误。
   * @returns {void}
   */
  const warnFailure = (what, error) => {
    try {
      const code = teamErrorCode(error);
      logger?.warn?.('commander-mode: %s共享任务板投影失败（%s）：%o', what, code === '' ? 'unknown' : code, error);
    } catch {
      // logger 自己出错也不能影响调用方。
    }
  };

  /**
   * 取可用的 `agentTeams` 服务（方法齐全 + 当前会话的 Team 模式已开启）。
   *
   * 6.0.0（DSH 0.2.2-rc.2）：旧的 `tryMembership(agent)` 名册 API 已被移除；Team 成员现在
   * 就是 subagent 树里的可续做子代理，权威的"这个会话有没有 Team"判据是
   * `agentTeams.isEnabled(agent)`。Team 模式由本插件在会话创建时强制开启，所以这里正常
   * 恒为可用；读不到或服务缺失时按"不可用"降级。
   *
   * @param {object} agent - 调用方 agent。
   * @returns {object | undefined} 服务实例；不可用时 undefined。
   */
  const available = (agent) => {
    let service;
    try {
      service = typeof getService === 'function' ? getService('agentTeams') : undefined;
    } catch {
      return undefined;
    }
    if (service === null || service === undefined || typeof service !== 'object') return undefined;
    try {
      if (typeof service.isEnabled === 'function' && service.isEnabled(agent) !== true) return undefined;
    } catch {
      return undefined;
    }
    for (const method of ['createTask', 'getTask', 'listTasks', 'updateTask']) {
      if (typeof service[method] !== 'function') return undefined;
    }
    return service;
  };

  /**
   * 安全读一个任务（不存在/已删返回 undefined）。
   *
   * @param {object} service - `agentTeams` 服务。
   * @param {object} agent - 调用方 agent。
   * @param {string} taskId - `task-N`。
   * @returns {object | undefined} 任务视图。
   */
  const readTask = (service, agent, taskId) => {
    try {
      return service.getTask(agent, taskId);
    } catch (error) {
      const code = teamErrorCode(error);
      if (code === 'TEAM_TASK_NOT_FOUND' || code === 'TEAM_TASK_DELETED') return undefined;
      throw error;
    }
  };

  /**
   * 安全列任务。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @returns {object[]} 任务视图数组（失败为空数组）。
   */
  const listTasks = (service, agent) => {
    try {
      const tasks = service.listTasks(agent);
      return Array.isArray(tasks) ? tasks : [];
    } catch (error) {
      debug('commander-mode: 读取任务板失败：%o', error);
      return [];
    }
  };

  /**
   * CAS 更新，遇到 `TEAM_TASK_STALE_REVISION` 重读重试一次；其余错误直接放弃。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @param {string} taskId - 任务 id。
   * @param {(view: object) => object} buildRequest - 根据最新视图构造 update 请求。
   * @returns {Promise<object | undefined>} 新视图；失败 undefined。
   */
  const safeUpdate = async (service, agent, taskId, buildRequest) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = readTask(service, agent, taskId);
      if (view === undefined) return undefined;
      try {
        // 服务端要求每次变更带 expectedRevision（CAS）；调用方可以用 buildRequest 覆盖。
        return await service.updateTask(agent, { taskId, expectedRevision: view.revision, ...buildRequest(view) });
      } catch (error) {
        const code = teamErrorCode(error);
        if (code === 'TEAM_TASK_STALE_REVISION' && attempt === 0) continue;
        warnFailure(`更新任务 ${taskId} `, error);
        return undefined;
      }
    }
    return undefined;
  };

  /**
   * 收养已存在的任务（模型按旧协议自己建的）或新建一个。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @param {object} ticket - 工单记录。
   * @returns {Promise<{ taskId: string, task: object } | undefined>} 结果。
   */
  const adoptOrCreate = async (service, agent, ticket) => {
    const content = projectContent(ticket);
    const tasks = listTasks(service, agent);
    const own = tasks.find((task) => projectedTicketId(task) === ticket.id);
    if (own !== undefined) return { taskId: own.id, task: own };

    const legacy = tasks.find((task) => !isProjectedTask(task) && mentionsTicket(task.description, ticket.id));
    if (legacy !== undefined) {
      const description = mergeDescription(legacy.description, content, ticket.id);
      const edited = await safeUpdate(service, agent, legacy.id, () => ({ action: 'edit', description }));
      if (edited !== undefined) return { taskId: edited.id, task: edited };
      return undefined;
    }

    try {
      const created = await service.createTask(agent, {
        subject: content.subject,
        description: content.description,
        writeScopes: content.writeScopes,
      });
      if (created === null || created === undefined || typeof created.id !== 'string') return undefined;
      return { taskId: created.id, task: created };
    } catch (error) {
      warnFailure('创建共享任务：', error);
      return undefined;
    }
  };

  /**
   * 确保任务存在：有映射就复用；被删除且工单未结束则重建。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @param {object} ticket - 工单记录。
   * @returns {Promise<{ taskId: string, task: object } | undefined>} 结果。
   */
  const ensureTask = async (service, agent, ticket) => {
    const mapped = typeof ticket.teamTaskId === 'string' && TASK_ID_RE.test(ticket.teamTaskId)
      ? ticket.teamTaskId
      : undefined;
    if (mapped !== undefined) {
      const view = readTask(service, agent, mapped);
      if (view !== undefined && view.status !== 'deleted') return { taskId: mapped, task: view };
      // 任务被删除：终态工单不再重建（避免复活已结束的活）。
      const terminal = ticket.status === 'done' || ticket.status === 'cancelled';
      if (terminal) return undefined;
    }
    return await adoptOrCreate(service, agent, ticket);
  };

  /**
   * 把任务 status 推到与工单一致（只能表达 4 个状态，其余靠描述 marker）。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @param {object} ticket - 工单记录。
   * @param {object} view - 当前任务视图。
   * @returns {Promise<object | undefined>} 更新后的视图；任务应被删除/无法处理时 undefined。
   */
  const applyStatus = async (service, agent, ticket, view) => {
    if (ticket.status === 'cancelled') {
      if (view.status === 'deleted') return undefined;
      // 删除失败（例如还有依赖者）不重试；工单侧仍是权威。
      return (await safeUpdate(service, agent, view.id, () => ({ action: 'delete' }))) ?? view;
    }
    if (ticket.status === 'done') {
      if (view.status === 'completed') return view;
      if (view.status === 'deleted') return undefined;
      if (view.status === 'pending') {
        // 任务板要求 completed 只能从 in_progress 进入：Lead 先认领再完成。
        const claimed = await safeUpdate(service, agent, view.id, () => ({ action: 'claim' }));
        if (claimed === undefined) return view;
        return (await safeUpdate(service, agent, view.id, () => ({ action: 'complete' }))) ?? claimed;
      }
      return (await safeUpdate(service, agent, view.id, () => ({ action: 'complete' }))) ?? view;
    }
    // 非终态工单：任务已被别人标成 completed → 重开，避免板在说谎。
    if (view.status === 'completed') {
      return (await safeUpdate(service, agent, view.id, () => ({ action: 'reopen' }))) ?? view;
    }
    return view;
  };

  /**
   * 同步描述/标题/写作用域（只在变化时写，避免日志膨胀）。
   *
   * @param {object} service - 服务。
   * @param {object} agent - agent。
   * @param {object} ticket - 工单记录。
   * @param {object} view - 当前任务视图。
   * @returns {Promise<object | undefined>} 更新后的视图。
   */
  const applyContent = async (service, agent, ticket, view) => {
    const content = projectContent(ticket);
    const description = mergeDescription(view.description, content, ticket.id);
    const currentScopes = Array.isArray(view.writeScopes) ? view.writeScopes.map(String) : [];
    const sameScopes = currentScopes.length === content.writeScopes.length
      && content.writeScopes.every((scope, index) => currentScopes[index] === scope);
    if (description === view.description && view.subject === content.subject && sameScopes) return view;
    const next = await safeUpdate(service, agent, view.id, () => ({
      action: 'edit',
      subject: content.subject,
      description,
      writeScopes: content.writeScopes,
    }));
    return next ?? view;
  };

  /**
   * 把一个已存在的任务绑定给某个队友（Lead 权限的 reassign）。
   *
   * @param {object} agent - 指挥者 agent。
   * @param {object} ticket - 工单记录（需已有 `teamTaskId`）。
   * @param {string} ownerName - 队友名（`subagent` 返回的 member.target）。
   * @returns {Promise<object | undefined>} 任务视图；跳过/失败时 undefined。
   */
  const bindOwner = async (agent, ticket, ownerName) => {
    try {
      if (typeof ownerName !== 'string' || ownerName.trim() === '') return undefined;
      const service = available(agent);
      if (service === undefined) return undefined;
      if (typeof ticket?.teamTaskId !== 'string' || !TASK_ID_RE.test(ticket.teamTaskId)) return undefined;
      const view = readTask(service, agent, ticket.teamTaskId);
      if (view === undefined || view.status === 'deleted' || view.status === 'completed') return undefined;
      if (view.ownerName === ownerName.trim()) return view;
      const next = await safeUpdate(service, agent, ticket.teamTaskId, (current) => ({
        action: 'reassign',
        expectedRevision: current.revision,
        owner: ownerName.trim(),
      }));
      return next;
    } catch (error) {
      debug('commander-mode: 绑定任务 owner 失败：%o', error);
      return undefined;
    }
  };

  /**
   * 建投影（工单创建后调用一次）。已有映射时直接返回。
   *
   * @param {object} agent - 指挥者 agent。
   * @param {object} ticket - 工单记录。
   * @returns {Promise<{ taskId: string, task: object } | undefined>} 任务 id 与视图。
   */
  const createProjection = async (agent, ticket) => {
    try {
      if (ticket === null || typeof ticket !== 'object') return undefined;
      const service = available(agent);
      if (service === undefined) return undefined;
      if (typeof ticket.teamTaskId === 'string' && TASK_ID_RE.test(ticket.teamTaskId)) {
        const view = readTask(service, agent, ticket.teamTaskId);
        if (view !== undefined && view.status !== 'deleted') return { taskId: view.id, task: view };
      }
      return await adoptOrCreate(service, agent, ticket);
    } catch (error) {
      warnFailure('创建工单', error);
      return undefined;
    }
  };

  /**
   * 同步投影（任何工单变更后调用）。会自动创建缺失的任务。
   *
   * @param {object} agent - 指挥者 agent。
   * @param {object} ticket - 工单记录。
   * @returns {Promise<{ taskId: string, task: object } | undefined>} 任务 id 与视图。
   */
  const syncProjection = async (agent, ticket) => {
    try {
      if (ticket === null || typeof ticket !== 'object') return undefined;
      const service = available(agent);
      if (service === undefined) return undefined;
      let current = await ensureTask(service, agent, ticket);
      if (current === undefined) return undefined;
      current = { taskId: current.taskId, task: (await applyStatus(service, agent, ticket, current.task)) ?? current.task };
      if (current.task.status === 'deleted') return { taskId: current.taskId, task: current.task };
      const updated = await applyContent(service, agent, ticket, current.task);
      return { taskId: current.taskId, task: updated ?? current.task };
    } catch (error) {
      warnFailure('同步工单', error);
      return undefined;
    }
  };

  return { available, readTask: (agent, taskId) => {
    const service = available(agent);
    if (service === undefined) return undefined;
    try {
      return readTask(service, agent, taskId);
    } catch (error) {
      debug('commander-mode: 读取投影任务失败：%o', error);
      return undefined;
    }
  }, createProjection, syncProjection, bindOwner };
}
