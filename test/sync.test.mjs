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
  TICKET_BACKLOG_LIMIT,
  LONG_SESSION_EVERY,
  recordTurn,
  renderLongSessionCheck,
  TERMINAL_TASK_STATUSES,
  buildSyncNudge,
  consumeStaleNudge,
  createSyncLedger,
  evaluateSync,
  isOpenTaskStatus,
  isOpenTodoStatus,
  isTerminalTaskStatus,
  parseTicketStatusMarker,
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

// ------------------------------------------------ 全员 idle 但还有活（7.6.0） ---

test('7.6.0：还有未结算任务 + 团队全员 inactive → 报 all-idle-stalled', () => {
  // 现场 session-1d8c8c60（2026-11-16 11:00）：任务板 8 项进行中、团队 20 人全部 inactive，
  // 指挥者在报告里写「还剩 4 项切图判据」然后结束回合去等通知——而没有在飞的下级就永远
  // 不会产生通知，于是静默到用户来问「进度如何？」。
  const ledger = createSyncLedger();
  recordBoard(ledger, [
    task('task-13', 'in_progress', { ownerName: 'slice-quality-lead' }),
    task('task-14', 'pending', { ready: true }),
  ], 0);
  const view = evaluateSync(ledger, {
    members: [member('slice-quality-lead', 'inactive'), member('installer-lead', 'inactive')],
    now: 60_000,
  });
  const issue = view.issues.find((entry) => entry.code === 'all-idle-stalled');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('2 项未结算'), issue.detail);
  assert.ok(issue.detail.includes('全部 inactive'), issue.detail);
  assert.ok(issue.detail.includes('task-13'), issue.detail);
});

test('7.6.0：有成员在跑时不报（通知链还在工作）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-13', 'in_progress', { ownerName: 'a' })], 0);
  const view = evaluateSync(ledger, {
    members: [member('a', 'inactive'), member('b', 'running')],
    now: 60_000,
  });
  assert.ok(!view.issues.some((entry) => entry.code === 'all-idle-stalled'), JSON.stringify(view.issues));
});

test('7.6.0：没有未结算任务 / 没有团队成员时不报', () => {
  const settled = createSyncLedger();
  recordBoard(settled, [task('task-1', 'completed')], 0);
  assert.ok(!evaluateSync(settled, { members: [member('a', 'inactive')], now: 60_000 })
    .issues.some((entry) => entry.code === 'all-idle-stalled'));

  const noTeam = createSyncLedger();
  recordBoard(noTeam, [task('task-2', 'pending', { ready: true })], 0);
  assert.ok(!evaluateSync(noTeam, { members: [], now: 60_000 })
    .issues.some((entry) => entry.code === 'all-idle-stalled'));
});

test('7.6.0：兜底提醒要说清"不会有通知"并给出继续派的动作', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-13', 'in_progress', { ownerName: 'a' })], 0);
  const view = evaluateSync(ledger, { members: [member('a', 'inactive')], now: 60_000 });
  const nudge = buildSyncNudge(view);
  // 关键：让模型明白"等通知"这条路已经不存在了
  assert.ok(nudge.includes('不会再有通知'), nudge);
  assert.ok(nudge.includes('send_message'), nudge);
  assert.ok(nudge.includes('subagent'), nudge);
  // 看板每轮都要能看见这条（不是只在兜底里）
  const board = renderSyncBoard(view, [member('a', 'inactive')]);
  assert.ok(board.includes('全部 inactive'), board);
});

test('7.6.0：在等用户的工单（waiting / blocked）不算"可推进"，不误报', () => {
  // 任务板只有 4 个状态：工单的 waiting / blocked 在板上同样是 in_progress，
  // 真实状态在描述 marker `[commander:status=...]` 里。不排除的话，指挥官合理地
  // 等用户拍板时会被反复催着继续派活——那是误报，会把正常收尾卡死。
  for (const ticketStatus of ['waiting', 'blocked']) {
    const ledger = createSyncLedger();
    recordBoard(ledger, [{
      ...task('task-20', 'in_progress', { ownerName: 'a' }),
      description: `[commander:ticket=t-400]\n[commander:channel=team]\n[commander:status=${ticketStatus}]`,
    }], 0);
    const view = evaluateSync(ledger, { members: [member('a', 'inactive')], now: 60_000 });
    assert.ok(
      !view.issues.some((entry) => entry.code === 'all-idle-stalled'),
      `${ticketStatus} 不该报 all-idle-stalled：${JSON.stringify(view.issues)}`,
    );
    assert.equal(buildSyncNudge(view), '', `${ticketStatus} 不该拦回合`);
  }
});

