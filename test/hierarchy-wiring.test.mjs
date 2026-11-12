/**
 * 三层指挥链门禁的**接线**测试（真实 `apply()` + `tools/pre-execute` 监听器）。
 *
 * 纯函数测试（`test/guard-hierarchy.test.mjs`）只能证明"判定对了"，证明不了：
 *
 * 1. 判定真的被**注册**在 `tools/pre-execute` 上（漏接线 = 规则没落地，纯函数全绿也没用）；
 * 2. **顺序**是对的（层级门禁排在 0.6.0 的 Mandate/工单派发门禁**之前**，所以指挥官直调
 *    `subagent_<id>` 拿到的是层级理由，而不是 Mandate 理由）；
 * 3. 开关 `delegationHierarchy: false` 真的能关掉（回退 2.x 只靠协议）；
 * 4. （5.0.0 起只有一个模式行 `agent.js`；原先的 `project-manager.js` 已并入。）
 *
 * 用 `test/helpers.mjs` 的假 ctx：它复现了 Cordis 的 `inject` 语义与
 * "依赖缺一个就不执行"的行为。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply as applyCommander } from '../agent.js';
import { LEAD, SUBAGENT, TEAMMATE, defaultRoster, flush, listenerOf, makeCtx, makeSettings, spyNext } from './helpers.mjs';

/**
 * 启动模式行，返回 `tools/pre-execute` 监听器与记录。
 *
 * @param {Function} apply - `agent.js` 的 `apply`。
 * @param {{ options?: object, specialists?: object[], ledger?: object }} [initial] - 配置与可选账本。
 * @returns {{ listener: Function, record: object, settings: object }} 监听器与记录。
 */
function boot(apply, initial = {}) {
  const settings = makeSettings({ options: initial.options, specialists: initial.specialists ?? defaultRoster() });
  const made = makeCtx({ settings });
  if (initial.ledger !== undefined) {
    // 账本服务不在 helpers 的默认服务集里：用 ctx.get 的包装注入（必须在 apply 之前，
    // 因为 apply 内部的 ctx.inject 会在调用时捕获 ctx.get）。
    const baseGet = made.ctx.get;
    made.ctx.get = (name) => (name === 'commanderLedger' ? initial.ledger : baseGet(name));
  }
  apply(made.ctx);
  return { listener: listenerOf(made.record, 'tools/pre-execute'), record: made.record, settings };
}

/** 跑一次 pre-execute，返回决策。 */
async function decide(listener, name, agent, args) {
  const { next, calls } = spyNext({ kind: 'allow' });
  const decision = await listener({ name, agent, arguments: args }, next);
  return { decision, nextCalls: calls.count };
}

/** 断言被拒，并返回理由。 */
function assertDenied(result, label) {
  assert.ok(result.decision !== undefined, `${label} 应当被拒绝`);
  assert.equal(result.decision.kind, 'deny');
  assert.equal(result.nextCalls, 0, '拒绝时不该调用 next');
  assert.ok(result.decision.reason.length > 0, '拒绝理由不能为空');
  return result.decision.reason;
}

/** 断言放行（放行必须走 next，不能自己返回 allow）。 */
function assertAllowed(result, label) {
  assert.deepEqual(result.decision, { kind: 'allow' }, `${label} 应当放行`);
  assert.equal(result.nextCalls, 1, '放行时必须调用 next（否则会短路后面的监听器）');
}

// ------------------------------------------------ 指挥者模式行（agent.js） ---

