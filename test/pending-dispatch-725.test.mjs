/**
 * 7.25.0「建单未派」测试：看板告警 + 回合收尾提醒 + 建单返回提示。
 *
 * ## 覆盖的判据（与工单四条一一对应）
 *
 * 1. 建单超 2 分钟仍未派 → 看板告警触发，`detail` 点名工单 id；
 * 2. 未到 2 分钟 → 不触发（给模型下一步的机会）；
 * 3. `assignments` 非空（已派）→ 不触发（告警可被"派活"消除）；
 * 4. waiting-on-user（waiting / blocked）→ 不触发；
 * 5. turn-stopping：有建单未派 → 注入一次、同 turn 不重复；派活后 / 无单 → 不注入；
 * 6. `commander_ticket_create` 的返回文本含「下一步必须派活」；
 * 7. 新 issue 不破坏既有 issues 的顺序与数量，且不进入 `buildSyncNudge`
 *    （避免和专用收尾提醒重复注入）。
 *
 * ## 为什么用真实 `apply()`
 *
 * 判据逻辑（sync.js）用单元测试就够；但「收尾注入」必须证明 **agent.js 的监听器真的接上了**
 * `buildPendingDispatchAdvisory`（否则又是一条"只写在 lib 里"的功能）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../agent.js';
import { emptyLedger } from '../lib/ledger.js';
import { CommanderLedger } from '../lib/ledger-service.js';
import {
  PENDING_DISPATCH_GRACE_MS,
  TICKET_BACKLOG_LIMIT,
  buildPendingDispatchAdvisory,
  buildSyncNudge,
  evaluateSync,
  pendingDispatchTickets,
  renderSyncBoard,
} from '../lib/sync.js';
import { buildTicketTools } from '../lib/ticket-tools.js';

/** 一个「刚建、还没派」的原始工单（账本形状：`createdAt`）。 */
function ticket(overrides = {}) {
  return {
    id: 't-123',
    title: '实现登录',
    status: 'open',
    assignments: [],
    createdAt: 1_000_000,
    ...overrides,
  };
}

/** 一个最小账本（evaluateSync 只读这几个字段）。 */
function ledgerWith(tasks = []) {
  const ledger = {
    epoch: 0,
    plan: undefined,
    tasks: new Map(),
    terminalEpoch: 0,
    delegations: { team: 0, oneShot: 0 },
    recentDelegations: [],
    staleNudged: false,
  };
  for (const task of tasks) ledger.tasks.set(task.id, task);
  return ledger;
}

const LATER = 1_000_000 + PENDING_DISPATCH_GRACE_MS;
const EARLY = 1_000_000 + 30_000;

// ---------------------------------------------------- 1~4：看板告警判据 ---

test('1) 建单超过宽限期仍未派 → 告警触发且点名工单 id', () => {
  const tickets = [ticket()];
  const view = evaluateSync(ledgerWith(), { now: LATER, tickets });
  const issue = view.issues.find((item) => item.code === 'ticket-created-not-dispatched');
  assert.ok(issue, '应当产生 ticket-created-not-dispatched');
  assert.ok(issue.detail.includes('t-123'), issue.detail);
  assert.ok(issue.detail.includes('还没派活'), issue.detail);
  assert.deepEqual(issue.ticketIds, ['t-123']);
  // 看板渲染要给出「现在派活」的下一步动作。
  const board = renderSyncBoard(view);
  assert.ok(board.includes('t-123'), board);
  assert.ok(board.includes('现在派活'), board);
});

test('2) 未到宽限期 → 不触发（刚建的单给模型下一步的机会）', () => {
  const view = evaluateSync(ledgerWith(), { now: EARLY, tickets: [ticket()] });
  assert.equal(view.issues.some((item) => item.code === 'ticket-created-not-dispatched'), false);
  assert.deepEqual(pendingDispatchTickets([ticket()], { now: EARLY }), []);
  // 边界：恰好到宽限期即算"超时"。
  assert.equal(pendingDispatchTickets([ticket()], { now: LATER }).length, 1);
});