test('7.6.0：同一个板上既有"等用户"又有"可推进"时，只点名可推进的那几项', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [
    { ...task('task-1', 'in_progress', { ownerName: 'a' }), description: '[commander:status=waiting]' },
    { ...task('task-2', 'in_progress', { ownerName: 'a' }), description: '[commander:status=blocked]' },
    task('task-3', 'in_progress', { ownerName: 'a' }),
  ], 0);
  const view = evaluateSync(ledger, { members: [member('a', 'inactive')], now: 60_000 });
  const issue = view.issues.find((entry) => entry.code === 'all-idle-stalled');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('task-3'), issue.detail);
  assert.ok(!issue.detail.includes('task-1'), issue.detail);
  assert.ok(!issue.detail.includes('task-2'), issue.detail);
  assert.ok(issue.detail.includes('1 项未结算'), issue.detail);
});

test('7.6.0：解析 marker 的边界（无描述 / 无 marker / 大小写）', () => {
  assert.equal(parseTicketStatusMarker(undefined), '');
  assert.equal(parseTicketStatusMarker(''), '');
  assert.equal(parseTicketStatusMarker('没有 marker 的描述'), '');
  assert.equal(parseTicketStatusMarker('[commander:status=WAITING]'), 'waiting');
  assert.equal(parseTicketStatusMarker('[commander:ticket=t-1]\n[commander:status=progress]'), 'progress');
});

test('7.11.0：早已完工且 inactive 的小组长不该被翻旧账（本次修的误报）', () => {
  // 现场：9 位小组长里 7 位早已完工、inactive，第一版仍点名"在独干"，
  // 那条警告**永远无法消除**（历史改不了），实测刷了 98 次，指挥官每回合都要解释一遍
  // "已完结的单点任务，无需再拆"——这是警告疲劳的来源，比不报更糟。
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'rollback-lead' })], 0);
  const members = [];
  for (const n of ['slice-quality-lead', 'installer-lead', 'ui-progress-lead', 'slice-final-lead']) {
    members.push({ name: n, status: 'inactive', role: 'member', depth: 1 }); // 早已完工
  }
  members.push({ name: 'rollback-lead', status: 'running', role: 'member', depth: 1 });
  // 团队会扇出：rollback-lead 自己有下级
  members.push({ name: 'rollback-lead/fix-a', status: 'running', role: 'member', depth: 2 });

  const view = evaluateSync(ledger, { members, now: 60_000 });
  assert.ok(!view.issues.some((e) => e.code === 'fan-out-unused'), JSON.stringify(view.issues));
});

test('7.7.0：正在干活的小组长零下级 → 仍然要报（真阳性不能修没）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'b' })], 0);
  const members = [
    { name: 'a', status: 'running', role: 'member', depth: 1 },   // 在跑，零下级
    { name: 'b', status: 'inactive', role: 'member', depth: 1 },
    { name: 'b/fix-a', status: 'inactive', role: 'member', depth: 2 }, // 团队确实在扇出
  ];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  const issue = view.issues.find((e) => e.code === 'fan-out-unused');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('正在干活'), issue.detail);
  assert.ok(issue.detail.includes('a'), issue.detail);
});

// ------------------------------------------------ 工单积压（7.9.0） ---

test('7.9.0：同时开着超过上限的未结算项 → 报 ticket-backlog（先收口）', () => {
  // 现场 session-1d8c8c60：26.6 小时开了 14 张工单，尾声仍有 8 项进行中、只结算 6 张，
  // 一直没形成交付闭环。积压本身会让"做完了没有"永远说不清。
  const ledger = createSyncLedger();
  const tasks = [];
  for (let i = 1; i <= TICKET_BACKLOG_LIMIT + 2; i += 1) {
    tasks.push(task(`task-${i}`, 'in_progress', { ownerName: 'a' }));
  }
  recordBoard(ledger, tasks, 0);
  const view = evaluateSync(ledger, { members: [member('a', 'running')], now: 60_000 });
  const issue = view.issues.find((entry) => entry.code === 'ticket-backlog');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('项未结算'), issue.detail);
  // 兜底要给出"先收口"的动作
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('先收口'), nudge);
});