test('指挥者模式：Lead 改任务板进展被拒、reassign/edit/delete 放行', async () => {
  const { listener } = boot(applyCommander);

  for (const action of ['claim', 'release', 'complete', 'reopen', 'set_dependencies']) {
    const reason = assertDenied(
      await decide(listener, 'team_task_update', LEAD, { action, task_id: 'task-1' }),
      `Lead 的 team_task_update ${action}`,
    );
    assert.ok(reason.includes('小组长'), `${action} 的拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('reassign'), `${action} 的拒因应给出 reassign 出路：${reason}`);
  }

  for (const action of ['reassign', 'edit', 'delete']) {
    assertAllowed(
      await decide(listener, 'team_task_update', LEAD, { action }),
      `Lead 的 team_task_update ${action}`,
    );
  }
});

test('指挥者模式：Lead 改工单推进状态被拒、done/cancelled 放行', async () => {
  const { listener } = boot(applyCommander);

  for (const status of ['progress', 'waiting', 'ready', 'blocked', 'failed']) {
    const reason = assertDenied(
      await decide(listener, 'commander_ticket_update', LEAD, { ticket: 't-1', status }),
      `Lead 的 commander_ticket_update ${status}`,
    );
    assert.ok(reason.includes('小组长'), `${status} 的拒因应点名小组长：${reason}`);
  }

  for (const status of ['done', 'cancelled']) {
    assertAllowed(
      await decide(listener, 'commander_ticket_update', LEAD, { ticket: 't-1', status }),
      `Lead 的 commander_ticket_update ${status}`,
    );
  }
  // 只改描述字段（没有 status）也放行。
  assertAllowed(
    await decide(listener, 'commander_ticket_update', LEAD, { ticket: 't-1', acceptance: '新判据' }),
    'Lead 只改 acceptance',
  );
});

test('指挥者模式：Lead 直接派一次性专家被拒，workflow / Team 通道放行', async () => {
  const { listener } = boot(applyCommander);

  // 6.0.0：被拦的只剩**名册生成的一次性专家工具**（`subagent_<id>`）。`subagent` /
  // `subagent_fork` 是建小组长的 Team 通道（旧 Team 的 `spawn_teammate` 已随 rc.2 移除），
  // 对指挥官放行 —— 它们不再算"一次性专家工具"。
  for (const name of ['subagent_architect', 'subagent_implementer']) {
    const reason = assertDenied(
      await decide(listener, name, LEAD, { task: '实现 X' }),
      `Lead 调 ${name}`,
    );
    assert.ok(reason.includes('小组长'), `${name} 的拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('subagent'), `${name} 的拒因应给出 subagent 出路：${reason}`);
    // 拒因可以**泛指** `subagent_<id>`（"由小组长使用，你不要调用"），但不能教它去调具体工具。
    assert.ok(!reason.includes(`2) 用 \`${name}\``), `${name} 的拒因不应教直调：${reason}`);
  }

  // workflow 是编排通道；Team 通道（建小组长 / 续做 / 建板 / 读板）本来就是指挥官该用的。
  for (const name of ['workflow', 'subagent', 'send_message', 'team_task_create', 'team_task_list']) {
    assertAllowed(await decide(listener, name, LEAD, {}), `Lead 调 ${name}`);
  }

  // `subagent_fork` 也是 Team 建人工具，6.0.0 语义下必须放行。
  // （lib/guard.js 的 `isSpecialistDispatchTool()` 曾用 /^subagent_[a-z0-9_-]+$/ 只按前缀判定，
  // 会把 `subagent_fork` 误当成名册生成的一次性专家工具；已在 lib 侧修正为先排除两个标准
  // Team 工具名。这里钉住修复后的语义：指挥官可以用 `subagent_fork` 建小组长。）
  assertAllowed(await decide(listener, 'subagent_fork', LEAD, {}), 'Lead 调 subagent_fork（Team 建人通道）');
});

test('指挥者模式：teammate（小组长）三条门禁全部放行（否则没人能干活）', async () => {
  const { listener } = boot(applyCommander);

  for (const [name, args] of [
    ['team_task_update', { action: 'claim', task_id: 'task-1' }],
    ['team_task_update', { action: 'complete', task_id: 'task-1' }],
    ['team_task_update', { action: 'set_dependencies', task_id: 'task-1' }],
    ['commander_ticket_update', { ticket: 't-1', status: 'progress' }],
    ['commander_ticket_update', { ticket: 't-1', status: 'failed' }],
    ['subagent_architect', { task: '子任务' }],
    ['subagent', { task: '子任务' }],
    ['workflow', {}],
  ]) {
    assertAllowed(await decide(listener, name, TEAMMATE, args), `teammate 的 ${name}`);
  }
});

