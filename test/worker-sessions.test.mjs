/**
 * Worker Session（`lib/worker-sessions.js` / `lib/worker-tools.js`）的测试。
 *
 * 用假 ctx/服务驱动真实服务类：验证"每工单一个 Session + 目录 + 槽位 + 装饰 + report"，
 * 不依赖真实 Loader（真实路径见 README「验证过什么」的沙箱记录）。
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { CommanderLedger } from '../lib/ledger-service.js';
import { emptyLedger } from '../lib/ledger.js';
import { CommanderWorkers, resolveWorkRoot } from '../lib/worker-sessions.js';
import { buildWorkerTools } from '../lib/worker-tools.js';

/** 会议话 id。 */
const PARENT = 's-1';
const TICKET = 't-1';

/** 内存账本 + 一张已授权工单（`now` 可注入，便于测停滞看门狗的时间逻辑）。 */
function ledgerWithTicket({ now } = {}) {
  let state = emptyLedger();
  const ledger = new CommanderLedger({
    file: 'memory.json',
    ...(now === undefined ? {} : { now }),
    load: () => ({ state }),
    save: (_file, next) => {
      state = JSON.parse(JSON.stringify(next));
    },
  });
  ledger.load();
  ledger.recordMandate({ sessionId: PARENT, planHash: 'h', planSummary: '实现 X' });
  const ticket = ledger.createTicket({ sessionId: PARENT, title: '实现 X', acceptance: ['能运行'] });
  return { ledger, ticket };
}

/** 一个假 agent。 */
function makeAgent(id, { status = 'idle' } = {}) {
  const record = { sections: [], tools: [], restricts: [], guards: [], followups: [], steers: [], cancels: [] };
  const agent = {
    id,
    status,
    session: { id, header: { id } },
    record,
    followup: (message) => record.followups.push(message),
    steer: (message) => record.steers.push(message),
    cancel: (reason) => record.cancels.push(reason),
    ctx: {
      systemPrompt: { section: (definition) => { record.sections.push(definition); return () => {}; } },
      tools: {
        get: (name) => (name === 'read' || name === 'write' || name === 'commander_report' ? { name } : undefined),
        register: (definition) => { record.tools.push(definition); return () => {}; },
        restrict: (filter) => { record.restricts.push(filter); return () => {}; },
        guard: (guard) => { record.guards.push(guard); return () => {}; },
      },
    },
  };
  return agent;
}

/** 假服务与事件总线。 */
function makeDeps({ parent = makeAgent(PARENT), workerFactory = () => makeAgent(`worker-${TICKET}`) } = {}) {
  const record = {
    createdSessions: [],
    workspaces: [],
    permissions: [],
    renames: [],
    mkdirs: [],
    commands: [],
    listeners: new Map(),
    workers: new Map(),
  };
  const sessionController = {
    create: async (options) => {
      record.createdSessions.push(options);
      record.workers.set(options.sessionId, workerFactory());
      return { ok: true };
    },
    resolveAgent: async (sessionId) => {
      const agent = record.workers.get(sessionId);
      return agent === undefined ? { error: { code: 'session/not-found' } } : { agent };
    },
    rename: async (options) => {
      record.renames.push(options);
      return { ok: true };
    },
  };
  const workspaceRegistry = { create: async (directory) => { record.workspaces.push(directory); return { id: 'ws-1' }; } };
  const permissionPresets = { set: (session, preset) => record.permissions.push({ session, preset }) };
  const agents = { get: (id) => (id === PARENT ? parent : record.workers.get(id)) };
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    get: (name) => ({ sessionController, workspaceRegistry, agents, permissionPresets })[name],
    on: (event, listener) => {
      const list = record.listeners.get(event) ?? [];
      list.push(listener);
      record.listeners.set(event, list);
      return () => {};
    },
  };
  const emit = (event, payload) => {
    for (const listener of record.listeners.get(event) ?? []) listener(payload);
  };
  return { record, parent, ctx, emit, deps: { sessionController, workspaceRegistry, agents, permissionPresets, mkdir: async (dir) => { record.mkdirs.push(dir); }, execCommand: async (command, options) => { record.commands.push({ command, options }); } } };
}

