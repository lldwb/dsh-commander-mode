/**
 * 派发门禁（`lib/dispatch-gate.js`）的测试。
 *
 * 这是 0.6.0 里"把提示词变成确定性规则"的关键一层：没有计划授权 / 没有工单的派发
 * 必须被拒绝，且拒绝理由要能直接执行；同时**任何拿不准的情况都必须放行**（宁可漏拦，
 * 不可拦死 —— 与 `lib/guard.js` 同一原则）。
 *
 * ## 3.3.0：async + 自愈
 *
 * 会话 def6609d 的死锁：工单没有任务板投影 → 门禁拒绝 `spawn_teammate` 并让模型
 * "更新工单状态（例如 progress）触发投影"；而 3.0.0 起指挥官改工单推进状态被层级门禁
 * 拒绝 → **两条门禁互相矛盾，Team 通道永久不可用**。
 *
 * 现在门禁是 **async**：缺投影时先 `await ensureTeamTask(...)` 由插件自己补建，成功直接
 * 放行；失败才拒绝，且理由只给**当前实现允许**的动作（只改描述字段 / Worker Session），
 * 绝不再让模型去调被别的门禁禁止的东西。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateDispatchGate,
  isNewWorkTool,
  sessionIdOf,
  taskFromDispatchArgs,
  ticketFromDispatchArgs,
} from '../lib/dispatch-gate.js';
import { PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID } from '../lib/tickets.js';

/** 一个指挥者 agent。 */
const LEAD = { session: { id: 's-1', header: {} } };

/** 一个 teammate（子级）。 */
const CHILD = { session: { id: 's-2', header: { parentSession: 's-1', origin: 'subagent' } } };

/** 账本替身。 */
function makeLedger({ mandate = null, tickets = [] } = {}) {
  const list = [...tickets];
  return {
    activeMandate: () => mandate,
    listTickets: () => list,
    getTicket: (id) => list.find((ticket) => ticket.id === id) ?? null,
  };
}

/** 一张有效工单（挂当前授权）。 */
function ticket(overrides = {}) {
  return { id: 't-1', sessionId: 's-1', status: 'open', mandateId: 'm-1', ...overrides };
}

const MANDATE = { id: 'm-1', sessionId: 's-1', status: 'active', planHash: 'h' };

/** 一次默认的派发判定（3.3.0 起返回 Promise）。 */
function gate(overrides = {}) {
  return evaluateDispatchGate({
    agent: LEAD,
    name: 'subagent_implementer',
    args: { task: '实现 X', ticket: 't-1' },
    requireMandate: true,
    requireTicket: true,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket()] }),
    ...overrides,
  });
}

// ---------------------------------------------------------------- 识别 ---