test('7.9.0：积压不超过上限时不报；等用户的项不计入积压', () => {
  const ok = createSyncLedger();
  recordBoard(ok, Array.from({ length: TICKET_BACKLOG_LIMIT }, (_, i) => task(`task-${i + 1}`, 'in_progress', { ownerName: 'a' })), 0);
  assert.ok(!evaluateSync(ok, { members: [member('a', 'running')], now: 60_000 })
    .issues.some((e) => e.code === 'ticket-backlog'));

  // 6 项可推进 + 3 项"等用户" → 不计入，不该报
  const waiting = createSyncLedger();
  const rows = Array.from({ length: TICKET_BACKLOG_LIMIT }, (_, i) => task(`task-${i + 1}`, 'in_progress', { ownerName: 'a' }));
  for (let i = 0; i < 3; i += 1) {
    rows.push({ ...task(`task-w${i}`, 'in_progress', { ownerName: 'a' }), description: '[commander:status=waiting]' });
  }
  recordBoard(waiting, rows, 0);
  assert.ok(!evaluateSync(waiting, { members: [member('a', 'running')], now: 60_000 })
    .issues.some((e) => e.code === 'ticket-backlog'), '等用户的项不该计入积压');
});

// ------------------------------------------ 派活过度集中（7.10.0） ---

test('7.10.0：派活过度集中（26 小时全推同一个小队长）→ 报 dispatch-focus', () => {
  // 现场 session-1d8c8c60：send_message 分布 47 / 9 / 1 / 0 —— 一个小组长吃掉 82%，
  // 另一个几乎没被用过。不是报错，是把并行做成了串行。
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'slice-quality-lead' })], 0);
  for (let i = 0; i < 47; i += 1) recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'slice-quality-lead');
  for (let i = 0; i < 9; i += 1) recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'slice-final-lead');
  recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'installer-lead');

  const view = evaluateSync(ledger, { members: [member('slice-quality-lead', 'running')], now: 60_000 });
  const issue = view.issues.find((entry) => entry.code === 'dispatch-focus');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('47'), issue.detail);
  assert.ok(issue.detail.includes('slice-quality-lead'), issue.detail);
  // 兜底要给出"换团队 / 扇出"的动作
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('换团队'), nudge);
});

