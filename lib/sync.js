/**
 * 指挥者的「结算同步」状态机。
 *
 * ## 要解决的是什么
 *
 * 多子代理会话里最容易漏的不是派活，而是**结算**：任务板上的任务 done 了、计划和团队状态
 * 却还停在十分钟前。实测（2026-11-02 的硬核会员答题会话，1111 个事件）：
 *
 * - `todo_write` 全程只有 **5 次**，最后一次在 +61 分钟；此后 100 分钟里任务板完成/删除
 *   了 4 个任务，计划清单**一次都没更新**，直到用户亲口问「进度如何？同步更新任务」；
 * - 收尾报告发出时，任务板刚在 4 分钟前结算完，清单还是两小时前的快照。
 *
 * 根因不是模型不会用工具，而是**没人告诉它"此刻有未同步项"**：协议里只写了"用 todo_write
 * 记计划"，没写"每次结算后必须同步"。而只靠提示词是概率性的 —— 长会话里它会被淹没。
 *
 * 所以这里做成**确定性状态机 + 每轮可见的状态**：
 *
 * 1. 账本（`createSyncLedger`）只记录事实：任务板各状态、计划清单各项、两者的先后；
 * 2. 判定（`evaluateSync`）只回答一个问题：**现在有没有"已结算但未同步"的项**；
 * 3. 呈现（`renderSyncBoard` / `buildSyncNudge`）把结论放到模型**每一步**都会读到的地方
 *    （运行时时上下文），并在回合即将结束时用 `agent/turn-stopping` 兜底提醒一次。
 *
 * ## 为什么用"序号"而不是时间
 *
 * 同步的本质是**偏序**：计划清单的更新必须发生在任务结算之后。时间戳会被系统时钟、写盘
 * 时序、测试假数据搞乱；这里用一个只增的 `epoch`，由本模块在每次观测到变化时自增。
 * 于是"结算在清单之后" = `task.terminalEpoch > plan.epoch`，一个整数比较，不依赖任何时钟。
 *
 * ## 数据从哪来
 *
 * - **任务板**：`ctx.agentTeams.listTasks(agent)` 的实时 view（不读 session 事件 ——
 *   `session.eventAt()` 已弃用）。
 * - **计划清单**：`todo_write` 的入参（`tools/post-execute` 里拿到，整表替换语义）。
 * - **团队状态**：`ctx.agentTeams.listMembers(agent)`。
 *
 * 任何一项读不到（部署里没有「智能体团队」、没有 `todo_write`、服务抛错）都**降级为
 * "这一项未知"**，绝不因为读不到就拦人：本模块的所有判定都只会在**证据充分**时给出
 * 未同步项。
 *
 * @module dsh-commander-mode/lib/sync
 */

// ---------------------------------------------------------------- 常量 ---

/** 运行时时上下文里的条目标名。 */
export const SYNC_CONTEXT_NAME = 'commander:sync-board';

/**
 * 运行时上下文的排序位。
 *
 * 随附 `CONTEXT_ORDERS`：WORKING_DIRECTORY 100 / SANDBOX_POLICY 110 /
 * APPROVAL_POLICY 115 / SUBAGENT_DELEGATION 120 / TEAM_IDENTITY 125。
 * 排在 team 身份之后、harness 源码（200）之前，让"当前团队与任务板状态"紧跟在
 * 团队策略后面被读到。
 */
export const SYNC_CONTEXT_ORDER = 130;

/** 任务板上的**未结算**状态：还需要执行者动作。 */
export const OPEN_TASK_STATUSES = Object.freeze(['pending', 'in_progress']);

/**
 * 任务板上的**已结算**状态。
 *
 * `deleted` 也算结算：`listTasks()` 不返回墓碑，所以一个任务从视图里消失 = 被删除；
 * 删除同样意味着"这一项不该再出现在计划清单的未完成里"。
 */
export const TERMINAL_TASK_STATUSES = Object.freeze(['completed', 'deleted']);