test('isNewWorkTool 只认开启新工作的工具', () => {
  for (const name of ['subagent_implementer', 'subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'commander_worker_spawn']) {
    assert.equal(isNewWorkTool(name), true, name);
  }
  for (const name of ['send_message', 'wait_agent', 'list_agents', 'team_task_create', 'commander_worker_send', 'read', '']) {
    assert.equal(isNewWorkTool(name), false, name);
  }
  assert.equal(isNewWorkTool(null), false);
});

test('ticketFromDispatchArgs：ticket 参数优先，其次文本标记', () => {
  assert.equal(ticketFromDispatchArgs({ ticket: 't-9' }), 't-9');
  assert.equal(ticketFromDispatchArgs({ task: '做点事 [ticket:t-3] 收尾' }), 't-3');
  assert.equal(ticketFromDispatchArgs({ prompt: '[ticket:t-4] 实现' }), 't-4');
  assert.equal(ticketFromDispatchArgs({ message: '续做 [ticket:t-5]' }), 't-5');
  assert.equal(ticketFromDispatchArgs({ task: '没有标记' }), undefined);
  assert.equal(ticketFromDispatchArgs(null), undefined);
});

test('sessionIdOf 读不到时返回 undefined', () => {
  assert.equal(sessionIdOf(LEAD), 's-1');
  assert.equal(sessionIdOf({ session: { id: '' } }), undefined);
  assert.equal(sessionIdOf(null), undefined);
});

// ---------------------------------------------------------------- 放行 ---

test('requireMandate=false：不再要求授权（0.5.0 行为）', async () => {
  assert.equal(await gate({ requireMandate: false, ledger: makeLedger() }), undefined);
});

test('没有账本服务：降级放行', async () => {
  assert.equal(await gate({ ledger: undefined }), undefined);
  assert.equal(await gate({ ledger: null }), undefined);
});

test('子代理自己派发：放行（不能被父级门禁拦死）', async () => {
  assert.equal(await gate({ agent: CHILD, ledger: makeLedger() }), undefined);
});

test('身份/会话读不到：放行', async () => {
  assert.equal(await gate({ agent: {}, ledger: makeLedger() }), undefined);
  assert.equal(await gate({ agent: { session: {} }, ledger: makeLedger() }), undefined);
});

test('不是"新工作"工具：放行', async () => {
  assert.equal(await gate({ name: 'send_message', args: { message: '[ticket:t-1] 续做' } }), undefined);
  assert.equal(await gate({ name: 'team_task_create', args: {} }), undefined);
});

test('账本读状态抛错：放行（不拦合法派发）', async () => {
  const broken = {
    activeMandate: () => {
      throw new Error('boom');
    },
    listTickets: () => [],
    getTicket: () => null,
  };
  assert.equal(await gate({ ledger: broken }), undefined);
});

test('requireTicket=false：有授权即可派发，不要求工单', async () => {
  assert.equal(await gate({ requireTicket: false, args: { task: '实现 X' }, ledger: makeLedger({ mandate: MANDATE }) }), undefined);
});

test('门禁是 async：返回 Promise，调用方必须 await（否则拿到的是"放行"的假象）', async () => {
  // 3.3.0 改成 async 是为了在门禁里 `await ensureTeamTask()`（补建投影）。这条钉住
  // 函数签名：回归成同步会让 `await` 变成无害的 no-op，但也意味着自愈路径被静默删掉。
  const result = gate();
  assert.equal(typeof result?.then, 'function', 'evaluateDispatchGate 必须返回 Promise');
  assert.equal(await result, undefined);
});

// ---------------------------------------------------------------- 拒绝 ---

test('没有计划授权 → 拒绝，理由给出固定问题 id 与确认选项', async () => {
  const decision = await gate({ ledger: makeLedger() });
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes(PLAN_QUESTION_ID), decision.reason);
  assert.ok(decision.reason.includes(PLAN_CONFIRM_LABEL), decision.reason);
  assert.match(decision.reason, /不要重试/u);
});

// --------------------------------------- 3.4.0 无 ask_user_question 的降级 ---
//
// 交叉审计发现的同类死锁：Mandate 只从 `ask_user_question` 的 post-execute 结果记录。
// 这个工具不存在时永远拿不到授权 → 原来会**永久拒绝所有派发**。所以工具视图可读且
// 确实没有 `ask_user_question` 时跳过授权门禁（协议仍要求先讲计划）。

/** 工具视图里没有 ask_user_question 的 agent 视图。 */
const NO_ASK_TOOLS = ['read', 'write', 'spawn_teammate', 'send_message', 'subagent_architect'];

test('3.4.0 降级：没有 ask_user_question + 无 mandate → 放行', async () => {
  assert.equal(
    await gate({ ledger: makeLedger({ mandate: null, tickets: [ticket()] }), availableTools: NO_ASK_TOOLS }),
    undefined,
  );
});

test('3.4.0 降级不是跳过所有校验：工单已结束 / 不存在 / 没带工单仍然拒绝', async () => {
  const availableTools = NO_ASK_TOOLS;
  // 工单已结束：后续校验仍生效。
  const ended = await gate({
    ledger: makeLedger({ mandate: null, tickets: [ticket({ status: 'done' })] }),
    availableTools,
  });
  assert.equal(ended.kind, 'deny');
  assert.match(ended.reason, /已结束/u);
  // 工单不存在。
  const missing = await gate({ ledger: makeLedger({ mandate: null, tickets: [] }), availableTools });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /找不到工单/u);
  // 没带工单（requireTicket 仍生效）。
  const noTicket = await gate({
    ledger: makeLedger({ mandate: null, tickets: [ticket()] }),
    args: { task: '实现 X' },
    availableTools,
  });
  assert.equal(noTicket.kind, 'deny');
  assert.match(noTicket.reason, /commander_ticket_create/u);
});

