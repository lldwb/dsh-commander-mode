/**
 * 「禁止等待子智能体」硬门禁的单元测试（3.1.0）。
 *
 * 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**。
 *
 * 2.0.0 的「等待上限」门禁（`maxWaitMs`，默认 120s、配 0 可关闭）已被整体删除。原因写在
 * `lib/guard.js` 的模块注释里，但核心是：只要还能等，模型就会把"等"当成默认动作；只要还能配，
 * 部署里就会出现"这次先关掉"。所以 3.1.0 起 `wait_agent` 对指挥官**无条件拒绝**，
 * 没有任何配置项可以放开。
 *
 * 这一组守三件事：
 *
 * 1. **拒绝面**：Lead 调 `wait_agent` 一律被拒（不是"超长才拒"、也不看参数）；
 * 2. **放行面**：只拦 `wait_agent`，读状态 / 派活 / 唤醒工具照常；teammate 等自己的下级
 *    属于它自己的调度，也必须放行（拦死子代理 = 整个模式干不了活）；
 * 3. **没有开关**：不受 `delegationHierarchy` / `blockedTools` / 任何旧配置影响，
 *    并且 `lib/guard.js` / `lib/config.js` 里不再存在 2.0.0 的等待上限 API。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as guardModule from '../lib/guard.js';
import {
  buildWaitForbiddenReason,
  evaluateWaitForbidden,
} from '../lib/guard.js';

/** 一个 Lead agent：有会话 header，但没有父会话（不是被委派出来的子级）。 */
const LEAD = Object.freeze({ id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead' } } });

/** 一个 teammate：三个身份证据齐全（parentSession / origin / delegationDepth）。 */
const TEAMMATE = Object.freeze({
  id: 'session-child',
  session: { id: 'session-child', header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
});

// ---------------------------------------------------------------- 拒绝面 ---

test('Lead 调 wait_agent 一律被拒（不是"超长才拒"，也不看 timeout_ms）', () => {
  // 3.1.0 与 2.0.0 的关键区别：2.0.0 只拦"超过上限"的等待，短等放行；
  // 3.1.0 是**完全禁止**——缺省参数、60 秒、5 分钟、30 分钟都一样拒。
  const argumentShapes = [
    undefined, // 没有 arguments
    {},
    { timeout_ms: 30_000 }, // DSH 的默认值
    { timeout_ms: 60_000 },
    { timeout_ms: 120_000 },
    { timeout_ms: 1_800_000 },
    { timeout_ms: '1800000' }, // 字符串数字同样拒（不做类型转换绕过）
    { timeout_ms: -1 },
    { timeout_ms: null },
    { other: 'x' }, // 完全不传 timeout_ms 也拒
  ];
  for (const args of argumentShapes) {
    const decision = evaluateWaitForbidden({ agent: LEAD, name: 'wait_agent', args });
    assert.ok(decision !== undefined, `args=${JSON.stringify(args)} 时 wait_agent 应被拒绝`);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.length > 0);
  }
});

test('缺省 timeout_ms 也拒（不存在"不传参数就放行"的漏洞）', () => {
  // 2.0.0 的门禁按 `args.timeout_ms ?? 30000` 比较，缺省等于"30 秒"；3.1.0 完全禁止，
  // 所以缺省参数同样被拒。这条防的是"门禁只看显式参数"的实现退化。
  for (const input of [
    { agent: LEAD, name: 'wait_agent' },
    { agent: LEAD, name: 'wait_agent', args: {} },
    { agent: LEAD, name: 'wait_agent', args: { timeout_ms: undefined } },
    { agent: LEAD, name: 'wait_agent', args: { timeout_ms: null } },
  ]) {
    const decision = evaluateWaitForbidden(input);
    assert.ok(decision !== undefined, `${JSON.stringify(input)} 应被拒绝`);
    assert.equal(decision.kind, 'deny');
  }
});

test('参数类型不能绕过：字符串 / 小数 / NaN / Infinity / 负数 / 对象一律拒', () => {
  // 旧门禁会校验"正整数毫秒"；新门禁连参数都不看 —— 任何类型都拒，
  // 这样就不存在"换一种写法让门禁认不出来"的绕过面。
  const shapes = ['1800000', '60000', 60_000.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, {}, [], () => {}];
  for (const timeout of shapes) {
    const decision = evaluateWaitForbidden({ agent: LEAD, name: 'wait_agent', args: { timeout_ms: timeout } });
    assert.ok(decision !== undefined, `timeout_ms=${String(timeout)} 应被拒绝`);
    assert.equal(decision.kind, 'deny');
  }
});

test('拒因是纠正指令：硬禁用 / 没有开关 / 完成通知会唤醒 / 三条替代动作', () => {
  const reason = buildWaitForbiddenReason();
  // 三件必须让模型当场知道的事：被禁的是哪个工具、为什么连"短等"也不行、不等之后做什么。
  assert.ok(reason.includes('wait_agent'), reason);
  assert.ok(reason.includes('硬禁用'), `要说明是硬禁用：${reason}`);
  assert.ok(reason.includes('没有开关'), `要说明没有开关：${reason}`);
  assert.ok(reason.includes('不要重试'), `要明确不要重试：${reason}`);
  assert.ok(reason.includes('【派工完成】'), `要说明完成通知会主动唤醒：${reason}`);
  // 三步替代动作：读状态 / 追问 / 汇报后结束回合。
  assert.ok(reason.includes('list_agents'), `要给出读状态这条路：${reason}`);
  assert.ok(reason.includes('team_task_list'), `要给出看任务板这条路：${reason}`);
  assert.ok(reason.includes('send_message'), `要给出追问这条路：${reason}`);
  assert.ok(reason.includes('结束回合'), `要给出"汇报后结束回合"这条路：${reason}`);
});

test('拒因文案不得暗示"可以配置"（这条门禁是硬编码的）', () => {
  // 用户明确要求"不设开关"。文案里只要出现 maxWaitMs / 上限 / 可配置 / 可以关 之类的暗示，
  // 模型就会去试"调小一点"或"关掉它"，白烧轮次；用户也会以为还能配。
  const reason = buildWaitForbiddenReason();
  for (const forbidden of ['maxWaitMs', '可配置', '可以关', '配置项', '上限', 'timeout_ms 不超过']) {
    assert.ok(!reason.includes(forbidden), `拒因不得暗示可配置（出现「${forbidden}」）：${reason}`);
  }
  // 正面的替代动作必须在场（不只是"禁止"）。
  for (const alternative of ['list_agents', 'team_task_list', 'send_message', 'interrupt_agent', '结束回合']) {
    assert.ok(reason.includes(alternative), `拒因缺少替代动作：${alternative}`);
  }
});

// ---------------------------------------------------------------- 没有开关 ---

test('没有开关：传 delegationHierarchy / blockedTools 等配置都不改变判定', () => {
  // 3.1.0 的硬门禁**不读任何配置**。传进去的字段一律被忽略 —— 尤其要防"看起来像开关"
  // 的参数把判定改掉（2.0.0 的 maxWaitMs:0 就是这样一个开关）。
  const attempts = [
    { agent: LEAD, name: 'wait_agent' },
    { agent: LEAD, name: 'wait_agent', delegationHierarchy: false },
    { agent: LEAD, name: 'wait_agent', delegationHierarchy: true },
    { agent: LEAD, name: 'wait_agent', blockedTools: [] },
    { agent: LEAD, name: 'wait_agent', maxWaitMs: 0 }, // 旧开关名：现在只是被忽略的未知参数
    { agent: LEAD, name: 'wait_agent', args: { timeout_ms: 1_000 }, delegationHierarchy: false },
  ];
  for (const input of attempts) {
    const decision = evaluateWaitForbidden(input);
    assert.ok(decision !== undefined, `${JSON.stringify(input)} 仍应被拒绝（没有开关）`);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('没有开关'), decision.reason);
  }
});

test('3.1.0：2.0.0 的等待上限 API 已从 guard / config 彻底删除', () => {
  // 只要这些符号还在，就存在"被重新接回去当开关"的可能。删干净才是"不设开关"。
  for (const symbol of ['evaluateWaitCap', 'buildWaitCapReason', 'DEFAULT_MAX_WAIT_MS', 'DSH_DEFAULT_WAIT_MS']) {
    assert.equal(symbol in guardModule, false, `guard.js 不应再导出 ${symbol}`);
  }
  // 新 API 必须在。
  assert.equal(typeof guardModule.evaluateWaitForbidden, 'function');
  assert.equal(typeof guardModule.buildWaitForbiddenReason, 'function');
});

// ---------------------------------------------------------------- 放行面 ---

test('只拦 wait_agent：读状态 / 派活 / 唤醒工具一律放行', () => {
  // 这条是"不要拦死"的边界：模型被拒等待后，正确动作正是这些工具；
  // 拦了它们等于把人堵在原地。
  const unaffected = [
    'list_agents',
    'team_task_list',
    'team_task_get',
    'team_task_update',
    'team_task_create',
    'send_message',
    'spawn_teammate',
    'interrupt_agent',
    'read',
    'todo_write',
    'ask_user_question',
    'workflow',
    'subagent_architect',
  ];
  for (const name of unaffected) {
    assert.equal(
      evaluateWaitForbidden({ agent: LEAD, name, args: { timeout_ms: 1_800_000 } }),
      undefined,
      `${name} 不该被禁止等待门禁拦`,
    );
  }
});

test('teammate（小组长 / 子智能体）等自己的下级必须放行', () => {
  // 小组长在 L1 等它派出的 L2 属于它自己的调度，不在本门禁范围内。
  // 拦死子代理 = 整个模式干不了活（宁可漏拦，不可拦死）。
  for (const args of [undefined, {}, { timeout_ms: 1_800_000 }]) {
    assert.equal(evaluateWaitForbidden({ agent: TEAMMATE, name: 'wait_agent', args }), undefined);
  }
});

test('身份读不出来时放行（宁可漏拦，不可拦死）', () => {
  for (const agent of [undefined, null, {}, { session: null }, { session: {} }, { session: { header: null } }]) {
    assert.equal(evaluateWaitForbidden({ agent, name: 'wait_agent' }), undefined, `身份读不到（${JSON.stringify(agent)}）`);
  }
});

test('工具名缺失 / 非法 / 空调用不抛错，也不误拦', () => {
  // 门禁在工具调用路径上：抛错会让整次调用失败，那比"漏拦一次"糟糕得多。
  for (const name of [undefined, null, '', 42, {}, 'wait']) {
    assert.doesNotThrow(() => evaluateWaitForbidden({ name }));
    assert.equal(evaluateWaitForbidden({ name }), undefined, `${String(name)} 不是 wait_agent`);
  }
  assert.doesNotThrow(() => evaluateWaitForbidden());
  assert.equal(evaluateWaitForbidden(), undefined);
});

test('门禁自身出错时放行，而不是让工具调用失败', () => {
  const hostile = {
    get session() {
      throw new Error('boom');
    },
  };
  // isDelegatedAgent 在抛错时返回 true（当作子级放行），所以这里也放行。
  assert.doesNotThrow(() => evaluateWaitForbidden({ agent: hostile, name: 'wait_agent' }));
  assert.equal(evaluateWaitForbidden({ agent: hostile, name: 'wait_agent' }), undefined);
});
