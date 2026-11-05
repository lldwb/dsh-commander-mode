/**
 * 工单工具（`lib/ticket-tools.js`）的测试。
 *
 * 工具是模型与账本之间的唯一合法入口：参数契约、会话归属、报错文案（模型会原样看到）
 * 都要钉住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommanderLedger } from '../lib/ledger-service.js';
import { buildTicketTools } from '../lib/ticket-tools.js';
import { emptyLedger } from '../lib/ledger.js';

/** 一个指挥者 exec 上下文。 */
const EXEC = { agent: { session: { id: 's-1', header: {} } } };

/** 一个 teammate exec 上下文。 */
const CHILD_EXEC = { agent: { session: { id: 's-2', header: { parentSession: 's-1' } } } };

/** 内存账本。 */
function memoryLedger() {
  let state = emptyLedger();
  const ledger = new CommanderLedger({
    file: 'memory.json',
    load: () => ({ state }),
    save: (_file, next) => {
      state = JSON.parse(JSON.stringify(next));
    },
  });
  ledger.load();
  return ledger;
}

/** 建工具集。 */
function tools(getLedger, getTeamBridge) {
  const list = buildTicketTools({ getLedger, getTeamBridge });
  return {
    create: list.find((tool) => tool.name === 'commander_ticket_create'),
    update: list.find((tool) => tool.name === 'commander_ticket_update'),
    list: list.find((tool) => tool.name === 'commander_tickets'),
    all: list,
  };
}

test('三个工具的名字、schema 与输出契约', () => {
  const set = tools(() => memoryLedger());
  assert.deepEqual(set.all.map((tool) => tool.name), [
    'commander_ticket_create',
    'commander_ticket_update',
    'commander_tickets',
  ]);
  for (const tool of set.all) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
    const blocks = tool.output.render({}, { ok: true });
    assert.equal(blocks[0].type, 'text');
    assert.deepEqual(JSON.parse(blocks[0].text), { ok: true });
  }
  assert.deepEqual(set.create.parameters.required, ['title']);
  assert.deepEqual(set.update.parameters.required, ['ticket']);
  assert.equal(set.list.parameters.required, undefined);
});

test('没有账本服务：三个工具都抛可执行错误（不假装成功）', async () => {
  const set = tools(() => undefined);
  await assert.rejects(async () => set.create.execute({ title: 'x' }, EXEC), /工单账本服务不可用/u);
  await assert.rejects(async () => set.update.execute({ ticket: 't-1' }, EXEC), /工单账本服务不可用/u);
  await assert.rejects(async () => set.list.execute({}, EXEC), /工单账本服务不可用/u);
});

test('子代理不能使用工单工具', async () => {
  const set = tools(() => memoryLedger());
  await assert.rejects(async () => set.create.execute({ title: 'x' }, CHILD_EXEC), /只有指挥者本人/u);
  await assert.rejects(async () => set.list.execute({}, CHILD_EXEC), /只有指挥者本人/u);
});

test('create：无授权时 mandate_pending；有授权时继承 mandate', async () => {
  const ledger = memoryLedger();
  const set = tools(() => ledger);

  const pending = await set.create.execute({ title: '实现登录' }, EXEC);
  assert.equal(pending.ticket.id, 't-1');
  assert.equal(pending.mandate_pending, true);
  assert.match(pending.note, /ask_user_question/u);

  ledger.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: '计划' });
  const inherited = await set.create.execute({
    title: '实现登录页',
    intent: '让用户能登录',
    acceptance: ['能登录', '错误有提示'],
    scope: ['src/login/**'],
  }, EXEC);
  assert.equal(inherited.ticket.id, 't-2');
  assert.equal(inherited.mandate_pending, false);
  assert.equal(inherited.ticket.mandate_id, 'm-1');
});

test('create：空标题/超长标题给可执行错误', async () => {
  const set = tools(() => memoryLedger());
  await assert.rejects(async () => set.create.execute({ title: '   ' }, EXEC), /标题不能为空/u);
  await assert.rejects(async () => set.create.execute({ title: 'x'.repeat(201) }, EXEC), /标题过长/u);
});

test('update：六态记录、终态结算、未知状态拒绝', async () => {
  const ledger = memoryLedger();
  const set = tools(() => ledger);
  const created = await set.create.execute({ title: '实现' }, EXEC);

  const blocked = await set.update.execute({ ticket: created.ticket.id, status: 'blocked', summary: '缺权限', question: '要不要改配置？' }, EXEC);
  assert.equal(blocked.ticket.status, 'blocked');
  assert.equal(blocked.ticket.last_report.question, '要不要改配置？');
  assert.ok(blocked.attention.some((item) => item.code === 'answer'));

  const done = await set.update.execute({ ticket: created.ticket.id, status: 'done', reason: '验收通过' }, EXEC);
  assert.equal(done.ticket.status, 'done');
  await assert.rejects(async () => set.update.execute({ ticket: created.ticket.id, status: 'exploded' }, EXEC), /未知状态/u);
});

