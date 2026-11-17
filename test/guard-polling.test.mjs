/**
 * 「不许用轮询代替等待」的测试（`lib/guard.js` 的 `evaluatePollingGuard`，7.13.0 新增）。
 *
 * ## 现场（`b013bfbf`，某小组长会话，2026-11-16 18:05:16）
 *
 * ```
 * [18:05:16] tool/call: wait_agent {"timeout_ms":180000}
 * [18:05:16] tool/result: Error: 三层指挥链门禁：本模式不允许 wait_agent（硬禁用…）
 *            … 不等之后这样做：1) 要看状态 → list_agents / team_task_list …
 * [18:05:21] assistant: "Understood — wait_agent is hard-disabled… Instead, I can poll with list_agents"
 * ```
 *
 * 于是 turn 1 查 2 次、turn 2 查 2 次、turn 3 查 3 次（间隔约 4 分钟）。
 *
 * **根因：门禁只禁了工具名，没禁行为；而且拒因自己把 `list_agents` 写成了推荐出口。**
 * 轮询和 `wait_agent` 语义相同——都是"我没活干，在等别人"，只是轮询还额外烧轮次。
 *
 * ## 这里钉什么
 *
 * 1. 只有"查状态类"工具计入（`list_agents` / `team_task_list` / `team_task_get` / `commander_tickets`）；
 * 2. 超过阈值才拦（阈值给正常的多批确认留空间）；
 * 3. 拒因必须说清"这就是轮询"并给出两条唯一出路（推进 / 结束回合）；
 * 4. 拒因**不能再把 `list_agents` 当成"等"的替代品**（那是本次事故的直接诱因）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STATE_POLL_LIMIT,
  STATE_POLL_TOOLS,
  buildWaitForbiddenReason,
  evaluatePollingGuard,
} from '../lib/guard.js';

test('7.13.0：STATE_POLL_TOOLS 只含"查状态"类只读工具', () => {
  assert.deepEqual([...STATE_POLL_TOOLS].sort(), ['commander_tickets', 'list_agents', 'team_task_get', 'team_task_list']);
  // 「干活」的工具绝不能被算成查状态
  for (const tool of ['send_message', 'subagent', 'subagent_fork', 'interrupt_agent', 'pwsh', 'write']) {
    assert.ok(!STATE_POLL_TOOLS.includes(tool), `${tool} 不该算查状态`);
  }
});

test('7.13.0：阈值内放行（正常的多批确认不该被拦）', () => {
  for (let count = 1; count <= STATE_POLL_LIMIT; count += 1) {
    assert.equal(evaluatePollingGuard({ name: 'list_agents', count }), undefined, `第 ${count} 次应放行`);
  }
});

test('7.13.0：超过阈值就拦，且拒因说清"这就是轮询"', () => {
  const decision = evaluatePollingGuard({ name: 'list_agents', count: STATE_POLL_LIMIT + 1 });
  assert.ok(decision, '超出阈值应拒绝');
  assert.equal(decision.kind, 'deny');
  const reason = decision.reason;
  assert.ok(reason.includes('轮询'), reason);
  assert.ok(reason.includes('不是推进'), reason);
  // 两条唯一出路都要给
  assert.ok(reason.includes('send_message'), reason);
  assert.ok(reason.includes('结束回合'), reason);
  // 必须解释"为什么轮询和 wait_agent 是一回事"
  assert.ok(reason.includes('wait_agent'), reason);
  assert.ok(reason.includes('不要重试'), reason);
});

test('7.13.0：非查状态工具一律放行，也不会因为 count 大而误拦', () => {
  for (const name of ['send_message', 'subagent', 'pwsh', 'write', 'team_task_create', undefined, '']) {
    assert.equal(evaluatePollingGuard({ name, count: 99 }), undefined, `${String(name)} 不该被轮询门禁拦`);
  }
});

test('7.13.0：四种查状态工具都受同一阈值约束', () => {
  for (const name of STATE_POLL_TOOLS) {
    assert.equal(evaluatePollingGuard({ name, count: STATE_POLL_LIMIT }), undefined);
    assert.ok(evaluatePollingGuard({ name, count: STATE_POLL_LIMIT + 1 }), `${name} 超阈值应拦`);
  }
});

test('7.13.0：wait_agent 的拒因不再把 list_agents 写成"等"的替代品', () => {
  // 事故直接诱因：旧拒因写「1) 要看状态 → list_agents」，模型据此把等待换成了轮询。
  const reason = buildWaitForbiddenReason();
  assert.ok(reason.includes('不许换个形式继续等'), reason);
  assert.ok(reason.includes('轮询'), reason);
  assert.ok(reason.includes('看一眼就够'), reason);
  // 仍然要保留正常出路（读状态本身没错，错的是反复读）
  assert.ok(reason.includes('list_agents'), reason);
  assert.ok(reason.includes('结束回合'), reason);
});