/** 计划清单里算"还没做完"的状态（`todo_write` 的枚举只有 pending/in_progress/completed）。 */
export const TODO_OPEN_STATUSES = Object.freeze(['pending', 'in_progress']);

/** 看板里最多点名几个未结算任务 / 几个成员，避免长板/大队列把一行撑爆。 */
const MAX_LISTED_TASKS = 4;
const MAX_LISTED_MEMBERS = 6;

/** 最近派发的通道序列保留长度（判断"是不是一直只用一次性 specialist"）。 */
const RECENT_DELEGATIONS = 8;

/**
 * 孤儿任务的宽限期：一个未结算任务"没人认领 / 主人已停手"超过这么久才报。
 *
 * 10 分钟是刻意留够的：规划阶段一次建 5-15 个任务是常态，前几个还没轮到认领，
 * 过早报警只会制造噪声。2026-11-02 那次会话里 3 个任务躺了 **两天**，10 分钟足够区分。
 */
export const STALE_OPEN_GRACE_MS = 10 * 60 * 1000;

/** 派发通道类别：Team 通道（teammate + 任务板）与一次性 specialist。 */
export const DELEGATION_CHANNELS = Object.freeze({
  TEAM: 'team',
  ONE_SHOT: 'one-shot',
});


// ---------------------------------------------------------------- 判定 ---

/** 是否为未结算的任务状态。 */
export function isOpenTaskStatus(status) {
  return typeof status === 'string' && OPEN_TASK_STATUSES.includes(status);
}

/** 是否为已结算的任务状态。 */
export function isTerminalTaskStatus(status) {
  return typeof status === 'string' && TERMINAL_TASK_STATUSES.includes(status);
}

/** 是否为未完成的计划项状态。 */
export function isOpenTodoStatus(status) {
  return typeof status === 'string' && TODO_OPEN_STATUSES.includes(status);
}

// ---------------------------------------------------------------- 账本 ---

/**
 * 新建一份同步账本（每个指挥者 agent 一份）。
 *
 * 字段都是**内部状态**，外部只应该通过 `recordPlan` / `recordBoard` 写入、
 * 通过 `evaluateSync` 读取。
 *
 * @returns {object} 账本。
 */
export function createSyncLedger() {
  return {
    /** 只增序号：任何观测到的变化都 +1，用来比较"谁在谁之后"。 */
    epoch: 0,
    /** 计划清单：`{ items, total, openCount, epoch }`，从未写过时 undefined。 */
    plan: undefined,
    /** 任务板：`Map<taskId, { id, status, terminalEpoch, changedAt, ready }>`；从未观测过时 undefined。 */
    tasks: undefined,
    /** 最近一次**终态**变化的序号；没有终态变化时为 0。 */
    terminalEpoch: 0,
    /**
     * 派发通道计数（0.5.0）：Team 通道 = `spawn_teammate` / `send_message` / `wait_agent` /
     * `interrupt_agent`；一次性 = `subagent_<id>` / `subagent` / `subagent_fork` / `workflow`。
     *
     * 用来发现"团队闲置"：任务板还开着，派活却全走一次性 specialist。
     */
    delegations: { team: 0, oneShot: 0 },
    /** 最近几次派发的通道（按时间顺序，只留最近 `RECENT_DELEGATIONS` 条）。 */
    recentDelegations: [],
    /** 孤儿任务提醒是否已经兜过底（每条会话最多强提醒一次，之后只留在看板里）。 */
    staleNudged: false,
  };
}

/**
 * 记一次派发（0.5.0）。
 *
 * 只统计**派活**动作，不统计读状态（`list_agents` / `team_task_list`）—— 后者恰恰是要
 * 被看板替代掉的轮询。
 *
 * @param {object} ledger - 账本。
 * @param {string} kind - `'team'` 或 `'one-shot'`。
 * @param {string} [tool] - 工具名（诊断用）。
 * @returns {void}
 */
