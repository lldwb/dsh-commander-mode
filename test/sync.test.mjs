/**
 * `lib/sync.js` 的单元测试。
 *
 * 这一组守的是「结算同步」的判定：**什么时候该说"你还没同步"，什么时候必须闭嘴**。
 * 两个方向都有代价：
 *
 * - 漏报 → 用户看到过期进度（2026-11-02 那次：清单停在 +61 分钟，任务板又完成了 4 个任务）；
 * - 误报 → 每回合多一次"去同步"的注入，模型白做一遍 `todo_write`，用户看到无意义的刷屏。
 *
 * 所以这里对**边界**格外认真：基线不算变化、认领不算结算、读不到不算未同步。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELEGATION_CHANNELS,
  OPEN_TASK_STATUSES,
  STALE_OPEN_GRACE_MS,
  SYNC_CONTEXT_NAME,
  SYNC_CONTEXT_ORDER,
  TERMINAL_TASK_STATUSES,
  buildSyncNudge,
  consumeStaleNudge,
  createSyncLedger,
  evaluateSync,
  isOpenTaskStatus,
  isOpenTodoStatus,
  isTerminalTaskStatus,
  recordBoard,
  recordDelegation,
  recordPlan,
  renderSyncBoard,
} from '../lib/sync.js';

/** 一行任务板 view（字段取自 `agentTeams.listTasks()` 的真实返回）。 */
function task(id, status, extra = {}) {
  return { id, revision: 1, subject: `任务 ${id}`, description: '', status, blockedBy: [], writeScopes: [], ready: false, writeScopeErrors: [], ...extra };
}

/**
 * 一行成员 view。
 *
 * 6.0.0（DSH 0.2.2-rc.2）：`agentTeams.listMembers()` 已移除，成员改由
 * `ctx.subagents.listDescendants(sessionId)` 快照读取（agent.js 缓存），形状是
 * `{ name, status }` —— `status` 只有 `running` / `inactive`，`role` 恒为 `member`、
 * 不再有 lead 行（Lead 是主会话，本来就不在成员里）。
 */
function member(name, status) {
  return { name, status, role: 'member', depth: 1 };
}

// ---------------------------------------------------------------- 常量 ---

test('状态集合与 DSH 的枚举一致', () => {
  // 任务板：pending / in_progress 是未结算；completed / deleted 是已结算
  //（`listTasks()` 不返回墓碑，删除靠"从视图消失"识别）。
  assert.deepEqual([...OPEN_TASK_STATUSES], ['pending', 'in_progress']);
  assert.deepEqual([...TERMINAL_TASK_STATUSES], ['completed', 'deleted']);
  assert.equal(isOpenTaskStatus('in_progress'), true);
  assert.equal(isTerminalTaskStatus('completed'), true);
  assert.equal(isTerminalTaskStatus('in_progress'), false);
  // 计划清单的状态枚举只有三个，没有 deleted。
  assert.equal(isOpenTodoStatus('pending'), true);
  assert.equal(isOpenTodoStatus('completed'), false);
  // 未知值既不算开也不算结算 —— 判定必须保守。
  assert.equal(isOpenTaskStatus('blocked'), false);
  assert.equal(isTerminalTaskStatus(undefined), false);
});

test('运行时上下文的落位在 team 身份（125）之后', () => {
  assert.equal(SYNC_CONTEXT_NAME, 'commander:sync-board');
  assert.equal(SYNC_CONTEXT_ORDER, 130);
});

// ---------------------------------------------------------------- 账本 ---

test('第一次观测只建基线：历史结算不算"未同步"', () => {
  const ledger = createSyncLedger();
  recordPlan(ledger, [{ content: '实现', status: 'in_progress' }]);
  const result = recordBoard(ledger, [task('task-1', 'completed'), task('task-2', 'pending')]);
  assert.equal(result.changed, false, '基线不该算变化');
  assert.equal(result.terminal, false);
  assert.deepEqual(evaluateSync(ledger).issues, []);
});

test('认领任务（pending → in_progress）不算结算，不要求同步清单', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'pending')]);
  recordPlan(ledger, [{ content: '实现', status: 'pending' }]);
  const result = recordBoard(ledger, [task('task-1', 'in_progress')]);
  assert.equal(result.changed, true);
  assert.equal(result.terminal, false);
  assert.deepEqual(evaluateSync(ledger).issues, []);
});

test('完成或删除任务才算结算，并要求计划清单同步', () => {
  for (const next of [[task('task-1', 'completed')], []]) {
    const ledger = createSyncLedger();
    recordBoard(ledger, [task('task-1', 'in_progress')]);
    recordPlan(ledger, [{ content: '实现', status: 'in_progress' }]);
    const result = recordBoard(ledger, next);
    assert.equal(result.terminal, true, `应有终态变化：${JSON.stringify(next)}`);
    const view = evaluateSync(ledger);
    assert.equal(view.issues[0]?.code, 'plan-stale');
    assert.deepEqual(view.issues[0].taskIds, ['task-1']);
  }
});

