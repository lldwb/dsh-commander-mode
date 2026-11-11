/**
 * 派发门禁 —— 把「计划确认后才派活」「每件活有工单」从提示词升级为确定性检查（0.6.0）。
 *
 * ## 为什么是代码
 *
 * README 自己承认：「规划后先确认」「分歧上报」由协议保证，模型偶尔会跳过。0.4/0.5 的
 * 事故里最贵的一种正是"没确认就派了一堆活"。这里用与「指挥者不执行」相同的机制
 * （`tools/pre-execute` 返回 deny）把它变成可测试的规则：
 *
 * - 没有**有效的计划授权（Mandate）** → 拒绝派发；
 * - 有授权但派发没带**工单 id** → 拒绝（要求先 `commander_ticket_create`）；
 * - 工单不存在/已结束/不属于本会话/建立时的授权已过期 → 拒绝。
 *
 * ## 必须放行的情形（与 `lib/guard.js` 同一原则：宁可漏拦，不可拦死）
 *
 * - 子代理（teammate/subagent）自己调用派发工具：它们不是指挥者，不该被指挥者的门禁拦；
 * - 这个部署没有账本服务：降级回 0.5 行为（只靠协议）；
 * - 读不到会话 id / 读不到工单：当作"未知"放行，并让调用方日志可见；
 * - `requireMandate: false`：用户显式关掉这套规则。
 *
 * ## 哪些工具有"新工作"语义
 *
 * 只有**开启一件新活**的工具受门禁约束：一次性子代理、workflow、spawn_teammate。
 * `send_message` 是对已有 teammate 的追加/续做，不算新工作；`wait_agent` / `list_agents` /
 * `team_task_*` 是等待与状态操作，也不拦。
 *
 * @module dsh-commander-mode/lib/dispatch-gate
 */

import { isDelegatedAgent } from './guard.js';
import { isTerminal, PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID } from './tickets.js';

/** 具有"开启新工作"语义的工具（specialist 工具按 `subagent_` 前缀识别）。 */
export const NEW_WORK_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'commander_worker_spawn',
]);

/** 工单标记：`[ticket:t-1]`（Team 工具没有 ticket 参数，只能靠 prompt 标记）。 */
export const TICKET_MARKER = /\[ticket:([A-Za-z0-9_.-]+)\]/;

/**
 * 判断一次工具调用是否属于"派发新工作"。
 *
 * @param {string} name - 工具名。
 * @returns {boolean} 是否需要 Mandate/工单。
 */
export function isNewWorkTool(name) {
  const toolName = typeof name === 'string' ? name : '';
  if (toolName === '') return false;
  if (NEW_WORK_TOOLS.includes(toolName)) return true;
  return toolName.startsWith('subagent_');
}

/**
 * 从派发参数里提取工单 id。
 *
 * 两条来源（按优先级）：
 * 1. 工具参数 `ticket`（本插件给 specialist 工具加的字段）；
 * 2. task/prompt/message 文本里的 `[ticket:t-N]` 标记（Team 工具只有自由文本）。
 *
 * @param {unknown} args - 工具参数。
 * @returns {string | undefined} 工单 id。
 */