test('指挥者模式：delegationHierarchy:false 时三条门禁全部放行（回退 2.x 只靠协议）', async () => {
  const { listener } = boot(applyCommander, { options: { delegationHierarchy: false } });

  for (const [name, args] of [
    ['team_task_update', { action: 'claim' }],
    ['team_task_update', { action: 'complete' }],
    ['commander_ticket_update', { ticket: 't-1', status: 'progress' }],
    ['subagent_architect', { task: 'x' }],
    ['subagent_fork', { task: 'x' }],
  ]) {
    assertAllowed(await decide(listener, name, LEAD, args), `关闭层级门禁后 Lead 的 ${name}`);
  }
  // 但执行边界不受影响：Lead 仍然不能自己写文件。
  assertDenied(await decide(listener, 'write', LEAD, {}), '关闭层级门禁后 Lead 的 write');
});

test('指挥者模式：层级门禁排在 Mandate 派发门禁之前（Lead 拿到的是层级理由）', async () => {
  // 这是接线顺序的回归测试：3.0.0 把三条层级门禁插在 0.6.0 的派发门禁**之前**
  // （agent.js：层级门禁 → 执行边界 → 禁止等待 → 异步容量 → 派发门禁）。
  // 有账本、没授权时，Lead 调 subagent_implementer 必须拿到**层级**理由
  // （"团队活交给小组长"），而不是 Mandate 理由（"先 ask_user_question 确认计划"）。
  // 5.0.0：requireMandate 默认关，所以这里显式打开它，才能验证"层级门禁排在派发门禁之前"。
  const emptyLedger = { activeMandate: () => null, listTickets: () => [] };
  const { listener } = boot(applyCommander, { ledger: emptyLedger, options: { requireMandate: true } });

  const denied = assertDenied(
    await decide(listener, 'subagent_implementer', LEAD, { task: '实现 X' }),
    'Lead 调 subagent_implementer（无授权）',
  );
  assert.ok(denied.includes('小组长'), `应先命中层级门禁：${denied}`);
  assert.ok(!denied.includes('计划授权'), `不应先命中 Mandate 门禁：${denied}`);

  // 关掉层级门禁后，同一个调用才会落到 Mandate 门禁上（证明顺序与开关都真的生效）。
  const relaxed = boot(applyCommander, {
    ledger: emptyLedger,
    options: { delegationHierarchy: false, requireMandate: true },
  });
  const mandateReason = assertDenied(
    await decide(relaxed.listener, 'subagent_implementer', LEAD, { task: '实现 X' }),
    '关闭层级门禁后 Lead 调 subagent_implementer（无授权）',
  );
  assert.ok(mandateReason.includes('计划授权'), `应命中 Mandate 门禁：${mandateReason}`);
});