export function recordDelegation(ledger, kind, tool = '') {
  if (ledger === null || typeof ledger !== 'object') return;
  if (kind !== DELEGATION_CHANNELS.TEAM && kind !== DELEGATION_CHANNELS.ONE_SHOT) return;
  if (ledger.delegations === undefined) ledger.delegations = { team: 0, oneShot: 0 };
  if (kind === DELEGATION_CHANNELS.TEAM) ledger.delegations.team += 1;
  else ledger.delegations.oneShot += 1;
  if (!Array.isArray(ledger.recentDelegations)) ledger.recentDelegations = [];
  ledger.recentDelegations.push({ kind, tool });
  if (ledger.recentDelegations.length > RECENT_DELEGATIONS) ledger.recentDelegations.splice(0, ledger.recentDelegations.length - RECENT_DELEGATIONS);
}

/**
 * 记一次任务板快照，并与上一份比较。
 *
 * 只关心两件事：**变没变**（别把没变化的快照当新事件）与**有没有进入终态**
 * （只有终态变化才要求计划清单同步 —— 队友认领一个任务不需要改计划）。
 *
 * @param {object} ledger - `createSyncLedger()` 的产物。
 * @param {unknown} tasks - `agentTeams.listTasks(agent)` 的返回（数组）。
 * @param {number} [now] - 当前时间戳（毫秒，测试注入；默认 `Date.now()`）。
 * @returns {{ changed: boolean, terminal: boolean, terminalIds: string[] }} 本次观测结果。
 */
export function recordBoard(ledger, tasks, now = Date.now()) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const next = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id === '') continue;
    const status = typeof row.status === 'string' ? row.status : 'unknown';
    next.set(id, {
      id,
      status,
      subject: typeof row.subject === 'string' ? row.subject : '',
      ownerName: typeof row.ownerName === 'string' ? row.ownerName : '',
      // `ready` 只在真实 view 里有（pending 且依赖已满足）；缺省按"可执行"处理，
      // 否则老 view / 手写夹具上的孤儿任务会被静默漏掉。
      ready: row.ready !== false,
      blockedBy: Array.isArray(row.blockedBy) ? row.blockedBy.map(String) : [],
    });
  }

  if (ledger.tasks === undefined) {
    // 第一次观测只建基线：此刻任务板上已经存在的终态项**不算**新结算 —— 它们早于账本
    // 存在，要求"同步"没有意义。terminalEpoch 留 0，永远不会大于任何 plan.epoch。
    for (const row of next.values()) {
      row.terminalEpoch = 0;
      row.changedAt = now;
    }
    ledger.tasks = next;
    return { changed: false, terminal: false, terminalIds: [] };
  }

  let changed = false;
  const terminalIds = [];
  const merged = new Map();

  for (const [id, row] of next) {
    const previous = ledger.tasks.get(id);
    if (previous === undefined) {
      // 新任务：只有"创建即终态"这种少见情况才影响同步判定。
      changed = true;
      const terminalEpoch = isTerminalTaskStatus(row.status) ? ledger.epoch + 1 : 0;
      merged.set(id, { ...row, terminalEpoch, changedAt: now });
      if (terminalEpoch > 0) terminalIds.push(id);
      continue;
    }
    const changedFields = previous.status !== row.status
      || previous.ownerName !== row.ownerName
      || previous.ready !== row.ready;
    if (!changedFields) {
      merged.set(id, { ...row, terminalEpoch: previous.terminalEpoch, changedAt: previous.changedAt });
      continue;
    }
    changed = true;
    const enteredTerminal = isTerminalTaskStatus(row.status) && !isTerminalTaskStatus(previous.status);
    const terminalEpoch = enteredTerminal ? ledger.epoch + 1 : previous.terminalEpoch;
    merged.set(id, { ...row, terminalEpoch, changedAt: now });
    if (enteredTerminal) terminalIds.push(id);
  }

  for (const [id, previous] of ledger.tasks) {
    if (next.has(id)) continue;
    // 从 listTasks() 的视图里消失 = 被删除（墓碑不在 view 里）。删除也是终态变化。
    changed = true;
    terminalIds.push(id);
    merged.set(id, { ...previous, status: 'deleted', terminalEpoch: ledger.epoch + 1, changedAt: now });
  }

  if (!changed) return { changed: false, terminal: false, terminalIds: [] };

  ledger.epoch += 1;
  ledger.tasks = merged;
  if (terminalIds.length > 0) {
    ledger.terminalEpoch = ledger.epoch;
    return { changed: true, terminal: true, terminalIds };
  }
  return { changed: true, terminal: false, terminalIds: [] };
}