test('3) 已派活（assignments 非空）→ 不触发（派活即消除）', () => {
  const assigned = ticket({ assignments: [{ id: 'a-1', channel: 'team', tool: 'subagent', ref: 'lead-1' }] });
  const view = evaluateSync(ledgerWith(), { now: LATER, tickets: [assigned] });
  assert.equal(view.issues.some((item) => item.code === 'ticket-created-not-dispatched'), false);
});

test('4) waiting-on-user（waiting / blocked）→ 不触发；终态也不触发', () => {
  for (const status of ['waiting', 'blocked']) {
    const view = evaluateSync(ledgerWith(), { now: LATER, tickets: [ticket({ status })] });
    assert.equal(view.issues.some((item) => item.code === 'ticket-created-not-dispatched'), false, status);
  }
  for (const status of ['done', 'cancelled', 'failed', 'dropped']) {
    assert.deepEqual(pendingDispatchTickets([ticket({ status })], { now: LATER }), [], status);
  }
  // 视图形状（`created_at`）也要认。
  const fromView = ticket({ createdAt: undefined, created_at: LATER - PENDING_DISPATCH_GRACE_MS });
  assert.equal(pendingDispatchTickets([fromView], { now: LATER }).length, 1);
});

// ------------------------------------------- 5：turn-stopping 注入（接线） ---

/**
 * 造一个只够 `apply()` 跑起来的最小 Cordis 上下文。
 *
 * 依赖缺一个时 `inject` 回调不执行（与真实 Cordis 一致），所以这里只给
 * `commanderLedger` / `agentTeams` 两个服务，其它能力行按"精简部署"降级。
 *
 * @param {object[]} tickets - `commanderLedger.listTickets()` 返回的工单。
 * @returns {{ ctx: object, listeners: object[] }} mock 上下文与监听器。
 */
function makeCtx(tickets) {
  const listeners = [];
  const logger = { info: () => {}, debug: () => {}, warn: () => {} };
  const services = {
    commanderLedger: {
      listTickets: () => tickets,
      getSyncSnapshot: () => undefined,
      putSyncSnapshot: () => {},
    },
    agentTeams: { isEnabled: () => true, listTasks: () => [] },
  };
  const ctx = {
    logger,
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
    },
    on: (event, listener) => {
      listeners.push({ event, listener });
      return () => {};
    },
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: (name) => services[name],
    inject: (dependencies, callback) => {
      const available = {};
      for (const dependency of dependencies) {
        if (services[dependency] !== undefined) available[dependency] = services[dependency];
      }
      if (Object.keys(available).length !== dependencies.length) return;
      callback({ ...available, logger, effect: ctx.effect, on: ctx.on, get: ctx.get });
    },
  };
  return { ctx, listeners };
}