test('清单在结算之后更新 → 未同步项消失', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress')]);
  recordPlan(ledger, [{ content: '实现', status: 'in_progress' }]);
  recordBoard(ledger, [task('task-1', 'completed')]);
  assert.equal(evaluateSync(ledger).issues.length, 1);

  recordPlan(ledger, [{ content: '实现', status: 'completed' }]);
  assert.deepEqual(evaluateSync(ledger).issues, []);
});

test('清单说全做完、任务板还有未结算任务 → 反向不一致也要报', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'completed'), task('task-2', 'in_progress')]);
  recordPlan(ledger, [{ content: '实现', status: 'completed' }]);
  const view = evaluateSync(ledger);
  const codes = view.issues.map((issue) => issue.code);
  assert.ok(codes.includes('board-open-plan-closed'), JSON.stringify(view.issues));
});

test('任务板有结算项但从未写过清单 → plan-missing（弱提醒，不拦回合）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'completed')]);
  const view = evaluateSync(ledger);
  assert.equal(view.issues[0]?.code, 'plan-missing');
  // 但兜底提醒不该因为"没建清单"拦回合 —— 简单任务本来就不需要清单。
  assert.equal(buildSyncNudge(view), '');
});

test('读不到任何东西时是"未知"，不是"未同步"', () => {
  const ledger = createSyncLedger();
  assert.deepEqual(evaluateSync(ledger).issues, []);
  // 空数组也只是"板是空的"，不是未同步。
  recordBoard(ledger, []);
  assert.deepEqual(evaluateSync(ledger).issues, []);
});

test('非法入参一律宽容处理（不抛、不误报）', () => {
  const ledger = createSyncLedger();
  for (const bad of [undefined, null, 42, 'x', {}, [null], [{ id: '' }], [{ id: 42, status: 'completed' }]]) {
    assert.doesNotThrow(() => recordBoard(ledger, bad));
  }
  for (const bad of [undefined, null, 42, 'x', {}, [null], [{}, { content: '  ' }]]) {
    assert.doesNotThrow(() => recordPlan(ledger, bad));
  }
  assert.deepEqual(evaluateSync(ledger).issues, []);
});

// ---------------------------------------------------------------- 渲染 ---

test('没有任何可报内容时看板是空串（不产生每轮 token 成本）', () => {
  const ledger = createSyncLedger();
  assert.equal(renderSyncBoard(evaluateSync(ledger)), '');
  assert.equal(renderSyncBoard(undefined), '');
  assert.equal(renderSyncBoard(null, []), '');
});

test('看板给出结论而不是复述：几项已结算、谁还没结算、计划完成度', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [
    task('task-1', 'completed'),
    task('task-2', 'in_progress', { ownerName: 'browser-ops' }),
    task('task-3', 'pending'),
  ]);
  recordPlan(ledger, [
    { content: '实现', status: 'completed' },
    { content: '验收', status: 'in_progress' },
  ]);
  const text = renderSyncBoard(evaluateSync(ledger), [member('browser-ops', 'inactive')]);
  assert.ok(text.includes('任务板 1/3 已结算'), text);
  assert.ok(text.includes('task-2 in_progress（browser-ops）'), text);
  assert.ok(text.includes('计划清单 1/2 已完成'), text);
  assert.ok(text.includes('团队 1 人：browser-ops inactive'), text);
  // 没有未同步项时也提醒"状态以看板为准、不要轮询"。
  assert.ok(text.includes('不要用 list_agents'), text);
});

test('有未同步项时看板带 ⚠️ 与可直接执行的纠正指令', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress')]);
  recordPlan(ledger, [{ content: '实现', status: 'in_progress' }]);
  recordBoard(ledger, [task('task-1', 'completed')]);
  const text = renderSyncBoard(evaluateSync(ledger));
  assert.ok(text.includes('⚠️'), text);
  assert.ok(text.includes('todo_write'), text);
  assert.ok(text.includes('task-1'), text);
  assert.ok(text.includes('先'), '指令要给出先后顺序');
});

test('未结算任务很多时只点名前几个，其余给数量', () => {
  const ledger = createSyncLedger();
  const tasks = [];
  for (let index = 1; index <= 7; index += 1) tasks.push(task(`task-${index}`, 'in_progress'));
  recordBoard(ledger, tasks);
  const text = renderSyncBoard(evaluateSync(ledger));
  assert.ok(text.includes('task-1'), text);
  assert.ok(text.includes('未结算 7 项'), text);
});