/**
 * 记一次计划清单更新（`todo_write` 的整表替换语义）。
 *
 * @param {object} ledger - 账本。
 * @param {unknown} todos - `todo_write` 的 `todos` 入参。
 * @returns {{ total: number, openCount: number } | undefined} 归一化后的统计；入参非法时 undefined。
 */
export function recordPlan(ledger, todos) {
  if (!Array.isArray(todos)) return undefined;
  const items = [];
  for (const item of todos) {
    if (item === null || typeof item !== 'object') continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content === '') continue;
    const status = typeof item.status === 'string' ? item.status : 'pending';
    items.push({ content, status });
  }
  const openCount = items.filter((item) => isOpenTodoStatus(item.status)).length;
  ledger.epoch += 1;
  ledger.plan = { items, total: items.length, openCount, epoch: ledger.epoch };
  return { total: items.length, openCount };
}

// ---------------------------------------------------------------- 视图 ---

/** 把任务 id 列表压成 `task-3、task-7` 这样的短句。 */
function joinIds(ids) {
  const shown = ids.slice(0, MAX_LISTED_TASKS);
  const rest = ids.length - shown.length;
  const text = shown.join('、');
  return rest > 0 ? `${text} 等 ${ids.length} 项` : text;
}

/**
 * 评估当前账本，产出"有没有要处理的项"的只读视图。
 *
 * 五类问题（都是**证据充分**才报）：
 *
 * 1. `plan-stale` —— 任务结算发生在计划清单最后一次更新之后。这是本模块存在的理由。
 * 2. `board-open-plan-closed` —— 清单说全做完了，任务板还有未结算任务（反向不一致）。
 * 3. `plan-missing` —— 任务板上有已结算任务，但**从未**写过计划清单。（弱提醒：
 *    简单任务可能根本不需要清单，所以只放进提示、不触发回合拦截。）
 * 4. `board-stale-open` —— **孤儿任务**：未结算、没人认领或主人已停手、且超过宽限期。
 *    2026-11-02 那次会话最后留下 6 项没收尾（3 项从未认领、3 项主人已 inactive），
 *    看板当时只说"未结算 6 项"，没人动。
 * 5. `channel-drift` —— **团队闲置**：任务板还开着，最近几次派活却全走一次性 specialist。
 *    同一次会话从 seq 1000 起 Team 通道归零、13+2 次派活全是一次性 specialist。
 *
 * @param {object} ledger - 账本。
 * @param {object} [options] - 评估参数。
 * @param {object[]} [options.members] - `agentTeams.listMembers(agent)` 的返回（判断主人在不在跑）。
 * @param {number} [options.now] - 当前时间戳（毫秒，测试注入；默认 `Date.now()`）。
 * @returns {object} 视图（见下方字段）。
 */