test('7.10.0：派活均匀 / 总量太少 / 只有一个目标时不报', () => {
  // 均匀分布
  const even = createSyncLedger();
  recordBoard(even, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  for (let i = 0; i < 5; i += 1) recordDelegation(even, DELEGATION_CHANNELS.TEAM, 'send_message', 'a');
  for (let i = 0; i < 5; i += 1) recordDelegation(even, DELEGATION_CHANNELS.TEAM, 'send_message', 'b');
  assert.ok(!evaluateSync(even, { members: [member('a', 'running')], now: 60_000 })
    .issues.some((e) => e.code === 'dispatch-focus'), '50/50 不该报');

  // 总量不足 10 次
  const few = createSyncLedger();
  recordBoard(few, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  for (let i = 0; i < 8; i += 1) recordDelegation(few, DELEGATION_CHANNELS.TEAM, 'send_message', 'a');
  recordDelegation(few, DELEGATION_CHANNELS.TEAM, 'send_message', 'b');
  assert.ok(!evaluateSync(few, { members: [member('a', 'running')], now: 60_000 })
    .issues.some((e) => e.code === 'dispatch-focus'), '不足 10 次不判');

  // 只有一个目标（确实只有一个合适的人）
  const solo = createSyncLedger();
  recordBoard(solo, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  for (let i = 0; i < 20; i += 1) recordDelegation(solo, DELEGATION_CHANNELS.TEAM, 'send_message', 'a');
  assert.ok(!evaluateSync(solo, { members: [member('a', 'running')], now: 60_000 })
    .issues.some((e) => e.code === 'dispatch-focus'), '只有一个人时不判');
});

test('7.10.0：没有目标名的派活不污染分布统计', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  for (let i = 0; i < 12; i += 1) recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'team_task_create');
  assert.equal(ledger.dispatchTargets, undefined, '空目标不应写入分布');
});

// ---------------------------------------- 长会话退化体检（7.10.0） ---

test('7.10.0：每 N 回合给一次长会话体检，且带当前实测信号', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  const view = evaluateSync(ledger, { members: [member('a', 'running')], now: 60_000 });

  // 不到点：空
  assert.equal(renderLongSessionCheck(ledger, view), '');
  for (let i = 0; i < LONG_SESSION_EVERY - 1; i += 1) recordTurn(ledger);
  assert.equal(renderLongSessionCheck(ledger, view), '', '第 14 回合还不体检');

  // 到点：四问全在
  recordTurn(ledger);
  const text = renderLongSessionCheck(ledger, view);
  assert.ok(text.includes('长会话体检'), text);
  assert.ok(text.includes(`${LONG_SESSION_EVERY} 回合`), text);
  for (const phrase of ['并行有没有变成串行', '只开不收', '重复同一个纠正', '小组长是不是在独干']) {
    assert.ok(text.includes(phrase), `体检缺一问：${phrase}`);
  }

  // 下一个周期再给一次；中间回合不给
  recordTurn(ledger);
  assert.equal(renderLongSessionCheck(ledger, view), '');
  for (let i = 0; i < LONG_SESSION_EVERY - 1; i += 1) recordTurn(ledger);
  assert.ok(renderLongSessionCheck(ledger, view).includes('长会话体检'));
});

test('7.10.0：体检会把已检测到的信号一并列出（有才列，不编）', () => {
  const ledger = createSyncLedger();
  // 造出"派活过度集中"信号
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  for (let i = 0; i < 20; i += 1) recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'a');
  for (let i = 0; i < 5; i += 1) recordDelegation(ledger, DELEGATION_CHANNELS.TEAM, 'send_message', 'b');
  const view = evaluateSync(ledger, { members: [member('a', 'running')], now: 60_000 });
  for (let i = 0; i < LONG_SESSION_EVERY; i += 1) recordTurn(ledger);
  const text = renderLongSessionCheck(ledger, view);
  assert.ok(text.includes('派活过度集中'), text);
  assert.ok(text.includes('先修'), text);
});

// ------------------------------------------ 并行度不足（7.14.0） ---

test('7.14.0：还有 ≥2 项可推进、却只有 ≤1 位小组长在跑 → 报 parallel-underused', () => {
  // 实测 session-1d8c8c60：小组长层并发均值 0.58、55.2% 采样点无人；并行上升 45 次里 78%
  // 紧跟用户消息（随机基线 32.5%），用户消息后 10 分钟内有派发 94%——并行几乎全靠用户点火。
  const ledger = createSyncLedger();
  recordBoard(ledger, [
    task('task-1', 'in_progress', { ownerName: 'a' }),
    task('task-2', 'in_progress', { ownerName: 'b' }),
    task('task-3', 'pending', { ready: true }),
  ], 0);
  const members = [
    { name: 'a', status: 'running', role: 'member', depth: 1 },   // 只有 1 个在跑
    { name: 'b', status: 'inactive', role: 'member', depth: 1 },
    { name: 'c', status: 'inactive', role: 'member', depth: 1 },
  ];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  const issue = view.issues.find((e) => e.code === 'parallel-underused');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('3 项可推进'), issue.detail);
  assert.ok(issue.detail.includes('只有 1 位'), issue.detail);
  assert.ok(issue.detail.includes('团队共 3 位'), issue.detail);

  // 兜底要给出"现在多开几条"的动作与上限说明
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('多开几条'), nudge);
  assert.ok(nudge.includes('maxActiveSubagents'), nudge);
});

test('7.14.0：已经并行起来（≥2 位在跑）→ 告警消失（必须可被行动消除）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [
    task('task-1', 'in_progress', { ownerName: 'a' }),
    task('task-2', 'in_progress', { ownerName: 'b' }),
  ], 0);
  const members = [
    { name: 'a', status: 'running', role: 'member', depth: 1 },
    { name: 'b', status: 'running', role: 'member', depth: 1 },
  ];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  assert.ok(!view.issues.some((e) => e.code === 'parallel-underused'), JSON.stringify(view.issues));
});