test('兜底提醒点名任务与工具，并要求补充回执而不是重复报告', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress')]);
  recordPlan(ledger, [{ content: '实现', status: 'in_progress' }]);
  recordBoard(ledger, [task('task-1', 'completed')]);
  const nudge = buildSyncNudge(evaluateSync(ledger));
  assert.ok(nudge.includes('task-1'), nudge);
  assert.ok(nudge.includes('todo_write'), nudge);
  assert.ok(nudge.includes('不要重复刚才的报告'), nudge);
});

test('看板里成员状态读 `status`（真实快照字段），也容忍旧的 `phase`', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'completed')]);
  const view = evaluateSync(ledger);
  // 真实快照（`subagents.listDescendants`）只有 running / inactive 两态。
  assert.ok(renderSyncBoard(view, [member('browser-ops', 'inactive')]).includes('browser-ops inactive'));
  assert.ok(renderSyncBoard(view, [member('reviewer', 'running')]).includes('reviewer running'));
  // 容忍：team/member 事件的形状是 phase，手写夹具可能给这个。
  assert.ok(renderSyncBoard(view, [{ name: 'expert', role: 'member', phase: 'running' }]).includes('expert running'));
  // 两者都没有时给 unknown，而不是 undefined。
  assert.ok(renderSyncBoard(view, [{ name: 'x', role: 'member' }]).includes('x unknown'));
});

test('没有未同步项时兜底提醒是空串', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'completed')]);
  recordPlan(ledger, [{ content: '实现', status: 'completed' }]);
  assert.equal(buildSyncNudge(evaluateSync(ledger)), '');
});

// ------------------------------------------------------ 孤儿任务（0.5.0） ---

/** 宽限期之后的时间戳。 */
const LATER = STALE_OPEN_GRACE_MS + 60_000;

test('宽限期内的未认领任务不算孤儿（规划阶段一次建很多任务是常态）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-3', 'pending', { ready: true })], 0);
  const view = evaluateSync(ledger, { now: 60_000 }); // 1 分钟
  assert.ok(!view.issues.some((issue) => issue.code === 'board-stale-open'), JSON.stringify(view.issues));
});

test('超过宽限期仍无人认领的任务算孤儿，并点名到任务 id', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-3', 'pending', { ready: true }), task('task-4', 'pending', { ready: true })], 0);
  const view = evaluateSync(ledger, { now: LATER });
  const issue = view.issues.find((entry) => entry.code === 'board-stale-open');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('从未被认领'), issue.detail);
  assert.ok(issue.detail.includes('task-3'), issue.detail);
  // 兜底提醒要点名"建板必有主"的两个出路。
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('subagent'), nudge);
  assert.ok(nudge.includes('team_task_update'), nudge);
});

test('依赖未满足的 pending 任务不是孤儿（它在排队，不是没人管）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-9', 'pending', { ready: false, blockedBy: ['task-8'] })], 0);
  const view = evaluateSync(ledger, { now: LATER });
  assert.ok(!view.issues.some((issue) => issue.code === 'board-stale-open'));
});

test('主人在跑的任务不算孤儿；主人已 inactive 才算', () => {
  const tasks = [task('task-5', 'in_progress', { ownerName: 'ledger-builder' })];
  const ledger = createSyncLedger();
  recordBoard(ledger, tasks, 0);

  const running = evaluateSync(ledger, { members: [member('ledger-builder', 'running')], now: LATER });
  assert.ok(!running.issues.some((issue) => issue.code === 'board-stale-open'));

  const idle = evaluateSync(ledger, { members: [member('ledger-builder', 'inactive')], now: LATER });
  const issue = idle.issues.find((entry) => entry.code === 'board-stale-open');
  assert.ok(issue, JSON.stringify(idle.issues));
  assert.ok(issue.detail.includes('ledger-builder'), issue.detail);
  assert.ok(issue.detail.includes('已停手'), issue.detail);
});

test('任务在宽限期内动过就不算孤儿（changedAt 会刷新）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-5', 'pending', { ready: true })], 0);
  // 第 9 分钟认领 → 刷新 changedAt
  recordBoard(ledger, [task('task-5', 'in_progress', { ownerName: 'x' })], STALE_OPEN_GRACE_MS - 60_000);
  const view = evaluateSync(ledger, { members: [member('x', 'running')], now: STALE_OPEN_GRACE_MS + 60_000 });
  assert.ok(!view.issues.some((issue) => issue.code === 'board-stale-open'));
});

test('孤儿任务被结算后问题消失', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-3', 'pending', { ready: true })], 0);
  assert.ok(evaluateSync(ledger, { now: LATER }).issues.some((issue) => issue.code === 'board-stale-open'));
  recordBoard(ledger, [task('task-3', 'completed')], LATER);
  assert.ok(!evaluateSync(ledger, { now: LATER + 1000 }).issues.some((issue) => issue.code === 'board-stale-open'));
});