export function evaluateSync(ledger, options = {}) {
  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  const members = Array.isArray(options?.members) ? options.members : [];
  const hasBoard = ledger.tasks !== undefined && ledger.tasks.size > 0;
  const tasks = ledger.tasks === undefined ? [] : [...ledger.tasks.values()];
  const openTasks = tasks.filter((task) => isOpenTaskStatus(task.status));
  const terminalTasks = tasks.filter((task) => isTerminalTaskStatus(task.status));
  const plan = ledger.plan;
  const issues = [];

  if (plan !== undefined && hasBoard) {
    const planEpoch = plan.epoch;
    const unsynced = terminalTasks.filter((task) => task.terminalEpoch > planEpoch);
    if (unsynced.length > 0) {
      issues.push({ code: 'plan-stale', taskIds: unsynced.map((task) => task.id), detail: `${joinIds(unsynced.map((task) => task.id))} 已结算，但计划清单在那之后没有更新` });
    }
    if (plan.openCount === 0 && openTasks.length > 0) {
      issues.push({ code: 'board-open-plan-closed', taskIds: openTasks.map((task) => task.id), detail: `计划清单已全部完成，但任务板还有未结算任务（${joinIds(openTasks.map((task) => task.id))}）` });
    }
  }

  if (plan === undefined && terminalTasks.length > 0) {
    issues.push({ code: 'plan-missing', taskIds: terminalTasks.map((task) => task.id), detail: '任务板已有结算项，但从未写过计划清单（todo_write）' });
  }

  // ---- 孤儿任务：没人认领 / 主人已停手 / 依赖已满足 / 超过宽限期 ----
  const teammateNames = new Set(members
    .filter((member) => member !== null && typeof member === 'object' && member.role !== 'lead' && typeof member.name === 'string')
    .map((member) => member.name));
  const inactiveNames = new Set(members
    .filter((member) => member !== null && typeof member === 'object' && member.role !== 'lead' && member.status === 'inactive' && typeof member.name === 'string')
    .map((member) => member.name));
  const staleOpen = openTasks.filter((task) => {
    const age = now - (Number.isFinite(task.changedAt) ? task.changedAt : now);
    if (age < STALE_OPEN_GRACE_MS) return false;
    // 依赖还没完成的 pending 任务不是孤儿（它只是在排队）。
    if (task.status === 'pending' && task.ready === false) return false;
    if (task.ownerName === '') return true; // 从未被认领
    return inactiveNames.has(task.ownerName); // 认领了，但主人已经停手
  });
  if (staleOpen.length > 0) {
    const unowned = staleOpen.filter((task) => task.ownerName === '');
    const orphaned = staleOpen.filter((task) => task.ownerName !== '');
    const bits = [];
    if (unowned.length > 0) bits.push(`${joinIds(unowned.map((task) => task.id))} 从未被认领`);
    if (orphaned.length > 0) bits.push(`${joinIds(orphaned.map((task) => `${task.id}（${task.ownerName || '无主'} 已停手）`))} 的主人已停手`);
    issues.push({
      code: 'board-stale-open',
      taskIds: staleOpen.map((task) => task.id),
      detail: `任务板有孤儿任务：${bits.join('；')}`,
    });
  }

  // ---- 团队闲置：任务板还开着，派活却全走一次性 specialist ----
  const recent = Array.isArray(ledger.recentDelegations) ? ledger.recentDelegations : [];
  const recentKinds = recent.slice(-3).map((entry) => entry?.kind);
  const channelDrift = hasBoard
    && openTasks.length > 0
    && recentKinds.length === 3
    && recentKinds.every((kind) => kind === DELEGATION_CHANNELS.ONE_SHOT);
  if (channelDrift) {
    issues.push({
      code: 'channel-drift',
      taskIds: openTasks.map((task) => task.id),
      detail: `最近 3 次派活都走一次性 specialist，而任务板还有 ${openTasks.length} 项未结算（${joinIds(openTasks.map((task) => task.id))}）`,
    });
  }

  return {
    hasBoard,
    boardTotal: tasks.length,
    openTasks: openTasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject, ownerName: task.ownerName })),
    staleOpenTasks: staleOpen.map((task) => ({ id: task.id, status: task.status, ownerName: task.ownerName })),
    doneCount: terminalTasks.length,
    settled: hasBoard && openTasks.length === 0,
    hasPlan: plan !== undefined,
    planTotal: plan?.total ?? 0,
    planOpenCount: plan?.openCount ?? 0,
    /** 计划清单最后更新是否早于最近一次任务结算 —— 收尾报告的常见翻车点。 */
    planBehindBoard: plan !== undefined && ledger.terminalEpoch > plan.epoch,
    /** 派发通道计数（Team / 一次性）。 */
    channels: {
      team: ledger.delegations?.team ?? 0,
      oneShot: ledger.delegations?.oneShot ?? 0,
    },
    /** 团队里有没有 teammate（Lead 自己不参与渲染，members 已由调用方过滤掉的动作在 agent.js 里）。 */
    teammateCount: teammateNames.size,
    issues,
  };
}