export function ticketFromDispatchArgs(args) {
  if (args === null || typeof args !== 'object') return undefined;
  if (typeof args.ticket === 'string' && args.ticket.trim() !== '') return args.ticket.trim();
  for (const key of ['task', 'prompt', 'message', 'description']) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const match = TICKET_MARKER.exec(value);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * 从派发参数里提取共享任务标记 `[task:task-N]`（1.2.0，D-2）。
 *
 * Team 工具没有 `task` 参数，只能靠 prompt 首行的标记；与 `[ticket:t-N]` 同一约定。
 *
 * @param {unknown} args - 工具参数。
 * @returns {string | undefined} 任务 id。
 */
export function taskFromDispatchArgs(args) {
  if (args === null || typeof args !== 'object') return undefined;
  for (const key of ['prompt', 'task', 'message', 'description']) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const match = /\[task:(task-\d+)\]/u.exec(value);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * 判断一次派发是否通过门禁。
 *
 * ## 3.3.0：自愈，而不是把矛盾甩给模型
 *
 * 会话 def6609d 的现场：工单没有任务板投影 → 这里拒绝 `spawn_teammate` 并让模型
 * "更新工单状态（例如 progress）触发投影"；而 3.0.0 起指挥官改工单推进状态被层级门禁
 * 拒绝 → **两条门禁互相矛盾**，Team 通道永久不可用。
 *
 * 现在改为：缺投影时调用 `ensureTeamTask`（由插件提供，内部走投影器**自己补建**），
 * 成功就直接放行；只有补建失败才拒绝，且拒绝理由只给**当前实现允许**的动作
 * （只改描述字段 / 改用 Worker Session），绝不再让模型去调被别的门禁禁止的东西。
 *
 * 因为补建是异步的，本函数现在是 **async**。
 *
 * @param {object} input - 判定输入。
 * @param {unknown} input.agent - 发起调用的 agent。
 * @param {string} input.name - 工具名。
 * @param {unknown} input.args - 工具参数。
 * @param {boolean} input.requireMandate - 是否要求计划授权。
 * @param {boolean} input.requireTicket - 是否要求工单归属。
 * @param {object | undefined} input.ledger - `commanderLedger` 服务（可能缺失）。
 * @param {boolean} [input.requireTeamTask] - D-1：Team 通道派发要求工单已有有效投影（默认开）。
 * @param {boolean} [input.requireTeamTaskMarker] - D-2：要求 prompt 带 `[task:task-N]`（默认关）。
 * @param {{ getTask: (taskId: string) => object | undefined } | undefined} [input.teamBoard]
 *   - 当前 agent 可用的任务板适配器；`undefined` = 本部署没有 Agent Teams（整段跳过）。
 * @param {(agent: unknown, ticket: object) => Promise<string | undefined>} [input.ensureTeamTask]
 *   - 3.3.0 自愈：补建工单的任务板投影，返回任务 id（失败返回 `undefined`）。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名（3.4.0 降级判定用：
 *   没有 `ask_user_question` 时跳过计划授权门禁，否则整个模式派不出活）。
 *   `undefined` 表示读不到视图，按"都有"处理。
 * @returns {Promise<{ kind: 'deny', reason: string } | undefined>} 拒绝决策或放行。
 */
export async function evaluateDispatchGate({
  agent,
  name,
  args,
  requireMandate,
  requireTicket,
  ledger,
  requireTeamTask,
  requireTeamTaskMarker,
  teamBoard,
  ensureTeamTask,
  availableTools,
}) {
  if (requireMandate !== true) return undefined;
  if (isDelegatedAgent(agent)) return undefined;
  if (!isNewWorkTool(name)) return undefined;
  if (ledger === undefined || ledger === null) return undefined; // 降级：没有账本只靠协议。

  const sessionId = sessionIdOf(agent);
  if (sessionId === undefined) return undefined; // 身份不明 → 放行（宁可漏拦）。

  let mandate;
  let tickets;
  try {
    mandate = ledger.activeMandate(sessionId);
    tickets = ledger.listTickets(sessionId);
  } catch {
    return undefined; // 读不到状态不拦。
  }

  if (mandate === null) {
    // 3.4.0 降级放行：拿不到 `ask_user_question` 时**永远无法记录授权**（Mandate 只从
    // 这个工具的 post-execute 结果里记录）。此时若仍拒绝派发，整个模式会死锁 ——
    // 和「没有 Team 通道时拦掉一次性子智能体」是同一类冲突。
    // 判据：工具视图可读且确实没有 `ask_user_question`。读不到视图（`undefined`）按"有"处理。
    const canAskUser = !Array.isArray(availableTools) || availableTools.includes('ask_user_question');
    if (canAskUser) {
      return {
        kind: 'deny',
        reason: [
          `指挥者模式：派发新工作之前必须先让用户确认计划（没有有效的计划授权）。`,
          `请先调用 \`ask_user_question\`，并把问题 id 精确写成 \`${PLAN_QUESTION_ID}\`；问题正文里列出计划（目标、拆分、每步产出物、验收判据、分工）；`,
          `选项第一项 label 精确写成「${PLAN_CONFIRM_LABEL}」。用户选择它之后，本次派发才会被允许。`,
          '不要重试本工具；不要自己假装用户已确认。',
        ].join('\n'),
      };
    }
    // 没有 ask_user_question：跳过授权门禁（协议仍要求先把计划讲给用户）。
  }

  const ticketId = ticketFromDispatchArgs(args);
  if (ticketId === undefined) {
    if (requireTicket !== true) return undefined;
    const openIds = tickets.map((ticket) => ticket.id);
    return {
      kind: 'deny',
      reason: [
        '指挥者模式：每一次派发都必须挂在一张工单上（工单是这个模式里"一件被授权的活"）。',
        openIds.length === 0
          ? '当前会话还没有工单：先调用 `commander_ticket_create` 建工单（标题 + 验收判据）。'
          : `当前会话的工单：${openIds.join('、')}。先确认这次派发属于哪一张（一张工单可多次派发）；需要新工单就调用 \`commander_ticket_create\`。`,
        '派发时带上工单：一次性子代理工具传 `ticket` 参数；Team 工具在 task/prompt 首行写 `[ticket:t-N]`。',
        '不要重试本工具。',
      ].join('\n'),
    };
  }

  let ticket;
  try {
    ticket = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
  } catch {
    return undefined;
  }
  if (ticket === null) {
    return {
      kind: 'deny',
      reason: [
        `找不到工单 \`${ticketId}\`（或它不属于当前会话）。`,
        '先用 `commander_tickets` 查看当前会话的工单；需要新建就调用 `commander_ticket_create`。',
        '不要重试本工具。',
      ].join('\n'),
    };
  }
  if (isTerminal(ticket)) {
    return {
      kind: 'deny',
      reason: `工单 \`${ticket.id}\` 已结束（${ticket.status}），不能再往它上面派活。需要继续就新建工单，并在计划里说明为什么重开。`,
    };
  }
  // 3.4.0：降级路径下 mandate 为 null（没有 ask_user_question 可用来记录授权），
  // 此时没有"授权 id 对齐"这回事，跳过这项检查（工单本身的非终态校验仍然生效）。
  if (mandate !== null && ticket.mandateId !== mandate.id) {
    return {
      kind: 'deny',
      reason: [
        `工单 \`${ticket.id}\` 是在上一版计划下建立的，而用户刚确认了新计划（授权 ${mandate.id}）。`,
        '不要派到旧工单上：用 `commander_ticket_create` 按新计划建工单，或先向用户说明哪些旧工单要作废（`commander_ticket_update` 取消）。',
      ].join('\n'),
    };
  }

  // ---- D：Team 通道必须落在共享任务板上（1.2.0） --------------------------------
  if (name === 'spawn_teammate' && requireTeamTask !== false && teamBoard !== undefined) {
    let taskId = typeof ticket.teamTaskId === 'string' && /^task-\d+$/u.test(ticket.teamTaskId)
      ? ticket.teamTaskId
      : null;

    // 3.3.0 自愈：缺投影时**插件自己补建**，而不是让模型去触发。
    // 历史（会话 def6609d）：这里要求模型"调用 commander_ticket_update（例如 progress）触发投影"，
    // 而 3.0.0 起指挥官改工单推进状态会被层级门禁拒绝 —— 两条门禁互相矛盾，Team 通道永久不可用。
    let createdNow = false;
    if (taskId === null && typeof ensureTeamTask === 'function') {
      try {
        const ensured = await ensureTeamTask(agent, ticket);
        if (typeof ensured === 'string' && /^task-\d+$/u.test(ensured)) {
          taskId = ensured;
          createdNow = true;
        }
      } catch {
        // 自愈失败 → 走下面的拒绝分支（带可执行的替代路径）。
      }
    }

    if (taskId === null) {
      return {
        kind: 'deny',
        reason: [
          `工单 \`${ticket.id}\` 还没有共享任务板投影，Team 通道暂时不可用（插件已尝试自动补建，未成功）。`,
          '先尝试让投影重建：用 `commander_ticket_update` **只改描述字段**（title / intent / acceptance / scope，**不要带 status**），然后重新派发；',
          '仍然不行说明这个部署的任务板不可用：改用 `commander_worker_spawn` 派工（Worker Session 不要求任务板投影），或请用户检查「智能体团队」是否开启。',
          '⚠️ 不要用 `commander_ticket_update` 的 status（progress 等）来触发投影：推进状态属于小组长，指挥官调用会被层级门禁拒绝。',
          '不要重复派同一任务。',
        ].join('\n'),
      };
    }

    // 刚补建的任务一定存在且是 pending，不需要再读板校验；只有复用旧投影时才校验。
    if (!createdNow) {
      const taskView = teamBoard.getTask(taskId);
      if (taskView === undefined) {
        return {
          kind: 'deny',
          reason: [
            `工单 \`${ticket.id}\` 的投影任务 \`${taskId}\` 不存在（可能被删除）。`,
            '用 `commander_ticket_update` **只改描述字段**（不带 status）让它重建，再重新派发；',
            '仍然不行就改用 `commander_worker_spawn` 派工。不要用 status 触发（会被层级门禁拒绝）。',
          ].join('\n'),
        };
      }
      if (taskView.status === 'completed' || taskView.status === 'deleted') {
        return {
          kind: 'deny',
          reason: [
            `工单 \`${ticket.id}\` 的投影任务 \`${taskId}\` 已结束（${taskView.status}），不能再往这张工单派 teammate。`,
            '需要继续就新建工单，并在计划里说明为什么重开。',
          ].join('\n'),
        };
      }
    }
    if (requireTeamTaskMarker === true) {
      const marker = taskFromDispatchArgs(args);
      if (marker === undefined) {
        return {
          kind: 'deny',
          reason: [
            'Team 通道派发必须在 prompt 首行带 `[task:task-N]`（任务 id 见 `commander_ticket_create` 返回的 team_task_id）。',
            `本工单的投影任务是 \`${taskId}\`；把它写进 prompt，例如 \`[ticket:${ticket.id}] [task:${taskId}]\`。`,
            '不要重试本工具。',
          ].join('\n'),
        };
      }
      if (marker !== taskId) {
        return {
          kind: 'deny',
          reason: [
            `prompt 里的 \`[task:${marker}]\` 与这张工单的投影任务（\`${taskId}\`）不一致。`,
            `改用 \`[task:${taskId}]\`，或先调用 \`commander_ticket_update\` 重建投影。`,
            '不要重试本工具。',
          ].join('\n'),
        };
      }
    }
  }

  return undefined;
}

/** 从 agent 读会话 id；读不到返回 undefined。 */
export function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id;
    if (typeof id !== 'string' || id.trim() === '') return undefined;
    return id;
  } catch {
    return undefined;
  }
}

/** 供工具描述复用：一段简短的授权说明。 */
export const MANDATE_NOTE = '派发前必须已有用户确认的计划（`ask_user_question` 的问题 id = `commander-plan`），且每次派发都带工单 id。';