/** 简化：直接用 deps 建服务（`now` / 额外 deps 可注入，便于测停滞看门狗）。 */
function workersOf({ ledger, options = {}, parentAgent, now, deps: extraDeps = {} } = {}) {
  const built = makeDeps({ parent: parentAgent ?? makeAgent(PARENT) });
  const service = new CommanderWorkers({
    ctx: built.ctx,
    ledger,
    getOptions: () => ({ workerSessions: true, workRoot: '/tmp/commander-work', maxWorkers: 3, prepareCommand: '', workerPermission: 'danger-full-access', ...options }),
    ...(now === undefined ? {} : { now }),
    deps: { ...built.deps, ...extraDeps },
  });
  const dispose = service.install();
  return { service, dispose, ...built };
}

/** 假定时器（避免测试里留下真实的 60s interval）。 */
function fakeTimers() {
  const handles = [];
  return {
    handles,
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref: () => { handle.unrefed = true; } };
      handles.push(handle);
      return handle;
    },
    clearInterval: (handle) => { handle.cleared = true; },
  };
}

/** 让 `void notifyParent(...)` 这类 fire-and-forget 的异步链路跑完。 */
async function flushAsync() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('resolveWorkRoot：默认 <DSH_HOME>/commander/work；相对路径按 DSH_HOME 解析', () => {
  assert.equal(resolveWorkRoot({ env: { DSH_HOME: '/dsh' } }), join('/dsh', 'commander', 'work'));
  assert.equal(resolveWorkRoot({ workRoot: 'my-work', env: { DSH_HOME: '/dsh' } }), join('/dsh', 'my-work'));
  assert.equal(resolveWorkRoot({ workRoot: '/abs/work', env: {} }), '/abs/work');
});

test('disabled：workerSessions 未开时 spawn 拒绝', async () => {
  const { ledger } = ledgerWithTicket();
  const { service, parent } = workersOf({ ledger, options: { workerSessions: false } });
  await assert.rejects(async () => service.spawn({ parentAgent: parent, ticketId: TICKET, task: '做' }), /未启用/u);
});

test('spawn：建目录、workspace、独立 Session、权限、重命名、账本执行信息与派工消息', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record } = workersOf({ ledger });
  const result = await service.spawn({ parentAgent: parent, ticketId: ticket.id, task: '实现登录页' });
  assert.equal(result.sessionId, `worker-${ticket.id}`);
  assert.match(result.directory, /commander-work[\\/]t-1$/u);
  assert.equal(record.mkdirs.length, 1);
  assert.equal(record.workspaces.length, 1);
  assert.deepEqual(record.createdSessions[0], { sessionId: `worker-${ticket.id}`, workspaceId: 'ws-1' });
  assert.deepEqual(record.permissions[0], { session: record.workers.get(`worker-${ticket.id}`).session, preset: 'danger-full-access' });
  assert.equal(record.renames[0].sessionId, `worker-${ticket.id}`);
  const stored = ledger.getTicket(ticket.id, PARENT);
  assert.equal(stored.execution.sessionId, `worker-${ticket.id}`);
  assert.equal(stored.execution.directory, result.directory);
  const worker = record.workers.get(`worker-${ticket.id}`);
  // 新会话用 steer 投递（会唤醒驱动器）；followup 是回退，两者都算派工。
  const delivered = worker.record.steers.length > 0 ? worker.record.steers : worker.record.followups;
  assert.equal(delivered.length, 1);
  const text = delivered[0].content[0].text;
  assert.match(text, /【指挥者·派工】/u);
  assert.ok(text.includes('实现登录页'));
  assert.ok(text.includes('能运行'), '派工消息要带验收判据');
});

