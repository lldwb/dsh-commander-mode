/**
 * 外部事件投递器（`lib/event-inbox.js`）的测试。
 *
 * 用真实临时目录 + 假 ctx（agents/sessions/ledger）：验证"事件文件 → 路由到指挥者会话 →
 * steer → 归档"这条链路，以及**失败不丢事件**（目标会话不在时留在 inbox、坏格式进
 * rejected、同 id 不重复投递）。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CommanderEventInbox, MIN_EVENT_POLL_MS, readInbox } from '../lib/event-inbox.js';
import { resolveEventDir } from '../lib/events.js';

/** 临时 DSH_HOME（事件目录 = <home>/commander/events）。 */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'commander-events-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** 假 agent。 */
function makeAgent(id) {
  const record = { steers: [] };
  return {
    id,
    session: { id, header: { id } },
    record,
    steer: (message) => record.steers.push(message),
  };
}

/** 假 ctx / services。 */
function makeContext({ agents = new Map(), sessions } = {}) {
  const services = {
    agents: { get: (id) => agents.get(id) },
    sessions,
  };
  return {
    agents,
    ctx: {
      logger: { info: () => {}, debug: () => {}, warn: () => {} },
      get: (name) => services[name],
    },
  };
}

/** 建投递器。 */
function inboxOf({ home, agents, sessions, ledger = null, options = {}, deps = {} } = {}) {
  const built = makeContext({ agents: agents ?? new Map(), sessions });
  const events = new CommanderEventInbox({
    ctx: built.ctx,
    ledger: ledger ?? { sessionOfTicket: () => null },
    getOptions: () => ({
      stateDir: '',
      eventInbox: true,
      eventPollMs: 15000,
      ...options,
    }),
    deps: {
      env: { DSH_HOME: home, DSH_PROFILE: 'test' },
      ...deps,
    },
  });
  return { events, agents: built.agents };
}