test('update：改标题/验收；不属于本会话的工单被拒绝', async () => {
  const ledger = memoryLedger();
  const set = tools(() => ledger);
  const created = await set.create.execute({ title: '旧' }, EXEC);
  const updated = await set.update.execute({ ticket: created.ticket.id, title: '新', acceptance: ['判据'] }, EXEC);
  assert.equal(updated.ticket.title, '新');

  const other = { agent: { session: { id: 's-9', header: {} } } };
  await assert.rejects(async () => set.update.execute({ ticket: created.ticket.id, status: 'progress' }, other), /不属于当前会话/u);
});

test('list：默认只列未结束；include_ended 看历史；含授权与 attention', async () => {
  const ledger = memoryLedger();
  const set = tools(() => ledger);
  ledger.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: '计划摘要' });
  const first = await set.create.execute({ title: 'A' }, EXEC);
  await set.create.execute({ title: 'B' }, EXEC);
  await set.update.execute({ ticket: first.ticket.id, status: 'done' }, EXEC);

  const open = await set.list.execute({}, EXEC);
  assert.equal(open.mandate.id, 'm-1');
  assert.deepEqual(open.tickets.map((ticket) => ticket.id), ['t-2']);
  assert.equal(open.state_file, 'memory.json');

  const all = await set.list.execute({ include_ended: true }, EXEC);
  assert.deepEqual(all.tickets.map((ticket) => ticket.id).sort(), ['t-1', 't-2']);
  assert.equal(all.tickets.find((ticket) => ticket.id === 't-1').status, 'done');
});

// ------------------------------------------------- 共享任务板投影（1.2.0 B） ---

/** 投影器替身（默认全部成功）。 */
function fakeBridge({ taskId = 'task-1', createResult = undefined, syncResult = undefined, throwCreate = false, throwSync = false } = {}) {
  const calls = [];
  return {
    calls,
    async createProjection(_agent, ticket) {
      calls.push({ action: 'create', ticketId: ticket.id });
      if (throwCreate) throw new Error('boom');
      return createResult === undefined ? { taskId, task: { id: taskId } } : createResult;
    },
    async syncProjection(_agent, ticket) {
      calls.push({ action: 'sync', ticketId: ticket.id, mapped: ticket.teamTaskId });
      if (throwSync) throw new Error('boom');
      return syncResult === undefined ? { taskId, task: { id: taskId } } : syncResult;
    },
  };
}

test('create：有投影器时建任务并写回 team_task_id', async () => {
  const ledger = memoryLedger();
  const bridge = fakeBridge({ taskId: 'task-7' });
  const set = tools(() => ledger, () => bridge);

  const created = await set.create.execute({ title: '实现登录' }, EXEC);
  assert.equal(created.ticket.team_task_id, 'task-7');
  assert.deepEqual(bridge.calls, [{ action: 'create', ticketId: 't-1' }]);
  // 账本里也持久化了映射
  assert.equal(ledger.getTicket('t-1', 's-1').teamTaskId, 'task-7');
});

test('create：投影失败/抛错不影响建单（team_task_id 为 null）', async () => {
  for (const bridge of [fakeBridge({ createResult: null }), fakeBridge({ throwCreate: true })]) {
    const ledger = memoryLedger();
    const set = tools(() => ledger, () => bridge);
    const created = await set.create.execute({ title: '实现' }, EXEC);
    assert.equal(created.ticket.team_task_id, null);
    assert.equal(ledger.getTicket(created.ticket.id, 's-1').status, 'open');
  }
});

test('update：有投影器时同步，并在缺映射时补写 team_task_id', async () => {
  const ledger = memoryLedger();
  const bridge = fakeBridge({ taskId: 'task-5' });
  const set = tools(() => ledger, () => bridge);
  const created = await set.create.execute({ title: '实现' }, EXEC);
  // 先把映射清掉，模拟"建单时投影失败、后来才补上"
  ledger.attachTeamTask(created.ticket.id, 's-1', 'task-1');
  ledger.replace({ ...ledger.getTicket(created.ticket.id, 's-1'), teamTaskId: null });

  const updated = await set.update.execute({ ticket: created.ticket.id, status: 'progress' }, EXEC);
  assert.equal(updated.ticket.status, 'working');
  assert.equal(updated.ticket.team_task_id, 'task-5');
  assert.ok(bridge.calls.some((call) => call.action === 'sync' && call.ticketId === created.ticket.id));
});

test('update：投影抛错不影响工单更新', async () => {
  const ledger = memoryLedger();
  const set = tools(() => ledger, () => fakeBridge({ throwSync: true }));
  const created = await set.create.execute({ title: '实现' }, EXEC);
  const done = await set.update.execute({ ticket: created.ticket.id, status: 'done' }, EXEC);
  assert.equal(done.ticket.status, 'done');
});

test('没有投影器：行为与 1.1.x 一致（team_task_id 恒为 null）', async () => {
  const set = tools(() => memoryLedger());
  const created = await set.create.execute({ title: '实现' }, EXEC);
  assert.equal(created.ticket.team_task_id, null);
});