test('spawn：创建后立即装饰 worker（不依赖 agent/created 事件；0.9.1 真机 bug）', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record } = workersOf({ ledger });
  await service.spawn({ parentAgent: parent, ticketId: ticket.id, task: '做' });
  const worker = record.workers.get(`worker-${ticket.id}`);
  // 真机 E2E 里 `agent/created` 在 `sessionController.create()` 期间触发，而那时账本还没有
  // execution 记录 → decorate() 找不到工单、静默跳过：worker 拿到的是 standard 工具集，
  // 没有 commander_report，于是任务做完也不汇报。spawn 必须在 setExecution 后自己装饰。
  assert.equal(worker.record.sections.length, 1, 'worker 要有人设 section');
  assert.match(worker.record.sections[0].text(), /Worker Session/u);
  assert.equal(worker.record.restricts.length, 1, 'worker 工具要收紧');
  assert.ok(worker.record.restricts[0].allow.includes('commander_report'));
  assert.equal(worker.record.tools[0].name, 'commander_report', 'worker 必须拿到 commander_report');
  assert.equal(worker.record.guards.length, 2, 'worker 要有工具白名单 + 工单结束两个 guard');
});

test('spawn：同一工单只能一个 Worker；超过 maxWorkers 拒绝', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent } = workersOf({ ledger, options: { maxWorkers: 1 } });
  await service.spawn({ parentAgent: parent, ticketId: ticket.id, task: 'A' });
  await assert.rejects(async () => service.spawn({ parentAgent: parent, ticketId: ticket.id, task: 'B' }), /已有 Worker Session/u);
  const second = ledger.createTicket({ sessionId: PARENT, title: '第二张' });
  await assert.rejects(async () => service.spawn({ parentAgent: parent, ticketId: second.id, task: 'C' }), /已达上限/u);
});

test('decorate：worker 创建后注入人设、收紧工具、注册 commander_report 与结束 guard', () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, record, emit } = workersOf({ ledger });
  // 先让账本有执行信息（否则 findByWorkerSession 找不到）。
  ledger.setExecution(ticket.id, PARENT, { sessionId: `worker-${ticket.id}`, directory: '/tmp/w' });
  const worker = makeAgent(`worker-${ticket.id}`);
  record.workers.set(`worker-${ticket.id}`, worker);
  emit('agent/created', { agent: worker });
  assert.equal(worker.record.sections.length, 1);
  assert.match(worker.record.sections[0].text(), /Worker Session/u);
  assert.equal(worker.record.restricts.length, 1);
  assert.ok(worker.record.restricts[0].allow.includes('commander_report'));
  assert.ok(worker.record.restricts[0].allow.includes('write'));
  // ⚠️ 静态清单，不能按 decorate 时刻的 `tools.get()` 过滤：那一刻 preset 的全局工具可能还
  // 没组装完，过滤出来是空数组 → restrict 会把所有工作工具都屏蔽（0.9.1 web E2E 踩过）。
  // 假 ctx 的 `get()` 只认识 read/write/commander_report，这里的 pwsh 就是回归证据。
  assert.ok(worker.record.restricts[0].allow.includes('pwsh'), 'restrict 的 allow 必须是静态清单');
  assert.equal(worker.record.tools[0].name, 'commander_report');
  assert.equal(worker.record.guards.length, 2);
  // 第一个是工具白名单 guard：非工作工具一律拒绝，工作工具放行。
  assert.match(worker.record.guards[0]({ name: 'subagent' }), /只允许工作工具/u);
  assert.equal(worker.record.guards[0]({ name: 'write' }), undefined);
  // 第二个是工单结束 guard：工单未结束时应放行。
  assert.equal(worker.record.guards[1](), undefined, '工单未结束时应放行');
});

