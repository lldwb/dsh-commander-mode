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
function tools(getLedger) {
  const list = buildTicketTools({ getLedger });
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
