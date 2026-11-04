/**
 * 账本（`lib/ledger.js` + `lib/ledger-service.js`）的测试。
 *
 * 这一层要证明的是"**状态不丢、坏了能起、作用域不串**"：
 * - 原子写与载入回读；
 * - 损坏文件备份后从空账本启动，而不是让模式起不来；
 * - 工单/授权按会话隔离；
 * - 写盘失败降级为内存（不把工具调用弄挂）。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LEDGER_SCHEMA_VERSION,
  emptyLedger,
  loadLedgerFile,
  resolveLedgerFile,
  sanitizeLedger,
  saveLedgerFile,
} from '../lib/ledger.js';
import { CommanderLedger } from '../lib/ledger-service.js';

/** 建一个临时目录并在测试结束后清理。 */
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'commander-ledger-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** 一个只读内存实现，避免每个用例都碰磁盘。 */
function memoryLedger({ now = () => 1_700_000_000_000 } = {}) {
  let saved = emptyLedger();
  const ledger = new CommanderLedger({
    file: 'memory.json',
    now,
    load: () => ({ state: saved }),
    save: (_file, state) => {
      saved = JSON.parse(JSON.stringify(state));
    },
  });
  ledger.load();
  return { ledger, state: () => saved };
}

// ---------------------------------------------------------------- 路径 ---

test('resolveLedgerFile：默认 <DSH_HOME>/commander/<profile>.json', () => {
  const file = resolveLedgerFile({ env: { DSH_HOME: 'C:\\dsh-home', DSH_PROFILE: 'desktop' }, home: 'C:\\home' });
  assert.match(file, /dsh-home[\\/]commander[\\/]desktop\.json$/u);
});

test('resolveLedgerFile：缺 DSH_HOME 用 home/.dsh；缺 profile 用 default', () => {
  const file = resolveLedgerFile({ env: {}, home: '/home/me' });
  assert.equal(file, join('/home/me', '.dsh', 'commander', 'default.json'));
});

test('resolveLedgerFile：stateDir 相对路径以 DSH_HOME 为基准；.json 视为文件，否则视为目录', () => {
  const env = { DSH_HOME: '/dsh', DSH_PROFILE: 'p' };
  assert.equal(resolveLedgerFile({ stateDir: 'my-ledger.json', env }), join('/dsh', 'my-ledger.json'));
  assert.equal(resolveLedgerFile({ stateDir: 'state', env }), join('/dsh', 'state', 'ledger.json'));
  assert.equal(resolveLedgerFile({ stateDir: '/abs/dir', env }), join('/abs/dir', 'ledger.json'));
  assert.equal(resolveLedgerFile({ stateDir: '/abs/file.json', env }), '/abs/file.json');
});

test('resolveLedgerFile：profile 名做文件名安全化', () => {
  const file = resolveLedgerFile({ env: { DSH_HOME: '/dsh', DSH_PROFILE: '../evil name' } });
  assert.equal(file, join('/dsh', 'commander', '.._evil_name.json'));
});

// ---------------------------------------------------------------- 文件 ---

test('载入不存在的账本 → 空账本且不产生 warning', (t) => {
  const dir = tempDir(t);
  const { state, warning } = loadLedgerFile({ file: join(dir, 'missing.json') });
  assert.deepEqual(state, emptyLedger());
  assert.equal(warning, undefined);
});

test('保存后回读：原子写、可覆盖、自动建目录', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'nested', 'ledger.json');
  const state = emptyLedger();
  state.tickets.push({
    id: 't-1',
    sessionId: 's-1',
    title: '合法工单',
    status: 'open',
    assignments: [],
    createdAt: 1,
    updatedAt: 1,
  });
  saveLedgerFile({ file, state });
  assert.equal(existsSync(file), true);
  const loaded = loadLedgerFile({ file });
  assert.equal(loaded.state.tickets.length, 1);
  saveLedgerFile({ file, state: { ...state, nextTicket: 2 } });
  assert.equal(loadLedgerFile({ file }).state.nextTicket, 2);
});

test('损坏 JSON：备份为 .corrupt-*，用空账本启动并给 warning', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  writeFileSync(file, '{ not json', 'utf8');
  const { state, warning } = loadLedgerFile({ file, now: 1_700_000_000_000 });
  assert.deepEqual(state, emptyLedger());
  assert.match(warning, /损坏/u);
  assert.equal(existsSync(file), false, '损坏文件应被移走');
  const backups = readdirSync(dir).filter((name) => name.startsWith('ledger.json.corrupt-'));
  assert.equal(backups.length, 1);
});