/**
 * 渲染每轮运行时时上下文里那一行「同步看板」。
 *
 * 没有任务板、没有计划清单、也没有队友时返回 `''` —— 早期回合不产生任何 token 成本。
 * 有内容时也只给**结论**（几项、谁没结算、缺什么），不复述任务描述。
 *
 * @param {object} view - `evaluateSync()` 的返回值。
 * @param {object[]} [members] - `agentTeams.listMembers(agent)` 的返回（成员 view）。
 * @returns {string} 看板文本；无内容时 `''`。
 */
export function renderSyncBoard(view, members = []) {
  if (view === null || typeof view !== 'object') return '';
  const parts = [];

  if (view.hasBoard) {
    const openText = view.openTasks.length === 0
      ? '无未结算'
      : `未结算 ${view.openTasks.length} 项：${view.openTasks
        .slice(0, MAX_LISTED_TASKS)
        .map((task) => `${task.id} ${task.status}${task.ownerName === '' ? '' : `（${task.ownerName}）`}`)
        .join('、')}`;
    parts.push(`任务板 ${view.doneCount}/${view.boardTotal} 已结算（${openText}）`);
  }

  if (view.hasPlan) {
    parts.push(`计划清单 ${view.planTotal - view.planOpenCount}/${view.planTotal} 已完成${view.planOpenCount > 0 ? `（${view.planOpenCount} 项未完成）` : ''}`);
  } else if (view.hasBoard) {
    parts.push('计划清单：未建立');
  }

  const memberRows = Array.isArray(members) ? members : [];
  if (memberRows.length > 0) {
    const shown = memberRows.slice(0, MAX_LISTED_MEMBERS).map((member) => {
      const name = typeof member?.name === 'string' && member.name !== '' ? member.name : '成员';
      // ⚠️ 真实服务（`agentTeams.listMembers()`）给的是 `status`（running / inactive /
      // provisioning / failed，来自 `availability()`）；`phase` 只出现在 `team/member`
      // 事件里。两个都读，是为了一边对齐真实 view、一边容忍旧版/手写夹具。
      const state = typeof member?.status === 'string' && member.status !== ''
        ? member.status
        : (typeof member?.phase === 'string' ? member.phase : 'unknown');
      return `${name} ${state}`;
    });
    parts.push(`团队 ${memberRows.length} 人：${shown.join('、')}`);
  } else if (view.hasBoard && view.openTasks?.length > 0) {
    // 有未结算任务却没有 teammate —— 这正是"重启后团队没了，于是退回一次性 specialist"的现场。
    parts.push('团队：**无 teammate**（重启后旧队友不会自动复活，需要人时用 spawn_teammate 补）');
  }

  // 派发通道配比：只在确实有派发记录时出现，避免早期回合的噪声。
  const channels = view.channels;
  if (channels !== undefined && (channels.team > 0 || channels.oneShot > 0)) {
    parts.push(`派发通道：Team ${channels.team} 次 / 一次性 specialist ${channels.oneShot} 次`);
  }

  if (parts.length === 0) return '';

  const issues = Array.isArray(view.issues) ? view.issues : [];
  const header = '【指挥者·同步看板】';
  if (issues.length === 0) return `${header}${parts.join('；')}。状态以此为准，不要用 list_agents / team_task_list 轮询。`;

  const asks = issues.map((issue) => {
    if (issue.code === 'plan-stale') return `⚠️ ${issue.detail} → 先 todo_write 同步（完成项标 completed，新工作补进去），再回复用户。`;
    if (issue.code === 'board-open-plan-closed') {
      return `⚠️ ${issue.detail} → 让 owner（小组长）结算：用 send_message 让 owner 自己 team_task_update complete；指挥官不要自己改任务板进度（要换人就 reassign）。`;
    }
    if (issue.code === 'board-stale-open') {
      return `⚠️ ${issue.detail} → **建板必有主**：用 spawn_teammate 按任务定位补一个 teammate，并 reassign 给它、让它自己 claim；已有 owner 但已停手 → send_message 唤醒它结算；指挥官不要自己 claim/complete，作废的任务可以用 delete 清理。`;
    }
    if (issue.code === 'channel-drift') {
      return `⚠️ ${issue.detail} → 派活只走 Team（spawn_teammate + send_message 交给小组长）；一次性子智能体工具由小组长自己使用，指挥官不要调用。`;
    }
    return `⚠️ ${issue.detail} → 先用 todo_write 把计划清单建起来（与任务板一致）。`;
  });
  return `${header}${parts.join('；')}。\n${asks.join('\n')}`;
}

