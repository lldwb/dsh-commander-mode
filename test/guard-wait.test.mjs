/**
 * 等待门禁的单元测试（2.0.0）。
 *
 * 这一组守的是用户 2026-11-09 复盘后明确要求的那条硬约束：**等子代理不要一直等**。
 * 历史会话里 `wait_agent` 被用来挂机：会话 5d9b3002 里 39 次合计 231 分钟、单次最长
 * 127.5 分钟；会话 3b342fc5 里 101 次合计 667.5 分钟，其中 6 次直接等满 1800000ms。
 *
 * 协议只能"劝"，这里必须**确定性拒绝**。同时断言另一条边界：只拦 `wait_agent` 的超长
 * `timeout_ms`，`list_agents` / `team_task_list` / `send_message` 这些"读状态 / 唤醒队友"
 * 的工具一律不受影响 —— 否则模型会被拦住却又没法推进，反而更糟。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  KNOWN_CONFIG_KEYS,
  readWaitCap,
  resolveConfig,
} from '../lib/config.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DSH_DEFAULT_WAIT_MS,
  buildWaitCapReason,
  evaluateWaitCap,
} from '../lib/guard.js';

// ---------------------------------------------------------------- 默认值 ---

test('maxWaitMs 默认 120000（schema、读取器、resolveConfig 三处一致）', () => {
  // 三处不一致会静默改变行为：schema 是设置页与 Loader 的默认，resolveConfig 是
  // 模式行实际读到的值，门禁内部还有一份"没传上限时"的兜底。
  assert.equal(DEFAULT_MAX_WAIT_MS, 120_000);
  assert.equal(Config().maxWaitMs, 120_000);
  assert.equal(Config.dict.maxWaitMs.meta.default, 120_000);
  assert.equal(resolveConfig(undefined).options.maxWaitMs, 120_000);
  assert.equal(resolveConfig({}).options.maxWaitMs, 120_000);
  assert.ok(KNOWN_CONFIG_KEYS.includes('maxWaitMs'), 'KNOWN_CONFIG_KEYS 缺少 maxWaitMs');
});

test('maxWaitMs 的 schema 范围：0（关闭）与 1000–1800000 合法，其余拒绝', () => {
  assert.equal(Config({ maxWaitMs: 0 }).maxWaitMs, 0, '0 = 关闭门禁');
  assert.equal(Config({ maxWaitMs: 1000 }).maxWaitMs, 1000);
  assert.equal(Config({ maxWaitMs: 1_800_000 }).maxWaitMs, 1_800_000);
  assert.throws(() => Config({ maxWaitMs: -1 }));
  assert.throws(() => Config({ maxWaitMs: 1_800_001 }));
  assert.throws(() => Config({ maxWaitMs: 1.5 }));
});

test('readWaitCap：解引用、夹取范围、0 是关闭而不是回退默认', () => {
  // 不能用 readPositiveNumber：它会把 0 回退成默认值，恰好抹掉"关闭门禁"这个显式选择。
  assert.equal(readWaitCap(undefined), 120_000);
  assert.equal(readWaitCap(null), 120_000);
  assert.equal(readWaitCap(0), 0);
  assert.equal(readWaitCap({ get: () => 0 }), 0, 'volatile 引用解引用后是 0 也要保持关闭');
  assert.equal(readWaitCap({ get: () => 60_000 }), 60_000);
  assert.equal(readWaitCap('60000'), 60_000);
  assert.equal(readWaitCap(500), 1_000, '低于 1000 抬到下限');
  assert.equal(readWaitCap(-5), 1_000);
  assert.equal(readWaitCap(9_999_999), 1_800_000, '高于硬上限压到 1800000');
  assert.equal(readWaitCap(Number.NaN), 120_000);
});

// ---------------------------------------------------------------- 判定 ---

test('默认上限 120000：1800000 / 600000 的超长等待被拒绝', () => {
  for (const timeout of [1_800_000, 600_000, 900_000, 120_001]) {
    const reason = evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: timeout } });
    assert.equal(typeof reason, 'string', `${timeout}ms 应当被拒绝`);
    assert.ok(reason.includes(String(timeout)), `拒因要点名模型给的 ${timeout}`);
    assert.ok(reason.includes('120000'), '拒因要给出当前上限');
    assert.ok(reason.includes('短等待'), '拒因要告诉模型改成短等待');
    assert.ok(reason.includes('继续推进'), '拒因要告诉模型等待期间继续推进其它工作');
    assert.ok(reason.includes('不要长等'), '拒因要明确说不要长等');
  }
});

test('60000 放行；等于上限也放行（<= 语义）', () => {
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: 60_000 } }), undefined);
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: 120_000 } }), undefined);
});

test('缺省 timeout_ms 按 DSH 实际默认值 30000 比较', () => {
  // DSH 的 wait_agent：`args.timeout_ms ?? 30000`。缺省不等于"没有约束"，
  // 否则把 maxWaitMs 调到 10 秒时，模型反而能靠不传参数绕过门禁。
  assert.equal(DSH_DEFAULT_WAIT_MS, 30_000);
  assert.equal(evaluateWaitCap({ name: 'wait_agent' }), undefined);
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: {} }), undefined);
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: undefined } }), undefined);
  // 上限低于 30000 时，缺省调用也会被拒，拒因里给出真实生效的 30000。
  const reason = evaluateWaitCap({ name: 'wait_agent', args: {}, maxWaitMs: 10_000 });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.includes('30000'), reason);
  assert.ok(reason.includes('10000'), reason);
});

test('字符串数字 / 非整数 / 非正数都拒绝（不能靠类型转换绕过）', () => {
  // 模型把 1800000 写成 "1800000" 时语义仍是超长等待。
  for (const timeout of ['1800000', '60000', 60_000.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const reason = evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: timeout } });
    assert.equal(typeof reason, 'string', `timeout_ms=${String(timeout)} 应当被拒绝`);
    assert.match(reason, /正整数毫秒/u, `拒因要说明合法形态：${reason}`);
  }
});

test('maxWaitMs = 0 时门禁关闭（任何等待都放行）', () => {
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: 1_800_000 }, maxWaitMs: 0 }), undefined);
  assert.equal(evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: 600_000 }, maxWaitMs: 0 }), undefined);
});

test('maxWaitMs 传非法值时按默认 120000 处理（不能静默变成"无上限"）', () => {
  for (const cap of [Number.NaN, undefined, 'nope', {}, true]) {
    const reason = evaluateWaitCap({ name: 'wait_agent', args: { timeout_ms: 1_800_000 }, maxWaitMs: cap });
    assert.equal(typeof reason, 'string', `maxWaitMs=${String(cap)} 应回退默认上限并拒绝超长等待`);
  }
});

test('只拦 wait_agent：读状态 / 唤醒队友 / 建板的工具一律放行', () => {
  // 这条是"不要拦死"的边界：模型被拒绝长等待后，正确动作正是 list_agents /
  // team_task_list / send_message / team_task_update；拦了它们等于把人堵在原地。
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
  ];
  for (const name of unaffected) {
    assert.equal(
      evaluateWaitCap({ name, args: { timeout_ms: 1_800_000 } }),
      undefined,
      `${name} 不该被等待门禁拦`,
    );
  }
});

test('非法参数形状不 throw（门禁只约束行为，不能让工具调用整体失败）', () => {
  const argsShapes = [undefined, null, 'nope', 42, true, [], () => {}, { timeout_ms: null }, { timeout_ms: {} }, { timeout_ms: () => {} }];
  for (const args of argsShapes) {
    assert.doesNotThrow(() => evaluateWaitCap({ name: 'wait_agent', args }));
  }
  // 工具名缺失/非法同样放行。
  for (const name of [undefined, null, '', 42, {}]) {
    assert.doesNotThrow(() => evaluateWaitCap({ name, args: { timeout_ms: 1_800_000 } }));
    assert.equal(evaluateWaitCap({ name, args: { timeout_ms: 1_800_000 } }), undefined);
  }
});

test('拒因是纠正指令：给出上限、下一步工具与"不要长等"', () => {
  const reason = buildWaitCapReason({ cap: 120_000, value: 600_000, invalid: false });
  assert.ok(reason.includes('wait_agent'), reason);
  assert.ok(reason.includes('600000'), reason);
  assert.ok(reason.includes('120000'), reason);
  assert.ok(reason.includes('短等待'), reason);
  assert.ok(reason.includes('list_agents'), '要给出读状态这条正确动作');
  assert.ok(reason.includes('team_task_list'), '要给出看任务板这条正确动作');
  assert.ok(reason.includes('【派工完成】'), '要提醒依赖完成通知');
});