test('3.4.0 降级：没有 mandate 时不再校验"工单挂在旧授权下"', async () => {
  // 降级路径下 mandate 为 null —— 根本没有"授权 id 对齐"这回事，不能报"上一版计划"。
  const decision = await gate({
    ledger: makeLedger({ mandate: null, tickets: [ticket({ mandateId: 'm-0' })] }),
    availableTools: NO_ASK_TOOLS,
  });
  assert.equal(decision, undefined, '无 mandate 时不应因 mandateId 不一致而拒绝');
});

test('3.4.0 降级判据：有 ask_user_question / 视图读不到 / 非数组 → 仍按"有"处理并拒绝', async () => {
  const noMandate = () => makeLedger({ mandate: null, tickets: [ticket()] });
  // 有 ask_user_question：原行为不变（必须先确认计划）。
  const withAsk = await gate({ ledger: noMandate(), availableTools: ['read', 'ask_user_question', 'spawn_teammate'] });
  assert.equal(withAsk.kind, 'deny');
  assert.ok(withAsk.reason.includes(PLAN_QUESTION_ID), withAsk.reason);
  // 视图读不到（undefined）→ 按"有"处理。
  const unknown = await gate({ ledger: noMandate(), availableTools: undefined });
  assert.equal(unknown.kind, 'deny');
  assert.ok(unknown.reason.includes(PLAN_QUESTION_ID), unknown.reason);
  // 不传 availableTools 也一样（兼容旧调用方）。
  const absent = await gate({ ledger: noMandate() });
  assert.equal(absent.kind, 'deny');
  // 非数组（坏值）→ 按"有"处理。
  const bad = await gate({ ledger: noMandate(), availableTools: 'read' });
  assert.equal(bad.kind, 'deny');
});

test('有授权但没带工单 → 拒绝，并提示先建工单/列出已有工单', async () => {
  const open = [ticket({ id: 't-1' }), ticket({ id: 't-2' })];
  const decision = await gate({ args: { task: '实现 X' }, ledger: makeLedger({ mandate: MANDATE, tickets: open }) });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /commander_ticket_create/u);
  assert.ok(decision.reason.includes('t-1') && decision.reason.includes('t-2'), decision.reason);
});

test('工单不存在/不属于本会话 → 拒绝', async () => {
  const decision = await gate({ ledger: makeLedger({ mandate: MANDATE, tickets: [] }) });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /找不到工单/u);
});

test('工单已结束 → 拒绝（要求新建工单）', async () => {
  const decision = await gate({
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ status: 'done' })] }),
  });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /已结束/u);
  assert.match(decision.reason, /新建工单/u);
});

test('工单建立在旧授权下 → 拒绝（计划已更新）', async () => {
  const decision = await gate({
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ mandateId: 'm-0' })] }),
  });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /上一版计划/u);
});

test('合法派发 → 放行（specialist 参数或 Team 标记都算）', async () => {
  assert.equal(await gate(), undefined);
  assert.equal(
    await gate({ name: 'spawn_teammate', args: { prompt: '[ticket:t-1] 实现 X' }, ledger: makeLedger({ mandate: MANDATE, tickets: [ticket()] }) }),
    undefined,
  );
});

test('Worker spawn 走同一道门禁：没授权/没工单都拒绝，带工单放行', async () => {
  assert.equal((await gate({ name: 'commander_worker_spawn', args: { ticket: 't-1', task: 'x' }, ledger: makeLedger() })).kind, 'deny');
  assert.equal(await gate({ name: 'commander_worker_spawn', args: { ticket: 't-1', task: 'x' } }), undefined);
  assert.equal(
    (await gate({ name: 'commander_worker_spawn', args: { task: 'x' } })).kind,
    'deny',
    '没有 ticket 参数应拒绝（requireTicket）',
  );
});

// ------------------------------------------------------- 共享任务板（1.2.0 D） ---

/** 一个只读任务板适配器。 */
function board(tasks = []) {
  return { getTask: (id) => tasks.find((task) => task.id === id) };
}

/** 能派 teammate 的合法参数。 */
const SPAWN_ARGS = { name: 'reviewer', prompt: '[ticket:t-1] 实现 X' };