test('report：写账本并 steer 指挥者；工单结束后 report 返回 ticket-ended', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record, emit } = workersOf({ ledger });
  ledger.setExecution(ticket.id, PARENT, { sessionId: `worker-${ticket.id}`, directory: '/tmp/w' });
  const worker = makeAgent(`worker-${ticket.id}`);
  record.workers.set(`worker-${ticket.id}`, worker);
  emit('agent/created', { agent: worker });
  const tool = worker.record.tools[0];
  const value = tool.execute({ status: 'ready', summary: '实现完成，单测通过' });
  assert.deepEqual(value, { ok: true, ticket: ticket.id, status: 'ready' });
  assert.equal(ledger.getTicket(ticket.id, PARENT).status, 'review');
  assert.equal(parent.record.steers.length, 1);
  assert.match(parent.record.steers[0].content[0].text, /执行者汇报/u);
  assert.match(parent.record.steers[0].content[0].text, /ready/u);
  ledger.setStatus(ticket.id, PARENT, 'done');
  assert.deepEqual(tool.execute({ status: 'ready', summary: 'late' }), { ok: false, reason: 'ticket-ended' });
});

test('send / status / stop：追加指令、可用性、停止记录 blocked', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record } = workersOf({ ledger });
  await service.spawn({ parentAgent: parent, ticketId: ticket.id, task: 'A' });
  const worker = record.workers.get(`worker-${ticket.id}`);
  await service.send({ parentAgent: parent, ticketId: ticket.id, text: '补一个边界用例' });
  assert.match(worker.record.steers.at(-1).content[0].text, /追加指令/u);
  const status = await service.status({ parentAgent: parent, ticketId: ticket.id });
  assert.equal(status.worker.available, true);
  assert.equal(status.worker.session_id, `worker-${ticket.id}`);
  await service.stop({ parentAgent: parent, ticketId: ticket.id, reason: '方向错了' });
  assert.equal(worker.record.cancels[0], '方向错了');
  assert.equal(ledger.getTicket(ticket.id, PARENT).status, 'blocked');
});

test('resume：重启后指挥者创建时为 open 工单的 worker 发恢复提示并标记', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record, emit } = workersOf({ ledger });
  ledger.setExecution(ticket.id, PARENT, { sessionId: `worker-${ticket.id}`, directory: '/tmp/w' });
  const worker = makeAgent(`worker-${ticket.id}`);
  record.workers.set(`worker-${ticket.id}`, worker);
  emit('agent/created', { agent: parent });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(worker.record.steers.at(-1).content[0].text, /恢复/u);
  assert.notEqual(ledger.getTicket(ticket.id, PARENT).execution.resumedAt, null);
});

test('idle 兜底：worker 空转未汇报时提醒指挥者（并节流）', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent, record, emit } = workersOf({ ledger });
  await service.spawn({ parentAgent: parent, ticketId: ticket.id, task: 'A' });
  const worker = record.workers.get(`worker-${ticket.id}`);
  emit('agent/status', { agent: worker, status: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parent.record.steers.length, 1);
  assert.match(parent.record.steers[0].content[0].text, /执行者静默/u);
  emit('agent/status', { agent: worker, status: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parent.record.steers.length, 1, '同一工单 10 分钟内不重复提醒');
});

test('缺宿主服务：spawn 精确点名 sessionController / workspaceRegistry', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    get: () => undefined,
    on: () => () => {},
  };
  const service = new CommanderWorkers({
    ctx,
    ledger,
    getOptions: () => ({ workerSessions: true, maxWorkers: 2 }),
  });
  const parent = makeAgent(PARENT);
  await assert.rejects(
    async () => service.spawn({ parentAgent: parent, ticketId: ticket.id, task: 'x' }),
    /缺少宿主服务：sessionController、workspaceRegistry/u,
  );
});