test('7.14.0：只有一个小组长 / 只有 1 项可推进 / 全在等用户 → 不报', () => {
  // 团队只有 1 位小组长：无从并行，该走"补人"而不是"并行"
  const solo = createSyncLedger();
  recordBoard(solo, [task('task-1', 'in_progress', { ownerName: 'a' }), task('task-2', 'pending', { ready: true })], 0);
  assert.ok(!evaluateSync(solo, {
    members: [{ name: 'a', status: 'running', role: 'member', depth: 1 }], now: 60_000,
  }).issues.some((e) => e.code === 'parallel-underused'));

  // 只有 1 项可推进：没有第二条可并行
  const one = createSyncLedger();
  recordBoard(one, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  assert.ok(!evaluateSync(one, {
    members: [
      { name: 'a', status: 'running', role: 'member', depth: 1 },
      { name: 'b', status: 'inactive', role: 'member', depth: 1 },
    ], now: 60_000,
  }).issues.some((e) => e.code === 'parallel-underused'));

  // 剩下的都在等用户：不算"可推进"
  const waiting = createSyncLedger();
  recordBoard(waiting, [
    task('task-1', 'in_progress', { ownerName: 'a' }),
    { ...task('task-2', 'in_progress', { ownerName: 'b' }), description: '[commander:status=waiting]' },
    { ...task('task-3', 'in_progress', { ownerName: 'b' }), description: '[commander:status=blocked]' },
  ], 0);
  assert.ok(!evaluateSync(waiting, {
    members: [
      { name: 'a', status: 'running', role: 'member', depth: 1 },
      { name: 'b', status: 'inactive', role: 'member', depth: 1 },
    ], now: 60_000,
  }).issues.some((e) => e.code === 'parallel-underused'), '等用户的项不该算可推进');
});

// -------------------------------------------- 小组长独干（7.7.0） ---

test('7.7.0：有下级在工作、但所有小组长都没派下级 → 报 fan-out-unused', () => {
  // 现场 session-1d8c8c60：4 位小组长里 3 位一个子智能体都没派，全程自己串行做。
  // 判据只在"团队里确实已经有子智能体"时才成立（否则小团队单打独斗是正常的）。
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'installer-lead' })], 0);
  const members = [
    { name: 'installer-lead', status: 'running', role: 'member', depth: 1 },
    { name: 'ui-progress-lead', status: 'inactive', role: 'member', depth: 1 },
    // 子智能体挂在第三个小组长下（说明这个团队确实会扇出）
    { name: 'slice-lead/fix-a', status: 'inactive', role: 'member', depth: 2 },
  ];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  const issue = view.issues.find((entry) => entry.code === 'fan-out-unused');
  assert.ok(issue, JSON.stringify(view.issues));
  assert.ok(issue.detail.includes('一个下级都没派'), issue.detail);
  assert.ok(issue.detail.includes('installer-lead'), issue.detail);
  // 兜底要给出"先拆再干"的动作
  const nudge = buildSyncNudge(view);
  assert.ok(nudge.includes('先拆再干'), nudge);
  assert.ok(nudge.includes('subagent'), nudge);
});

test('7.7.0：小组长真在扇出时不报（哪怕只有一位）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  const members = [
    { name: 'a', status: 'running', role: 'member', depth: 1 },
    { name: 'a/fix-1', status: 'running', role: 'member', depth: 2 },
  ];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  assert.ok(!view.issues.some((entry) => entry.code === 'fan-out-unused'), JSON.stringify(view.issues));
});

test('7.7.0：团队里根本没有子智能体时不报（小团队单干正常）', () => {
  const ledger = createSyncLedger();
  recordBoard(ledger, [task('task-1', 'in_progress', { ownerName: 'a' })], 0);
  const members = [{ name: 'a', status: 'running', role: 'member', depth: 1 }];
  const view = evaluateSync(ledger, { members, now: 60_000 });
  assert.ok(!view.issues.some((entry) => entry.code === 'fan-out-unused'), JSON.stringify(view.issues));
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