test('不支持的 schemaVersion：空账本 + warning', () => {
  const { state, warning } = sanitizeLedger({ schemaVersion: 999, tickets: [{ id: 't-1' }] });
  assert.equal(state.tickets.length, 0);
  assert.match(warning, /schemaVersion/u);
});

test('sanitizeLedger 丢弃非法记录但保留合法记录，并推高计数器', () => {
  const { state, warning } = sanitizeLedger({
    schemaVersion: LEDGER_SCHEMA_VERSION,
    nextTicket: 1,
    nextMandate: 1,
    nextAssignment: 1,
    mandates: [
      { id: 'm-3', sessionId: 's-1', planHash: 'abc', status: 'active', confirmedAt: 1 },
      { id: 'bad' },
    ],
    tickets: [
      {
        id: 't-7',
        sessionId: 's-1',
        title: '合法',
        status: 'working',
        assignments: [{ id: 'a-9', channel: 'specialist', toolName: 'x', startedAt: 1 }],
      },
      { id: 'bad' },
      { id: 't-2', sessionId: 's-1', title: '旧状态', status: 'unknown-status' },
    ],
  });
  assert.equal(state.tickets.length, 2);
  assert.equal(state.tickets[1].status, 'open', '未知状态回退 open');
  assert.equal(state.nextTicket, 8);
  assert.equal(state.nextMandate, 4);
  assert.equal(state.nextAssignment, 10);
  assert.match(warning, /丢弃/u);
});

// ---------------------------------------------------------------- 服务 ---

test('服务：载入 + 建工单继承 active 授权；工单按会话隔离', () => {
  const { ledger } = memoryLedger();
  const mandate = ledger.recordMandate({ sessionId: 's-1', planHash: 'h1', planSummary: '实现 X' });
  const ticket = ledger.createTicket({ sessionId: 's-1', title: '实现 X' });
  assert.equal(ticket.mandate_id, mandate.id);
  assert.equal(ledger.listTickets('s-1').length, 1);
  assert.equal(ledger.listTickets('s-2').length, 0);
  assert.throws(() => ledger.getTicket(ticket.id, 's-2'), /不属于当前会话/u);
});

test('服务：没有授权时建工单可成功，但 mandateId 为空', () => {
  const { ledger } = memoryLedger();
  const ticket = ledger.createTicket({ sessionId: 's-1', title: '未授权工单' });
  assert.equal(ticket.mandate_id, null);
});

test('服务：新授权取代旧授权；撤销后 activeMandate 为 null', () => {
  const { ledger } = memoryLedger();
  const first = ledger.recordMandate({ sessionId: 's-1', planHash: 'h1', planSummary: 'v1' });
  const second = ledger.recordMandate({ sessionId: 's-1', planHash: 'h2', planSummary: 'v2' });
  const active = ledger.activeMandate('s-1');
  assert.equal(active.id, second.id);
  assert.equal(active.planHash, 'h2');
  // 旧授权被标 superseded，但仍可审计。
  const all = ledger.summary('s-1');
  assert.equal(all.mandate.id, second.id);
  const revoked = ledger.revokeMandate('s-1', '用户叫停');
  assert.equal(revoked.status, 'revoked');
  assert.equal(ledger.activeMandate('s-1'), null);
  assert.ok(first.id !== second.id);
});

test('服务：派发 → 回报 → 验收；终态后拒绝再派发', () => {
  const { ledger } = memoryLedger();
  ledger.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: 'p' });
  const ticket = ledger.createTicket({ sessionId: 's-1', title: '实现 Y' });
  const assigned = ledger.recordAssignment(ticket.id, 's-1', { channel: 'specialist', toolName: 'subagent_implementer' });
  assert.equal(assigned.status, 'working');
  assert.equal(assigned.assignments.length, 1);

  const reported = ledger.recordReport(ticket.id, 's-1', { status: 'ready', summary: '完成' });
  assert.equal(reported.status, 'review');
  assert.equal(reported.last_report.status, 'ready');

  const done = ledger.setStatus(ticket.id, 's-1', 'done', { reason: '验收通过' });
  assert.equal(done.status, 'done');
  assert.throws(
    () => ledger.recordAssignment(ticket.id, 's-1', { channel: 'specialist', toolName: 'x' }),
    /已结束/u,
  );
});