test('指挥者模式：执行边界拒因随 delegationHierarchy 切换（默认不教指挥官直调 subagent_*）', async () => {
  // W3 修复的 P2 的**接线**回归：`agent.js` 必须把 `delegationHierarchy` 传给
  // `evaluatePreExecute()`，否则 `buildDenialReason` 会按默认（开启）生成理由——虽然默认值
  // 恰好一致，但一旦配置显式关掉，接线漏传就会让拒因继续教模型直调 `subagent_*`（与 2.x
  // 语义相反）。这里用一份"视图里真有 subagent_*"的 Lead 同时验证两个方向。
  const toolView = ['read', 'write', 'pwsh', 'ask_user_question', 'subagent', 'send_message', 'subagent_architect'];
  const leadWithTools = {
    ...LEAD,
    ctx: { tools: { schemas: () => toolView.map((name) => ({ name })) } },
  };

  // 默认（层级门禁开启）：拒因只给 Team 通道 + 小组长，且明确"一次性专家工具归小组长、
  // 你不要调用"。6.0.0：拒因里会出现**泛指**的 `subagent_<id>`（否定语境），所以旧断言
  // `!includes('subagent_')` 改成"不得出现直调指令 + 必须出现否定语境"。
  const on = boot(applyCommander);
  const deniedOn = assertDenied(await decide(on.listener, 'write', leadWithTools, {}), 'write（层级门禁开启）');
  assert.ok(!deniedOn.includes('2) 用 `subagent_architect`'), `不得教指挥官直调 subagent_*：${deniedOn}`);
  assert.ok(deniedOn.includes('subagent_<id>') && deniedOn.includes('你不要调用'), `应说明一次性专家工具归小组长：${deniedOn}`);
  assert.ok(deniedOn.includes('subagent'), `必须给 Team 通道：${deniedOn}`);
  assert.ok(deniedOn.includes('小组长'), `必须落到小组长：${deniedOn}`);

  // 显式关掉层级门禁（2.x 行为）：同一份视图恢复点名它真有的 specialist 工具。
  const off = boot(applyCommander, { options: { delegationHierarchy: false } });
  const deniedOff = assertDenied(await decide(off.listener, 'write', leadWithTools, {}), 'write（层级门禁关闭）');
  assert.ok(deniedOff.includes('subagent_architect'), `2.x 语义应点名 specialist 工具：${deniedOff}`);
});

test('指挥者模式：不相关的工具不受门禁影响（wait_agent 例外，见下一条）', async () => {
  const { listener } = boot(applyCommander);
  for (const name of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question', 'list_agents']) {
    assertAllowed(await decide(listener, name, LEAD, { timeout_ms: 30000 }), name);
  }
});

test('指挥者模式：禁止等待是无条件门禁（整条链、delegationHierarchy:false 也拒绝）', async () => {
  // 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**；随后追加「不要等」→
  // **整条链都不许等**。`wait_agent` 是第 4 条确定性门禁，**不读任何配置** —— 关掉层级门禁、
  // 清空 blockedTools、塞旧 maxWaitMs 都不能放开它。这条就是"没有开关"的接线级证明。
  const cases = [
    ['默认配置', {}],
    ['delegationHierarchy:false', { options: { delegationHierarchy: false } }],
    ['blockedTools:[]', { options: { blockedTools: [] } }],
    ['旧 maxWaitMs:0 残留', { options: { maxWaitMs: 0, delegationHierarchy: false } }],
  ];
  for (const [label, initial] of cases) {
    const { listener } = boot(applyCommander, initial);
    const reason = assertDenied(
      await decide(listener, 'wait_agent', LEAD, { timeout_ms: 1_800_000 }),
      `wait_agent（${label}）`,
    );
    assert.ok(reason.includes('硬禁用'), `${label}：拒因要说明硬禁用：${reason}`);
    assert.ok(reason.includes('没有开关'), `${label}：拒因要说明没有开关：${reason}`);
    assert.ok(reason.includes('整条链都不许等'), `${label}：拒因要说明整条链：${reason}`);
  }

  // 3.2.0：整条链生效 —— teammate（小组长）与 subagent 调 wait_agent **同样被拒**。
  // 3.1.0 这里曾是"放行"，用户明确「不要等」后语义反转（不要恢复成放行）。
  const { listener } = boot(applyCommander);
  for (const [label, agent] of [['teammate', TEAMMATE], ['subagent', SUBAGENT], ['身份读不到', undefined]]) {
    assertDenied(
      await decide(listener, 'wait_agent', agent, { timeout_ms: 1_800_000 }),
      `${label} 的 wait_agent（整条链）`,
    );
  }
});
