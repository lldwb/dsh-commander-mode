/**
 * 工具返回值的 **JSON-lossless** 契约（0.9.1）。
 *
 * 为什么要有这个文件：dsh 的 `dsh-tools` 在执行完工具后会调 `snapshotJsonValue()` 快照
 * 返回值；出现 `undefined` / `NaN` / `±Infinity` / `-0` / 函数 / symbol / 非普通对象 / 环，
 * 快照返回 `undefined`，整个工具调用就变成
 * `tool "<name>" returned invalid output: value is not lossless JSON`。
 *
 * 这不是理论问题：0.9.0 的 web 沙箱真机 E2E 里，`ticketView()` 给空问题返回了
 * `question: undefined`，于是工单一回报，`commander_ticket_update` /
 * `commander_tickets` 全部开始报 invalid output —— 工单流程在真实回合里直接断掉。
 * 离线单测当时只断言"字段值对不对"，没人检查"值能不能过 JSON"。
 *
 * 这个文件就是那条缺失的护栏：**每个工具的原始返回值**都递归扫一遍。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CommanderLedger } from '../lib/ledger-service.js';
import { emptyLedger } from '../lib/ledger.js';
import { buildTicketTools } from '../lib/ticket-tools.js';
import { ticketView } from '../lib/tickets.js';

/** 指挥者 exec 上下文。 */
const EXEC = { agent: { session: { id: 's-1', header: {} } } };

/**
 * 按 dsh-tools 的判定口径递归检查一个值能不能被 lossless JSON 快照。
 *
 * @param {unknown} value - 待检查值。
 * @param {string} [path] - 出错时用于定位的路径。
 */
function assertLossless(value, path = 'value') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} 不能是 ${String(value)}（JSON 里会变 null）`);
    assert.ok(!Object.is(value, -0), `${path} 不能是 -0`);
    return;
  }
  assert.notEqual(type, 'undefined', `${path} 不能是 undefined（dsh-tools 会判 invalid output）`);
  assert.notEqual(type, 'function', `${path} 不能是函数`);
  assert.notEqual(type, 'symbol', `${path} 不能是 symbol`);
  assert.notEqual(type, 'bigint', `${path} 不能是 bigint`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertLossless(value[index], `${path}[${index}]`);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  assert.ok(proto === Object.prototype || proto === null, `${path} 必须是普通对象，不能是 ${Object.prototype.toString.call(value)}`);
  assert.equal(typeof value.toJSON, 'undefined', `${path} 不能带 toJSON`);
  for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`);
}

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

/** 按名字取工具。 */
function byName(list) {
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

test('工单三个工具：所有返回值都必须是 lossless JSON（含空 question 的回报）', async () => {
  const ledger = memoryLedger();
  const { commander_ticket_create: create, commander_ticket_update: update, commander_tickets: list } = byName(
    buildTicketTools({ getLedger: () => ledger }),
  );

  const created = await create.execute({ title: '隔离验证' }, EXEC);
  assertLossless(created, 'create');
  const ticketId = created.ticket.id;

  // ⚠️ 这就是 0.9.0 真机 E2E 的失败点：progress 汇报没有 question → 曾经返回 undefined。
  const progress = await update.execute({ ticket: ticketId, status: 'progress', summary: '在做' }, EXEC);
  assertLossless(progress, 'update(progress)');

  const blocked = await update.execute({
    ticket: ticketId,
    status: 'blocked',
    summary: '缺权限',
    question: '要不要改配置？',
  }, EXEC);
  assertLossless(blocked, 'update(blocked)');

  const ready = await update.execute({ ticket: ticketId, status: 'ready', summary: '做完' }, EXEC);
  assertLossless(ready, 'update(ready)');

  const open = await list.execute({}, EXEC);
  assertLossless(open, 'tickets');

  const all = await list.execute({ include_ended: true }, EXEC);
  assertLossless(all, 'tickets(include_ended)');

  await update.execute({ ticket: ticketId, status: 'done', summary: '验收通过' }, EXEC);
  assertLossless(await list.execute({ include_ended: true }, EXEC), 'tickets(ended)');
});

test('ticketView：空 question 用 null，有 question 时保留文本', () => {
  const ledger = memoryLedger();
  const ticket = ledger.createTicket({ sessionId: 's-1', title: 'x' });
  ledger.recordReport(ticket.id, 's-1', { status: 'progress', summary: '在做', question: '' });
  const empty = ticketView(ledger.getTicket(ticket.id, 's-1'));
  assert.equal(empty.last_report.question, null);

  ledger.recordReport(ticket.id, 's-1', { status: 'blocked', summary: '卡住', question: '改配置吗？' });
  const asked = ticketView(ledger.getTicket(ticket.id, 's-1'));
  assert.equal(asked.last_report.question, '改配置吗？');
});