test('worker 工具：指挥者专用、schema 齐全、缺服务给可执行错误', async () => {
  const { ledger, ticket } = ledgerWithTicket();
  const { service, parent } = workersOf({ ledger });
  const tools = buildWorkerTools({ getWorkers: () => service });
  assert.deepEqual(tools.map((tool) => tool.name), [
    'commander_worker_spawn',
    'commander_worker_send',
    'commander_worker_status',
    'commander_worker_stop',
  ]);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
  }
  const spawn = tools[0];
  assert.deepEqual(spawn.parameters.required, ['ticket', 'task']);
  const childExec = { agent: { session: { id: 'c', header: { parentSession: PARENT } } } };
  await assert.rejects(async () => spawn.execute({ ticket: ticket.id, task: 'x' }, childExec), /只有指挥者本人/u);
  const missing = buildWorkerTools({ getWorkers: () => undefined })[0];
  await assert.rejects(async () => missing.execute({ ticket: ticket.id, task: 'x' }, { agent: parent }), /Worker Session 服务不可用/u);
});

// ------------------------------------------- 停滞看门狗（3.3.0，会话 def6609d） ---
//
// 会话 def6609d 的现场：worker 卡在**回合中途**（28 步后长时间无事件、没有 turn/end），
// 既不会触发 `agent/status = idle`（idle 兜底不生效），也不会 commander_report ——
// 指挥者永远等不到唤醒，整个会话静默挂死。看门狗用定时扫描补上这一层。

/** 固定基准时间。 */
const T0 = 1_000_000_000;

/** 建一个"有执行信息"的工单（startedAt = 当前账本时钟）。 */
function withExecution(ledger, ticket) {
  ledger.setExecution(ticket.id, PARENT, { sessionId: `worker-${ticket.id}`, directory: '/tmp/w' });
  return ticket;
}

test('停滞看门狗：install 启动 60s 定时器并 unref，dispose 清理且不再重启', () => {
  const { ledger } = ledgerWithTicket();
  const timers = fakeTimers();
  const { service, dispose } = workersOf({ ledger, deps: timers });
  assert.equal(timers.handles.length, 1, 'install 应启动一个定时器');
  assert.equal(timers.handles[0].ms, 60_000, '扫描间隔 60 秒');
  assert.equal(timers.handles[0].unrefed, true, '定时器要 unref，不能拖住进程退出');
  // 重复调用 startStallWatch 不重复启动。
  service.startStallWatch();
  assert.equal(timers.handles.length, 1);
  // disposer 停止定时器。
  dispose();
  assert.equal(timers.handles[0].cleared, true, 'dispose 应 clearInterval');
  // dispose 之后即使再调也不重启（disposed 标记）。
  service.startStallWatch();
  assert.equal(timers.handles.length, 1);
});

test('停滞看门狗：开工 11 分钟且从未回报 → 提醒一次并返回工单 id', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket); // startedAt = T0
  const timers = fakeTimers();
  const { service, parent } = workersOf({ ledger, now: () => clock, deps: timers });
  clock = T0 + 11 * 60_000;

  const notified = service.scanStalls();
  assert.deepEqual(notified, [ticket.id], '应返回本次被提醒的工单 id');
  await flushAsync();
  assert.equal(parent.record.steers.length, 1, '应 steer 唤醒指挥者');
  const text = parent.record.steers[0].content[0].text;
  // 文案要让指挥者知道"为什么 idle 兜底没生效"以及下一步怎么办。
  assert.match(text, /执行者疑似停滞/u, text);
  assert.match(text, /可能卡在回合中途（不会触发 idle）/u, text);
  assert.match(text, /commander_worker_stop/u, text);
  assert.match(text, /不要直接重派同一任务/u, text);
  assert.match(text, /已开工约 11 分钟/u, text);
});