/** 无投影的工单 + 可派 teammate 的调用。 */
function noProjectionGate(overrides = {}) {
  return gate({
    name: 'spawn_teammate',
    args: SPAWN_ARGS,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
    teamBoard: board([]),
    requireTeamTask: true,
    ...overrides,
  });
}

test('taskFromDispatchArgs：从 prompt/task/message 里找 [task:task-N]', () => {
  assert.equal(taskFromDispatchArgs({ prompt: '[ticket:t-1] [task:task-9] 实现' }), 'task-9');
  assert.equal(taskFromDispatchArgs({ task: '做点事 [task:task-3]' }), 'task-3');
  assert.equal(taskFromDispatchArgs({ message: '续做 [task:task-4]' }), 'task-4');
  assert.equal(taskFromDispatchArgs({ prompt: '没有标记' }), undefined);
  assert.equal(taskFromDispatchArgs(null), undefined);
});

test('D：没有 Agent Teams（teamBoard 为 undefined）→ 整段跳过，行为与 1.1.x 一致', async () => {
  assert.equal(
    await gate({ name: 'spawn_teammate', args: SPAWN_ARGS, ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }) }),
    undefined,
  );
  // 即使提供了 ensureTeamTask，也不该在没有任务板的部署里被调用。
  let called = 0;
  await gate({
    name: 'spawn_teammate',
    args: SPAWN_ARGS,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
    ensureTeamTask: async () => { called += 1; return 'task-1'; },
  });
  assert.equal(called, 0, '没有 Agent Teams 时不应尝试补建投影');
});

test('D-1：没有投影 + 自愈成功 → 直接放行（不再让模型去触发投影）', async () => {
  // 会话 def6609d 的根因：旧实现拒绝并让模型"更新工单状态（例如 progress）触发投影"，
  // 而 3.0.0 起指挥官改工单推进状态被层级门禁拒绝 → 两条门禁互相矛盾。
  // 3.3.0 改成插件自己补建：ensureTeamTask 返回 taskId → 放行。
  const calls = [];
  const decision = await noProjectionGate({
    ensureTeamTask: async (agent, gateTicket) => {
      calls.push({ agent, ticket: gateTicket });
      return 'task-9';
    },
  });
  assert.equal(decision, undefined, '自愈成功后应直接放行');
  assert.equal(calls.length, 1, 'ensureTeamTask 应被调用一次');
  assert.equal(calls[0].agent, LEAD, 'ensureTeamTask 要拿到发起派发的 agent');
  assert.equal(calls[0].ticket.id, 't-1', 'ensureTeamTask 要拿到工单');
});

test('D-1：自愈补建的任务不需要再读板校验（刚建的一定存在且 pending）', async () => {
  // 补建后任务板上可能还看不到（服务缓存/时序），此时若再 getTask 校验会误拒。
  const decision = await noProjectionGate({
    teamBoard: { getTask: () => undefined },
    ensureTeamTask: async () => 'task-9',
  });
  assert.equal(decision, undefined, '补建成功后不应再读板校验');
});

test('D-1：自愈失败（返回 undefined / 抛错 / 未提供）→ 拒绝，且理由只给当前实现允许的动作', async () => {
  const failureModes = [
    ['返回 undefined', async () => undefined],
    ['抛错', async () => { throw new Error('TEAM_INVALID_WRITE_SCOPE'); }],
    ['返回非法 id', async () => 'not-a-task'],
    ['未提供 ensureTeamTask', undefined],
  ];
  for (const [label, ensureTeamTask] of failureModes) {
    const decision = await noProjectionGate(ensureTeamTask === undefined ? {} : { ensureTeamTask });
    assert.equal(decision?.kind, 'deny', `${label} 时应拒绝`);
    const reason = decision.reason;
    // 核心回归：**不再**让模型用 status（progress）去触发投影 —— 那会被层级门禁拒绝。
    assert.ok(!reason.includes('例如 progress'), `${label}：理由不得出现 progress 指令：${reason}`);
    assert.match(reason, /只改描述字段/u, `${label}：应给出"只改描述字段"这条路`);
    assert.match(reason, /commander_worker_spawn/u, `${label}：应给出 Worker Session 兜底`);
    assert.match(reason, /层级门禁/u, `${label}：应说明为什么不能用 status`);
    assert.match(reason, /没有共享任务板投影/u, `${label}：要点明缺投影`);
    assert.match(reason, /不要重复派同一任务/u, `${label}：要明确不要重试`);
  }
});

