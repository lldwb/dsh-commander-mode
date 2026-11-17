/**
 * 「同步账本持久化」的测试（`lib/sync-store.js`，7.12.0 新增）。
 *
 * ## 为什么需要它（实测事故）
 *
 * `session-1d8c8c60` 跑了 **52 小时 / 127 回合**，宿主中途重启过。而同步账本是
 * `agent.js` 的 `WeakMap` + `createSyncLedger()`（纯内存），agent 一重建就全丢：
 * - 看板从 11-16 02:51 起**再也没有「计划清单」那一段**（前一天的「2/8 已完成」是重启前写的）；
 * - `plan-stale` **52 小时零触发**——检测静默失效，没人发现；
 * - `dispatchTargets` 归零 → "派活过度集中"重启后报不出来。
 *
 * 所以这里钉三件事：
 * 1. **往返一致**：`toSnapshot()` → `applySnapshot()` 后关键判断依据（epoch / plan / tasks /
 *    turns / dispatchTargets / delegations）都还在；
 * 2. **坏快照不炸**：schema 不匹配、字段非法、`null`、乱码对象 → 一律静默退回默认值；
 * 3. **有界**：任务与派活目标超出上限时被裁剪，不会把账本撑大。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SNAPSHOT_TARGETS,
  MAX_SNAPSHOT_TASKS,
  SNAPSHOT_SCHEMA,
  applySnapshot,
  createRestoredLedger,
  toSnapshot,
} from '../lib/sync-store.js';
import { createSyncLedger, recordDelegation, recordPlan, recordTurn, DELEGATION_CHANNELS, evaluateSync } from '../lib/sync.js';
import { CommanderLedger } from '../lib/ledger-service.js';
import { emptyLedger } from '../lib/ledger.js';

/** 造一个"跑过一阵"的账本：有清单、有任务、有派活统计、有回合数。 */
function busyLedger() {
  const ledger = createSyncLedger();
  recordPlan(ledger, [
    { content: '取证 A', status: 'completed' },
    { content: '根因 C', status: 'in_progress' },
    { content: '修复 D', status: 'pending' },
  ]);
  ledger.tasks = new Map([
    ['task-1', { id: 'task-1', status: 'completed', subject: 'a', ownerName: 'lead-a', ready: true, blockedBy: [], ticketStatus: 'done', terminalEpoch: ledger.epoch, changedAt: 1000 }],
    ['task-2', { id: 'task-2', status: 'in_progress', subject: 'b', ownerName: 'lead-b', ready: true, blockedBy: [], ticketStatus: 'progress', terminalEpoch: 0, changedAt: 2000 }],
  ]);
  ledger.terminalEpoch = ledger.epoch;
  recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'lead-a');
  recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'lead-a');
  recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'lead-b');
  for (let i = 0; i < 16; i += 1) recordTurn(ledger);
  return ledger;
}

test('7.12.0：快照往返后，判断依据必须一条不少', () => {
  const before = busyLedger();
  const snapshot = toSnapshot(before);
  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);

  // 模拟"宿主重启"：全新账本 + 恢复
  const after = createRestoredLedger(snapshot);

  assert.equal(after.epoch, before.epoch, 'epoch 必须恢复（plan-stale 靠它排序）');
  assert.equal(after.terminalEpoch, before.terminalEpoch);
  assert.equal(after.turns, before.turns, '回合数必须恢复（长会话体检靠它）');
  assert.equal(after.plan?.total, 3, '计划清单必须恢复');
  assert.equal(after.plan?.openCount, 2);
  assert.equal(after.tasks?.size, 2, '任务板必须恢复（否则 plan-stale 没有比较对象）');
  assert.equal(after.tasks.get('task-1')?.terminalEpoch, before.tasks.get('task-1').terminalEpoch);
  assert.equal(after.dispatchTargets?.['lead-a'], 2, '派活分布必须恢复（否则集中度检测归零）');
  assert.equal(after.dispatchTargets?.['lead-b'], 1);
  assert.deepEqual(after.delegations, before.delegations);
});

test('7.12.0：恢复后 plan-stale 仍然能判（这正是本次要修的失效点）', () => {
  // 先造一个"清单落后于任务板"的账本
  const before = createSyncLedger();
  recordPlan(before, [{ content: '做 A', status: 'in_progress' }]);
  const planEpoch = before.plan.epoch;
  before.tasks = new Map([
    ['task-1', { id: 'task-1', status: 'completed', subject: 'a', ownerName: '', ready: true, blockedBy: [], ticketStatus: 'done', terminalEpoch: planEpoch + 1, changedAt: 1000 }],
  ]);
  before.epoch = planEpoch + 1;

  const after = createRestoredLedger(toSnapshot(before));
  const view = evaluateSync(after, { now: 2000 });
  const issue = view.issues.find((entry) => entry.code === 'plan-stale');
  assert.ok(issue, `重启后仍应报 plan-stale：${JSON.stringify(view.issues)}`);
});