/**
 * 决定本次回合兜底要不要把"孤儿任务"纳入提醒，并把"已经强提醒过"记到账本上。
 *
 * 孤儿任务会**一直**留在看板里（每一步都可见），但不该每回合都用注入拦人 ——
 * 所以每条会话只强制提醒一次，之后降级为看板常驻提示。
 *
 * @param {object} ledger - 账本。
 * @param {object} view - `evaluateSync()` 的返回值。
 * @returns {boolean} 本次提醒是否包含孤儿任务。
 */
export function consumeStaleNudge(ledger, view) {
  const issues = Array.isArray(view?.issues) ? view.issues : [];
  const includeStale = ledger?.staleNudged !== true;
  if (issues.some((issue) => issue.code === 'board-stale-open')) {
    if (ledger !== null && typeof ledger === 'object') ledger.staleNudged = true;
  }
  return includeStale;
}

/**
 * 回合即将结束时的兜底提醒（`agent/turn-stopping` 注入）。
 *
 * 措辞要满足三点：说明**哪一项**没同步、给出**具体工具**、明确**不要重复刚才的报告**
 * （否则用户会看到两条几乎一样的收尾）。
 *
 * @param {object} view - `evaluateSync()` 的返回值。
 * @param {object} [options] - 提醒参数。
 * @param {boolean} [options.includeStale] - 是否把孤儿任务也纳入本次提醒（默认 `true`；
 *   调用方可以按"每条会话只强提醒一次"把后续的降级成看板常驻提示）。
 * @returns {string} 提醒文本；没有需要同步的项时 `''`。
 */
export function buildSyncNudge(view, options = {}) {
  const includeStale = options?.includeStale !== false;
  const issues = Array.isArray(view?.issues) ? view.issues : [];
  // `plan-missing` 不拦回合：简单任务本来就可以不建清单，拦截会制造噪声。
  // `channel-drift` 也不拦：它是"通道选择建议"，看板里常驻即可，用注入拦回合太吵。
  const blocking = issues.filter((issue) => {
    if (issue.code === 'plan-missing' || issue.code === 'channel-drift') return false;
    if (issue.code === 'board-stale-open' && !includeStale) return false;
    return true;
  });
  if (blocking.length === 0) return '';
  return [
    '【指挥者·结算同步】这一回合要结束了，但看板上还有要处理的事：',
    ...blocking.map((issue) => {
      if (issue.code === 'plan-stale') return `- ${issue.detail}：用 todo_write 把对应项标成 completed（有新增工作一并写进去）。`;
      if (issue.code === 'board-stale-open') {
        return `- ${issue.detail}：用 spawn_teammate 补一个 teammate 认领（长任务），再用 send_message 让它自己 team_task_update 结算；指挥官不要自己 claim/complete（作废的任务可以 delete 清理）；不要让它们继续挂着。`;
      }
      return `- ${issue.detail}：用 send_message 让 owner（小组长）自己结算（它用 team_task_get 拿 revision、team_task_update 改状态）；指挥官不要自己改任务板进度。`;
    }),
    '处理完再结束回合；**不要重复刚才的报告**，只补 1–2 行回执（处理了什么、现在的看板状态）。',
  ].join('\n');
}