test('停滞看门狗：开工后回报过 → 不提醒（回报本身就是"还活着"的证据）', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket); // startedAt = T0
  clock = T0 + 5 * 60_000;
  ledger.recordReport(ticket.id, PARENT, { status: 'progress', summary: '还在做' }); // lastReport.at = T0+5min
  const { service, parent } = workersOf({ ledger, now: () => clock, deps: fakeTimers() });
  clock = T0 + 11 * 60_000;

  assert.deepEqual(service.scanStalls(), [], '开工后回报过不算停滞');
  await flushAsync();
  assert.equal(parent.record.steers.length, 0);
});

test('停滞看门狗：未到 ticketStallMs 阈值 → 不提醒；正好到阈值 → 提醒（>= 语义）', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket);
  const { service, parent } = workersOf({ ledger, now: () => clock, deps: fakeTimers() });
  clock = T0 + 5 * 60_000; // 默认阈值 10 分钟

  assert.deepEqual(service.scanStalls(), []);
  await flushAsync();
  assert.equal(parent.record.steers.length, 0);

  // 正好 10 分钟：实现用 `now - startedAt < threshold` 跳过，所以等于阈值时**应提醒**。
  clock = T0 + 10 * 60_000;
  assert.deepEqual(service.scanStalls(), [ticket.id], '正好达到阈值应提醒');
  await flushAsync();
  assert.equal(parent.record.steers.length, 1);
});

test('停滞看门狗：同一工单 10 分钟节流（不每分钟唤醒指挥者）', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket);
  const { service, parent } = workersOf({ ledger, now: () => clock, deps: fakeTimers() });

  clock = T0 + 11 * 60_000;
  assert.deepEqual(service.scanStalls(), [ticket.id], '第一次提醒');
  await flushAsync();
  assert.equal(parent.record.steers.length, 1);

  // 9 分钟后（距上次 < 10 分钟）→ 不提醒。
  clock = T0 + 20 * 60_000;
  assert.deepEqual(service.scanStalls(), []);
  await flushAsync();
  assert.equal(parent.record.steers.length, 1);

  // 再 1 分钟（距上次正好 10 分钟）→ 允许再次提醒。
  clock = T0 + 21 * 60_000;
  assert.deepEqual(service.scanStalls(), [ticket.id], '节流窗口过后可再次提醒');
  await flushAsync();
  assert.equal(parent.record.steers.length, 2);
});

test('停滞看门狗：workerSessions:false → 不扫描、不提醒', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket);
  const timers = fakeTimers();
  const { service, parent } = workersOf({ ledger, now: () => clock, options: { workerSessions: false }, deps: timers });
  clock = T0 + 11 * 60_000;

  assert.deepEqual(service.scanStalls(), []);
  await flushAsync();
  assert.equal(parent.record.steers.length, 0);
  assert.equal(timers.handles.length, 0, '未启用时不应启动看门狗定时器');
});

test('停滞看门狗：已结束工单不算停滞（activeExecutions 已过滤终态）', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  withExecution(ledger, ticket);
  const { service, parent } = workersOf({ ledger, now: () => clock, deps: fakeTimers() });
  ledger.setStatus(ticket.id, PARENT, 'done');
  clock = T0 + 30 * 60_000;

  assert.deepEqual(service.scanStalls(), []);
  await flushAsync();
  assert.equal(parent.record.steers.length, 0);
});

test('停滞看门狗：多工单里只提醒真正停滞的那张', async () => {
  let clock = T0;
  const { ledger, ticket } = ledgerWithTicket({ now: () => clock });
  const second = ledger.createTicket({ sessionId: PARENT, title: '第二张', acceptance: ['ok'] });
  withExecution(ledger, ticket); // 停滞
  withExecution(ledger, second); // 有回报
  clock = T0 + 3 * 60_000;
  ledger.recordReport(second.id, PARENT, { status: 'progress', summary: '在跑' });
  const { service } = workersOf({ ledger, now: () => clock, deps: fakeTimers() });
  clock = T0 + 11 * 60_000;

  assert.deepEqual(service.scanStalls(), [ticket.id], '只提醒从未回报的那张');
});