test('7.12.0：坏快照一律静默退回默认值（绝不让模式起不来）', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { schema: 999 }, { schema: SNAPSHOT_SCHEMA, tasks: 'bad', plan: 5, dispatchTargets: [] }]) {
    const ledger = createSyncLedger();
    const applied = applySnapshot(ledger, bad);
    if (bad === null || bad === undefined || typeof bad !== 'object' || bad.schema !== SNAPSHOT_SCHEMA) {
      assert.equal(applied, false, `非法快照应返回 false：${JSON.stringify(bad)}`);
    }
    // 无论如何都不能抛、不能留下非法状态
    assert.equal(ledger.epoch, 0);
    assert.equal(ledger.plan, undefined);
    assert.equal(typeof ledger.tasks, 'undefined');
  }
});

test('7.12.0：快照有界——任务与派活目标超限会被裁剪', () => {
  const ledger = createSyncLedger();
  const tasks = new Map();
  for (let i = 0; i < MAX_SNAPSHOT_TASKS + 50; i += 1) {
    tasks.set(`task-${i}`, { id: `task-${i}`, status: 'pending', subject: '', ownerName: '', ready: true, blockedBy: [], ticketStatus: '', terminalEpoch: 0, changedAt: i });
  }
  ledger.tasks = tasks;
  for (let i = 0; i < MAX_SNAPSHOT_TARGETS + 20; i += 1) {
    recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', `lead-${i}`);
  }
  const snapshot = toSnapshot(ledger);
  assert.ok(snapshot.tasks.length <= MAX_SNAPSHOT_TASKS, `任务被裁到 ${snapshot.tasks.length}`);
  assert.ok(Object.keys(snapshot.dispatchTargets).length <= MAX_SNAPSHOT_TARGETS);
  // 裁剪保留"最近变化"的：changedAt 最大的必须在
  assert.ok(snapshot.tasks.some((task) => task.id === `task-${MAX_SNAPSHOT_TASKS + 49}`));
});

test('7.12.0：重复恢复是幂等的（取最大值，不会翻倍）', () => {
  const source = busyLedger();
  const snapshot = toSnapshot(source);
  const ledger = createRestoredLedger(snapshot);
  const first = { epoch: ledger.epoch, turns: ledger.turns, team: ledger.delegations.team };
  applySnapshot(ledger, snapshot); // 再恢复一次
  assert.equal(ledger.epoch, first.epoch);
  assert.equal(ledger.turns, first.turns);
  assert.equal(ledger.delegations.team, first.team, '通道计数取 max，不能累加');
  assert.equal(ledger.dispatchTargets['lead-a'], 2, '派活分布取 max，不能翻倍');
});

test('7.12.0：账本服务能真正存取快照（模拟一次宿主重启）', () => {
  // 这条覆盖 `agent.js` 真正走的路径：putSyncSnapshot → 落盘 → 新实例 load → getSyncSnapshot。
  // 用内存账本模拟落盘往返，避免碰真实文件。
  let state = emptyLedger();
  const makeLedger = () => {
    const service = new CommanderLedger({
      file: 'memory.json',
      load: () => ({ state }),
      save: (_file, next) => { state = JSON.parse(JSON.stringify(next)); },
    });
    service.load();
    return service;
  };

  const sync = createSyncLedger();
  recordPlan(sync, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]);
  for (let i = 0; i < 20; i += 1) recordTurn(sync);

  const before = makeLedger();
  before.putSyncSnapshot('session-x', toSnapshot(sync));
  assert.equal(state.syncSnapshots.length, 1, '快照应已落盘');

  // 模拟重启：从同一份 state 载入新实例
  const after = makeLedger();
  const restored = createRestoredLedger(after.getSyncSnapshot('session-x'));
  assert.equal(restored.turns, 20, '回合数应跨重启保留（长会话体检靠它）');
  assert.equal(restored.plan?.total, 2, '计划清单应跨重启保留');
  assert.equal(restored.plan?.openCount, 1);

  // 会话隔离：别的会话读不到
  assert.equal(after.getSyncSnapshot('session-y'), undefined);
});