test('D-1：投影任务不存在 → 拒绝，理由给"只改描述字段"与 worker 兜底', async () => {
  const missing = await gate({
    name: 'spawn_teammate',
    args: SPAWN_ARGS,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] }),
    teamBoard: board([]),
    requireTeamTask: true,
  });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /不存在/u);
  assert.match(missing.reason, /只改描述字段/u);
  assert.match(missing.reason, /commander_worker_spawn/u);
});

test('D-1：投影任务已结束 → 拒绝（要求新建工单）', async () => {
  for (const status of ['completed', 'deleted']) {
    const ended = await gate({
      name: 'spawn_teammate',
      args: SPAWN_ARGS,
      ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] }),
      teamBoard: board([{ id: 'task-1', status }]),
      requireTeamTask: true,
    });
    assert.equal(ended.kind, 'deny', status);
    assert.match(ended.reason, /已结束/u);
  }
});

test('D-1：有有效投影 → 放行，且不会调用 ensureTeamTask（不重复建任务）', async () => {
  let called = 0;
  const ledger = makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] });
  assert.equal(
    await gate({
      name: 'spawn_teammate',
      args: SPAWN_ARGS,
      ledger,
      teamBoard: board([{ id: 'task-1', status: 'pending' }]),
      requireTeamTask: true,
      ensureTeamTask: async () => { called += 1; return 'task-9'; },
    }),
    undefined,
  );
  assert.equal(called, 0, '已有有效投影时不应再补建');
  // requireTeamTask=false 时无投影也放行（不尝试补建）。
  assert.equal(
    await gate({
      name: 'spawn_teammate',
      args: SPAWN_ARGS,
      ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
      teamBoard: board([]),
      requireTeamTask: false,
      ensureTeamTask: async () => { called += 1; return 'task-9'; },
    }),
    undefined,
  );
  assert.equal(called, 0, 'requireTeamTask=false 时不应补建');
});

test('D-1 只约束 Team 通道：一次性 specialist 不受影响', async () => {
  assert.equal(
    await gate({
      args: { task: '实现 X', ticket: 't-1' },
      ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
      teamBoard: board([]),
      requireTeamTask: true,
    }),
    undefined,
  );
});

test('D-2：requireTeamTaskMarker 要求 prompt 带 [task:task-N] 且与投影一致', async () => {
  const ledger = makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] });
  const teamBoard = board([{ id: 'task-1', status: 'pending' }]);

  const missing = await gate({ name: 'spawn_teammate', args: SPAWN_ARGS, ledger, teamBoard, requireTeamTask: true, requireTeamTaskMarker: true });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /\[task:task-N\]/u);

  const mismatched = await gate({
    name: 'spawn_teammate',
    args: { name: 'reviewer', prompt: '[ticket:t-1] [task:task-9] 实现' },
    ledger,
    teamBoard,
    requireTeamTask: true,
    requireTeamTaskMarker: true,
  });
  assert.equal(mismatched.kind, 'deny');
  assert.match(mismatched.reason, /不一致/u);

  assert.equal(
    await gate({
      name: 'spawn_teammate',
      args: { name: 'reviewer', prompt: '[ticket:t-1] [task:task-1] 实现' },
      ledger,
      teamBoard,
      requireTeamTask: true,
      requireTeamTaskMarker: true,
    }),
    undefined,
  );
});

test('D-2：自愈补建后，marker 要与新 taskId 一致', async () => {
  // 补建得到 task-9：prompt 里写 [task:task-9] 才放行，写旧 id 仍拒绝。
  const base = {
    name: 'spawn_teammate',
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
    teamBoard: board([]),
    requireTeamTask: true,
    requireTeamTaskMarker: true,
    ensureTeamTask: async () => 'task-9',
  };
  assert.equal(await gate({ ...base, args: { name: 'reviewer', prompt: '[ticket:t-1] [task:task-9] 实现' } }), undefined);
  const mismatched = await gate({ ...base, args: { name: 'reviewer', prompt: '[ticket:t-1] [task:task-1] 实现' } });
  assert.equal(mismatched.kind, 'deny');
  assert.match(mismatched.reason, /不一致/u);
});