test('孤儿任务兜底默认包含，可用 includeStale:false 降级为看板常驻', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-3', 'pending', { ready: true })], 0);
  const view = evaluateSync(ledger, { now: LATER });
  assert.ok(buildSyncNudge(view).includes('孤儿任务'));
  assert.equal(buildSyncNudge(view, { includeStale: false }), '');
});

// ------------------------------------------------------ 团队闲置（0.5.0） ---

test('最近三次派活全走一次性 specialist、且任务板还开着 → 报团队闲置', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-14', 'pending', { ready: true })], 0);
  for (const name of ['subagent_implementer', 'subagent_implementer', 'subagent_implementer']) {
    recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, name);
  }
  const view = evaluateSync(ledger, { now: 60_000 });
  const issue = view.issues.find((entry) => entry.code === 'channel-drift');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('一次性 specialist'), issue.detail);
  assert.ok(issue.detail.includes('task-14'), issue.detail);
  // 提示要给出正确出路：Team 通道。
  assert.ok(renderSyncBoard(view).includes('subagent'));
});

test('团队通道有派活 / 任务板已清空 / 次数不够 → 都不报团队闲置', () => {
  const cases = [
    // 混了 Team 派发
    (ledger) => {
      recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
      recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message');
      recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
      recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
    },
    // 只有两次
    (ledger) => {
      recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
      recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
    },
  ];
  for (const arrange of cases) {
    const ledger = createSyncLedger();
    recordBoard(ledger, [task('task-14', 'pending', { ready: true })], 0);
    arrange(ledger);
    assert.ok(!evaluateSync(ledger, { now: 60_000 }).issues.some((issue) => issue.code === 'channel-drift'));
  }
  // 任务板没有未结算任务 → 通道怎么用都无所谓。
  const settled = createSyncLedger();
  recordBoard(settled, [task('task-1', 'completed')], 0);
  for (let index = 0; index < 3; index += 1) recordDelegation(settled, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
  assert.ok(!evaluateSync(settled, { now: 60_000 }).issues.some((issue) => issue.code === 'channel-drift'));
});

test('团队闲置不拦回合（只在看板里常驻提醒）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-14', 'pending', { ready: true })], 0);
  for (let index = 0; index < 3; index += 1) recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
  // 60 秒内没有孤儿任务、也没有计划清单，因此不该注入兜底。
  assert.equal(buildSyncNudge(evaluateSync(ledger, { now: 60_000 })), '');
});

test('派发计数与最近序列：只收两种通道，序列有上限', () => {
  const ledger = createSyncLedger();
  recordDelegation(ledger, 'bogus', 'x'); // 非法类别忽略
  for (let index = 0; index < 12; index += 1) {
    recordDelegation(ledger, index % 2 === 0 ? DELEGATION_CHANNELS.TEAM : DELEGATION_CHANNELS.ONE_SHOT, 't');
  }
  assert.equal(ledger.delegations.team, 6);
  assert.equal(ledger.delegations.oneShot, 6);
  assert.equal(ledger.recentDelegations.length, 8);
  // 非法入参不炸。
  assert.doesNotThrow(() => recordDelegation(null, DELEGATION_CHANNELS.TEAM));
  assert.doesNotThrow(() => recordDelegation({}, DELEGATION_CHANNELS.TEAM));
});

test('看板给出派发通道配比；没有成员时点名"重启不会自动复活"', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-14', 'pending', { ready: true })], 0);
  recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message');
  recordDelegation(ledger, DELEGATION_CHANNELS.ONE_SHOT, 'subagent_implementer');
  const text = renderSyncBoard(evaluateSync(ledger, { now: 60_000 }), []);
  assert.ok(text.includes('派发通道：Team 1 次 / 一次性 specialist 1 次'), text);
  // 6.0.0：成员就是可续做的标准 subagent / 小组长，所以看板文案是「无小组长」。
  assert.ok(text.includes('无小组长'), text);
  assert.ok(text.includes('subagent'), text);
});

test('孤儿任务每条会话只强提醒一次，之后降级为看板常驻', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-3', 'pending', { ready: true })], 0);
  const view = evaluateSync(ledger, { now: LATER });
  assert.equal(consumeStaleNudge(ledger, view), true, '第一次应强制提醒');
  assert.equal(ledger.staleNudged, true);
  // 第二次：纳入提醒的选项关掉，但看板里仍然能看到孤儿任务。
  assert.equal(consumeStaleNudge(ledger, view), false);
  assert.ok(renderSyncBoard(view).includes('孤儿任务'));
  // 没有孤儿任务时不会误置标志。
  const clean = createSyncLedger();
  assert.equal(consumeStaleNudge(clean, evaluateSync(clean, { now: LATER })), true);
  assert.equal(clean.staleNudged, false);
  // 异常入参不炸。
  assert.equal(consumeStaleNudge(null, undefined), true);
});