/** 直接往 inbox 写事件文件（模拟外部系统）。 */
function writeEvent(home, name, payload) {
  const dir = join(resolveEventDir({ env: { DSH_HOME: home, DSH_PROFILE: 'test' } }), 'inbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return file;
}

/** 事件目录。 */
function eventDirOf(home) {
  return resolveEventDir({ env: { DSH_HOME: home, DSH_PROFILE: 'test' } });
}

test('按 ticket 路由：找到所属会话 → steer 唤醒 → 文件移进 delivered/', async (t) => {
  const home = tempHome(t);
  const agent = makeAgent('session-1');
  const agents = new Map([['session-1', agent]]);
  const { events } = inboxOf({ home, agents, ledger: { sessionOfTicket: (ticket) => (ticket === 't-3' ? 'session-1' : null) } });
  writeEvent(home, 'evt-1.json', {
    kind: 'ci-failed',
    summary: 'build #42 失败',
    detail: 'https://ci/42',
    ticket: 't-3',
    source: 'github-actions',
  });
  assert.equal(events.pendingCount(), 1);

  const result = await events.scanOnce();
  assert.deepEqual(result, { delivered: 1, rejected: 0, deferred: 0 });
  assert.equal(agent.record.steers.length, 1);
  const message = agent.record.steers[0];
  assert.equal(message.role, 'user');
  assert.match(message.content[0].text, /【指挥者·外部事件】ci-failed/u);
  assert.match(message.content[0].text, /build #42 失败/u);
  assert.match(message.content[0].text, /关联工单：t-3/u);
  assert.deepEqual(message.source, { kind: 'dsh-commander-mode', form: 'notice', summary: '外部事件：ci-failed' });

  assert.equal(events.pendingCount(), 0);
  assert.equal(readdirSync(join(eventDirOf(home), 'delivered')).includes('evt-1.json'), true);
});

test('按 session 路由优先于 ticket；目标会话不可用时事件留在 inbox，恢复后补投', async (t) => {
  const home = tempHome(t);
  const agents = new Map();
  const { events } = inboxOf({ home, agents, ledger: { sessionOfTicket: () => 'session-by-ticket' } });
  writeEvent(home, 'evt-2.json', {
    kind: 'alert',
    summary: '磁盘 90%',
    session: 'session-explicit',
    ticket: 't-1',
  });

  assert.deepEqual(await events.scanOnce(), { delivered: 0, rejected: 0, deferred: 1 });
  assert.equal(events.pendingCount(), 1, '不可投递时不能丢事件');
  assert.ok(existsSync(join(eventDirOf(home), 'inbox', 'evt-2.json')));

  // 会话恢复后应投给显式 session，而不是 ticket 反查出来的会话。
  const explicit = makeAgent('session-explicit');
  const byTicket = makeAgent('session-by-ticket');
  agents.set('session-explicit', explicit);
  agents.set('session-by-ticket', byTicket);
  assert.deepEqual(await events.scanOnce(), { delivered: 1, rejected: 0, deferred: 0 });
  assert.equal(explicit.record.steers.length, 1);
  assert.equal(byTicket.record.steers.length, 0);
});

test('sessions.resolveAgent 兜底：实时注册表没有时仍能投递', async (t) => {
  const home = tempHome(t);
  const agent = makeAgent('session-9');
  const sessions = {
    resolveAgent: async (id) => (id === 'session-9' ? { agent } : { error: { code: 'session/not-found' } }),
  };
  const { events } = inboxOf({ home, sessions, ledger: { sessionOfTicket: () => 'session-9' } });
  writeEvent(home, 'evt-3.json', { kind: 'issue', summary: '新评论', ticket: 't-1' });
  assert.deepEqual(await events.scanOnce(), { delivered: 1, rejected: 0, deferred: 0 });
  assert.equal(agent.record.steers.length, 1);
});

test('坏 JSON / 缺必填：进 rejected/，不投递、不无限重试', async (t) => {
  const home = tempHome(t);
  const agent = makeAgent('session-1');
  const { events } = inboxOf({
    home,
    agents: new Map([['session-1', agent]]),
    ledger: { sessionOfTicket: () => 'session-1' },
  });
  writeEvent(home, 'broken.json', '{ not json');
  writeEvent(home, 'missing-summary.json', { kind: 'ci', ticket: 't-1' });
  const result = await events.scanOnce();
  assert.deepEqual(result, { delivered: 0, rejected: 2, deferred: 0 });
  assert.equal(agent.record.steers.length, 0);
  assert.equal(events.pendingCount(), 0);
  const rejected = readdirSync(join(eventDirOf(home), 'rejected')).sort();
  assert.deepEqual(rejected, ['broken.json', 'missing-summary.json']);
});

test('同 id 只投一次（归档失败也不重复投递）', async (t) => {
  const home = tempHome(t);
  const agent = makeAgent('session-1');
  const { events } = inboxOf({
    home,
    agents: new Map([['session-1', agent]]),
    ledger: { sessionOfTicket: () => 'session-1' },
    deps: {
      // 模拟归档永远失败：文件留在 inbox，但 deliveredIds 应阻止第二次 steer。
      rename: () => {
        throw new Error('rename blocked');
      },
    },
  });
  writeEvent(home, 'evt-dup.json', { id: 'evt-dup', kind: 'ci', summary: 'x', ticket: 't-1' });
  assert.deepEqual(await events.scanOnce(), { delivered: 1, rejected: 0, deferred: 0 });
  // 第二次扫描：文件还在 inbox（归档失败），但 id 已投递 → 只归档、不再 steer。
  await events.scanOnce();
  assert.equal(agent.record.steers.length, 1);
  assert.equal(events.pendingCount(), 1, '文件仍在 inbox（归档失败可观察）');
});

test('install：默认 15 秒轮询、可配间隔、释放后清定时器；关闭时不启动', (t) => {
  const home = tempHome(t);
  const timers = [];
  const cleared = [];
  const deps = {
    setInterval: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  };
  const { events } = inboxOf({ home, deps });
  const dispose = events.install();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15000);
  dispose();
  assert.equal(cleared.length, 1);

  const custom = inboxOf({ home, deps, options: { eventPollMs: 2000 } });
  custom.events.install();
  assert.equal(timers.at(-1).ms, 2000);

  // 低于下限的配置被夹住（防止配置写 0 造成忙等）。
  const low = inboxOf({ home, deps, options: { eventPollMs: 1 } });
  low.events.install();
  assert.equal(timers.at(-1).ms, MIN_EVENT_POLL_MS);

  const stopped = [];
  const disabled = inboxOf({
    home,
    deps: { ...deps, setInterval: () => { stopped.push(1); return {}; } },
    options: { eventInbox: false },
  });
  const off = disabled.events.install();
  off();
  assert.equal(stopped.length, 0, 'eventInbox:false 时不应启动轮询');
});

test('readInbox：只读列出条目（含解析错误），不改动文件', (t) => {
  const home = tempHome(t);
  writeEvent(home, 'evt-a.json', { kind: 'ci', summary: 'A', ticket: 't-1' });
  writeEvent(home, 'evt-b.json', 'not json');
  const { dir, entries } = readInbox(eventDirOf(home));
  assert.equal(dir, eventDirOf(home));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event.kind, 'ci');
  assert.equal(entries[1].event, null);
  assert.match(entries[1].errors[0], /JSON 解析失败/u);
  // 只读：文件还在。
  assert.equal(readdirSync(join(eventDirOf(home), 'inbox')).length, 2);
});

test('prune：归档目录只保留最近 200 条', async (t) => {
  const home = tempHome(t);
  const delivered = join(eventDirOf(home), 'delivered');
  mkdirSync(delivered, { recursive: true });
  for (let index = 0; index < 205; index += 1) {
    writeFileSync(join(delivered, `old-${String(index).padStart(3, '0')}.json`), '{}');
  }
  const { events } = inboxOf({ home });
  events.prune('delivered');
  const names = readdirSync(delivered);
  assert.equal(names.length, 200);
  assert.ok(!names.includes('old-000.json'), '最老的应被裁掉');
});

test('inbox 文件内容就是投递正文的来源（路径无关）', async (t) => {
  const home = tempHome(t);
  const agent = makeAgent('session-1');
  const file = writeEvent(home, 'evt-x.json', { kind: 'ci', summary: 'X', ticket: 't-1' });
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.kind, 'ci');
  assert.equal(stored.summary, 'X');
  const { events } = inboxOf({ home, agents: new Map([['session-1', agent]]), ledger: { sessionOfTicket: () => 'session-1' } });
  await events.scanOnce();
  assert.match(agent.record.steers[0].content[0].text, /X/u);
});
