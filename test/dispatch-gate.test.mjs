/**
 * 派发门禁（`lib/dispatch-gate.js`）的测试。
 *
 * 这是 0.6.0 里"把提示词变成确定性规则"的关键一层：没有计划授权 / 没有工单的派发
 * 必须被拒绝，且拒绝理由要能直接执行；同时**任何拿不准的情况都必须放行**（宁可漏拦，
 * 不可拦死 —— 与 `lib/guard.js` 同一原则）。
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

/** 一次默认的派发判定。 */
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

test('requireMandate=false：不再要求授权（0.5.0 行为）', () => {
  assert.equal(gate({ requireMandate: false, ledger: makeLedger() }), undefined);
});

test('没有账本服务：降级放行', () => {
  assert.equal(gate({ ledger: undefined }), undefined);
  assert.equal(gate({ ledger: null }), undefined);
});

test('子代理自己派发：放行（不能被父级门禁拦死）', () => {
  assert.equal(gate({ agent: CHILD, ledger: makeLedger() }), undefined);
});

test('身份/会话读不到：放行', () => {
  assert.equal(gate({ agent: {}, ledger: makeLedger() }), undefined);
  assert.equal(gate({ agent: { session: {} }, ledger: makeLedger() }), undefined);
});

test('不是"新工作"工具：放行', () => {
  assert.equal(gate({ name: 'send_message', args: { message: '[ticket:t-1] 续做' } }), undefined);
  assert.equal(gate({ name: 'team_task_create', args: {} }), undefined);
});

test('账本读状态抛错：放行（不拦合法派发）', () => {
  const broken = {
    activeMandate: () => {
      throw new Error('boom');
    },
    listTickets: () => [],
    getTicket: () => null,
  };
  assert.equal(gate({ ledger: broken }), undefined);
});

test('requireTicket=false：有授权即可派发，不要求工单', () => {
  assert.equal(gate({ requireTicket: false, args: { task: '实现 X' }, ledger: makeLedger({ mandate: MANDATE }) }), undefined);
});

// ---------------------------------------------------------------- 拒绝 ---

test('没有计划授权 → 拒绝，理由给出固定问题 id 与确认选项', () => {
  const decision = gate({ ledger: makeLedger() });
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes(PLAN_QUESTION_ID), decision.reason);
  assert.ok(decision.reason.includes(PLAN_CONFIRM_LABEL), decision.reason);
  assert.match(decision.reason, /不要重试/u);
});

test('有授权但没带工单 → 拒绝，并提示先建工单/列出已有工单', () => {
  const open = [ticket({ id: 't-1' }), ticket({ id: 't-2' })];
  const decision = gate({ args: { task: '实现 X' }, ledger: makeLedger({ mandate: MANDATE, tickets: open }) });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /commander_ticket_create/u);
  assert.ok(decision.reason.includes('t-1') && decision.reason.includes('t-2'), decision.reason);
});

test('工单不存在/不属于本会话 → 拒绝', () => {
  const decision = gate({ ledger: makeLedger({ mandate: MANDATE, tickets: [] }) });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /找不到工单/u);
});

test('工单已结束 → 拒绝（要求新建工单）', () => {
  const decision = gate({
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ status: 'done' })] }),
  });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /已结束/u);
  assert.match(decision.reason, /新建工单/u);
});

test('工单建立在旧授权下 → 拒绝（计划已更新）', () => {
  const decision = gate({
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ mandateId: 'm-0' })] }),
  });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /上一版计划/u);
});

test('合法派发 → 放行（specialist 参数或 Team 标记都算）', () => {
  assert.equal(gate(), undefined);
  assert.equal(
    gate({ name: 'spawn_teammate', args: { prompt: '[ticket:t-1] 实现 X' }, ledger: makeLedger({ mandate: MANDATE, tickets: [ticket()] }) }),
    undefined,
  );
});

test('Worker spawn 走同一道门禁：没授权/没工单都拒绝，带工单放行', () => {
  assert.equal(gate({ name: 'commander_worker_spawn', args: { ticket: 't-1', task: 'x' }, ledger: makeLedger() }).kind, 'deny');
  assert.equal(gate({ name: 'commander_worker_spawn', args: { ticket: 't-1', task: 'x' } }), undefined);
  assert.equal(
    gate({ name: 'commander_worker_spawn', args: { task: 'x' } }).kind,
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

test('taskFromDispatchArgs：从 prompt/task/message 里找 [task:task-N]', () => {
  assert.equal(taskFromDispatchArgs({ prompt: '[ticket:t-1] [task:task-9] 实现' }), 'task-9');
  assert.equal(taskFromDispatchArgs({ task: '做点事 [task:task-3]' }), 'task-3');
  assert.equal(taskFromDispatchArgs({ message: '续做 [task:task-4]' }), 'task-4');
  assert.equal(taskFromDispatchArgs({ prompt: '没有标记' }), undefined);
  assert.equal(taskFromDispatchArgs(null), undefined);
});

test('D：没有 Agent Teams（teamBoard 为 undefined）→ 整段跳过，行为与 1.1.x 一致', () => {
  assert.equal(
    gate({ name: 'spawn_teammate', args: SPAWN_ARGS, ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }) }),
    undefined,
  );
});

test('D-1：有任务板但工单没有投影 → 拒绝，并给出触发投影的修复命令', () => {
  const decision = gate({
    name: 'spawn_teammate',
    args: SPAWN_ARGS,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
    teamBoard: board([]),
    requireTeamTask: true,
  });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /commander_ticket_update/u);
  assert.match(decision.reason, /没有共享任务板投影/u);
});

test('D-1：投影任务不存在 / 已结束 → 拒绝', () => {
  const missing = gate({
    name: 'spawn_teammate',
    args: SPAWN_ARGS,
    ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] }),
    teamBoard: board([]),
    requireTeamTask: true,
  });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /不存在/u);

  for (const status of ['completed', 'deleted']) {
    const ended = gate({
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

test('D-1：有有效投影 → 放行；requireTeamTask=false 时无投影也放行', () => {
  const ledger = makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] });
  assert.equal(
    gate({ name: 'spawn_teammate', args: SPAWN_ARGS, ledger, teamBoard: board([{ id: 'task-1', status: 'pending' }]), requireTeamTask: true }),
    undefined,
  );
  assert.equal(
    gate({
      name: 'spawn_teammate',
      args: SPAWN_ARGS,
      ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
      teamBoard: board([]),
      requireTeamTask: false,
    }),
    undefined,
  );
});

test('D-1 只约束 Team 通道：一次性 specialist 不受影响', () => {
  assert.equal(
    gate({
      args: { task: '实现 X', ticket: 't-1' },
      ledger: makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: null })] }),
      teamBoard: board([]),
      requireTeamTask: true,
    }),
    undefined,
  );
});

test('D-2：requireTeamTaskMarker 要求 prompt 带 [task:task-N] 且与投影一致', () => {
  const ledger = makeLedger({ mandate: MANDATE, tickets: [ticket({ teamTaskId: 'task-1' })] });
  const teamBoard = board([{ id: 'task-1', status: 'pending' }]);

  const missing = gate({ name: 'spawn_teammate', args: SPAWN_ARGS, ledger, teamBoard, requireTeamTask: true, requireTeamTaskMarker: true });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /\[task:task-N\]/u);

  const mismatched = gate({
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
    gate({
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