test('服务：updateTicket 改标题/验收/范围；终态不可改', () => {
  const { ledger } = memoryLedger();
  const ticket = ledger.createTicket({ sessionId: 's-1', title: '旧标题', acceptance: ['旧判据'] });
  const updated = ledger.updateTicket(ticket.id, 's-1', { title: '新标题', acceptance: ['新判据'], scope: ['src/**'] });
  assert.equal(updated.title, '新标题');
  const done = ledger.setStatus(ticket.id, 's-1', 'done');
  assert.equal(done.status, 'done');
  assert.throws(() => ledger.updateTicket(ticket.id, 's-1', { title: '再改' }), /已结束/u);
});

test('服务：attention 汇总待人工/停滞', () => {
  const now = () => 1_700_000_000_000;
  const { ledger } = memoryLedger({ now });
  ledger.createTicket({ sessionId: 's-1', title: 'A' });
  const blocked = ledger.createTicket({ sessionId: 's-1', title: 'B' });
  ledger.recordReport(blocked.id, 's-1', { status: 'blocked', summary: '缺权限', question: '要不要动配置？' });
  const stalled = ledger.createTicket({ sessionId: 's-1', title: 'C' });
  ledger.recordAssignment(stalled.id, 's-1', { channel: 'specialist', toolName: 'x' });
  // 时间推进 20 分钟（now 是闭包，用固定值的旧账本无法推进；这里直接构造新实例）。
  const later = new CommanderLedger({
    file: 'memory.json',
    now: () => 1_700_000_000_000 + 20 * 60_000,
    load: () => ({ state: ledger.state }),
    save: () => {},
  });
  later.load();
  const attention = later.attention('s-1', 10 * 60_000);
  assert.ok(attention.some((item) => item.code === 'answer'));
  assert.ok(attention.some((item) => item.code === 'stalled'));
});

test('服务：裁剪只删最老的已结束工单，保留未结束', () => {
  const { ledger } = memoryLedger();
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(ledger.createTicket({ sessionId: 's-1', title: `任务 ${index}` }));
  }
  // 让前 4 个结束（早于第 5 个仍在进行）。
  for (let index = 0; index < 4; index += 1) ledger.setStatus(created[index].id, 's-1', 'done');
  const small = new CommanderLedger({
    file: 'memory.json',
    maxTickets: 2,
    load: () => ({ state: ledger.state }),
    save: () => {},
  });
  small.load();
  small.createTicket({ sessionId: 's-1', title: '触发裁剪' });
  const ids = small.listTickets('s-1', { includeEnded: true }).map((ticket) => ticket.id);
  assert.ok(ids.includes('t-5'), '未结束的 t-5 必须保留');
  assert.ok(ids.length <= 2 + 1, `裁剪后应接近上限：${ids.join(',')}`);
  const open = small.listTickets('s-1').map((ticket) => ticket.id);
  assert.ok(open.includes('t-5'));
});

test('服务：写盘失败降级为内存，不抛给调用方', () => {
  const warnings = [];
  const ledger = new CommanderLedger({
    file: 'broken.json',
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    load: () => ({ state: emptyLedger() }),
    save: () => {
      throw new Error('磁盘满');
    },
  });
  ledger.load();
  const ticket = ledger.createTicket({ sessionId: 's-1', title: '仍然可建' });
  assert.equal(ticket.title, '仍然可建');
  assert.match(ledger.lastPersistError, /磁盘满/u);
  assert.ok(warnings.some((line) => line.includes('保存失败')));
});

test('服务：载入失败用空账本启动（不抛）', () => {
  const ledger = new CommanderLedger({
    file: 'x.json',
    load: () => {
      throw new Error('boom');
    },
    save: () => {},
  });
  const result = ledger.load();
  assert.equal(result.loaded, false);
  assert.match(result.warnings[0], /boom/u);
  assert.equal(ledger.listTickets('s-1').length, 0);
});

test('服务：缓存命中后的真实文件回读（端到端）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const first = new CommanderLedger({ file, now: () => 1 });
  assert.equal(first.load().loaded, true);
  first.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: 'p' });
  const ticket = first.createTicket({ sessionId: 's-1', title: '持久化验证' });
  first.recordAssignment(ticket.id, 's-1', { channel: 'specialist', toolName: 'subagent_tester' });

  const second = new CommanderLedger({ file, now: () => 2 });
  second.load();
  const loaded = second.getTicket(ticket.id, 's-1');
  assert.equal(loaded.title, '持久化验证');
  assert.equal(loaded.assignments.length, 1);
  assert.equal(second.activeMandate('s-1').planHash, 'h');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.schemaVersion, LEDGER_SCHEMA_VERSION);
});