/** 可注入消息的 root 指挥者 agent。 */
function injectableCommander() {
  const agent = { id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead' } }, injected: [] };
  agent.inject = (message) => {
    agent.injected.push(message);
  };
  return agent;
}

/** 取 `agent/turn-stopping` 监听器。 */
function turnStopping(listeners) {
  const entry = listeners.find((item) => item.event === 'agent/turn-stopping');
  assert.ok(entry, '必须注册 agent/turn-stopping 监听器');
  return entry.listener;
}

test('5) turn-stopping：有建单未派 → 注入一次且同 turn 不重复；派活/无单后不注入', () => {
  const tickets = [ticket({ createdAt: Date.now() - PENDING_DISPATCH_GRACE_MS - 60_000 })];
  const { ctx, listeners } = makeCtx(tickets);
  apply(ctx);
  const stop = turnStopping(listeners);
  const agent = injectableCommander();

  stop({ agent, turn: 3, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1, '应当注入一次建单未派提醒');
  const message = agent.injected[0];
  assert.equal(message.role, 'user');
  assert.notEqual(message.source.kind, 'user', '不能冒充用户输入');
  const text = message.content.map((block) => block.text ?? '').join('');
  assert.ok(text.includes('建单未派'), text);
  assert.ok(text.includes('t-123'), '要点名工单');
  assert.ok(text.includes('send_message'), '要给出下一步动作');

  // 同一回合再收尾一次：不重复注入。
  stop({ agent, turn: 3, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1, '同一 turn 只注入一次');

  // 派活后（assignments 非空）：新回合不再注入。
  tickets[0] = ticket({ createdAt: Date.now() - PENDING_DISPATCH_GRACE_MS - 60_000, assignments: [{ id: 'a-1' }] });
  stop({ agent, turn: 4, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1, '已派活的单不该再催');

  // 无单：不注入。
  tickets.length = 0;
  stop({ agent, turn: 5, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1);
});

test('5b) turn-stopping：未到宽限期 / 被中断的回合 → 不注入', () => {
  const tickets = [ticket({ createdAt: Date.now() })];
  const { ctx, listeners } = makeCtx(tickets);
  apply(ctx);
  const stop = turnStopping(listeners);
  const agent = injectableCommander();

  stop({ agent, turn: 1, signal: { aborted: false } });
  assert.equal(agent.injected.length, 0, '刚建的单不该催');

  tickets[0] = ticket({ createdAt: Date.now() - PENDING_DISPATCH_GRACE_MS - 60_000 });
  stop({ agent, turn: 2, signal: { aborted: true } });
  assert.equal(agent.injected.length, 0, '已中断的回合不该注入');
});

// -------------------------------------------- 6：建单返回文本的下一步 ---

test('6) commander_ticket_create 返回文本含「下一步必须派活」', async () => {
  let state = emptyLedger();
  const ledger = new CommanderLedger({
    file: 'memory.json',
    load: () => ({ state }),
    save: (_file, next) => {
      state = JSON.parse(JSON.stringify(next));
    },
  });
  ledger.load();
  const set = buildTicketTools({ getLedger: () => ledger });
  const create = set.find((tool) => tool.name === 'commander_ticket_create');
  const exec = { agent: { session: { id: 's-1', header: {} } } };
  const value = await create.execute({ title: '实现登录' }, exec);
  const text = create.output.render({}, value)[0].text;
  assert.ok(text.includes('下一步必须派活'), text);
  assert.ok(text.includes(value.ticket.id), '提示里要带工单 id');
});

// ------------------------------- 7：不破坏既有 issues / 不与收尾提醒重复 ---

test('7) 新 issue 追加在既有 issues 之后；不进入 buildSyncNudge（避免重复注入）', () => {
  // 既有 issue：任务板积压（`ticket-backlog`）——它是会进入通用收尾提醒的那一类。
  const tasks = [];
  for (let index = 0; index <= TICKET_BACKLOG_LIMIT; index += 1) {
    tasks.push({ id: `task-${index}`, status: 'in_progress', terminalEpoch: 0, changedAt: LATER, ownerName: '' });
  }
  const ledger = ledgerWith(tasks);
  const view = evaluateSync(ledger, { now: LATER, tickets: [ticket()] });
  const codes = view.issues.map((item) => item.code);
  assert.deepEqual(codes, ['ticket-backlog', 'ticket-created-not-dispatched'], `既有 issue 顺序不变：${codes.join(',')}`);

  // 既有 issue 仍会进入收尾提醒；新 issue 由专用提醒负责，不在这里重复。
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('同时开着'), nudge);
  assert.equal(nudge.includes('已建但还没派活'), false, '建单未派不该进入通用收尾提醒');
  assert.equal(buildPendingDispatchAdvisory([ticket()], { now: LATER }).includes('建单未派'), true);

  // 没有工单时，既有告警数量不变（不凭空多一条）。
  const noTickets = evaluateSync(ledger, { now: LATER, tickets: [] });
  assert.deepEqual(noTickets.issues.map((item) => item.code), ['ticket-backlog']);
});
