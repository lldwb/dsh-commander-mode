/**
 * 7.24.0 冷唤醒降级链测试（`lib/wake-chain.js`）。
 *
 * 覆盖：L1 steer 优先 / L2 冷唤醒成功 / L2 ownership 错误降 L3 / L3 投递 /
 * 全失败 fail-open / 同 childId 去重 / root 不冷唤醒 / 无 sessionController 时保持旧返回。
 *
 * 为什么不能只测 happy path：`resolveAgent()` 对「被 subagent 持有的会话」会直接返回
 * ownership 错误而不是 resume（rc.5 `session-controller/src/agent.ts:168-173`），所以
 * 冷唤醒必须有降级链；三条路径都用 fake controller 覆盖，不碰真实 DSH 会话。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createColdWaker,
  handleSettlement,
  isSubagentOwnershipError,
} from '../lib/wake-chain.js';

/** `subagent/end` 的典型 payload。 */
function endInfo(overrides = {}) {
  return {
    runId: 'run-1',
    provider: 'local',
    parentSessionId: 'session-lead',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    ...overrides,
  };
}

/** 一个活着的"小组长"父级（depth 1，可 steer）。 */
function leadAgent() {
  const steered = [];
  return {
    steered,
    id: 'session-lead',
    session: { id: 'session-lead', header: { id: 'session-lead', parentSession: 'session-root', delegationDepth: 1 } },
    steer: (message) => { steered.push(message); },
  };
}

/** 记录请求的假 sessionController；`behaviour(request, n)` 决定第 n 次调用的结果。 */
function fakeController(behaviour) {
  const requests = [];
  return {
    requests,
    prompt(request) {
      requests.push(request);
      return behaviour(request, requests.length);
    },
  };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('7.24.0 L1 优先：父级活着 → steer，绝不冷唤醒', () => {
  const parent = leadAgent();
  let coldCalls = 0;
  const result = handleSettlement({
    info: endInfo(),
    getService: () => ({ get: (id) => (id === 'session-lead' ? parent : undefined) }),
    coldWake: () => { coldCalls += 1; return { woke: true, reason: 'cold-woken' }; },
  });
  assert.equal(result.reason, 'steered');
  assert.equal(parent.steered.length, 1);
  assert.equal(coldCalls, 0, 'L1 成功时不得再冷唤醒（避免重复唤醒）');
});

test('7.24.0 L2 成功：拿不到活父级 → sessionController.prompt 冷唤醒', async () => {
  const controller = fakeController(() => Promise.resolve({ accepted: true }));
  const coldWake = createColdWaker({ getService: () => controller, clock: () => 1 });
  const result = handleSettlement({
    info: endInfo(),
    getService: () => ({ get: () => undefined }),
    coldWake,
  });
  assert.equal(result.woke, true);
  assert.equal(result.reason, 'cold-woken');
  await flush();
  assert.equal(controller.requests.length, 1);
  const request = controller.requests[0];
  assert.equal(request.sessionId, 'session-lead');
  assert.equal(request.mode, 'steer', '必须用 steer 唤醒空闲会话');
  assert.ok(Array.isArray(request.content) && request.content[0].type === 'text');
  assert.ok(request.content[0].text.length < 400, '唤醒正文必须极短');
});

test('7.24.0 L2 ownership 错误 → 降 L3 升级到最近的非子会话祖先', async () => {
  const ownership = Object.assign(new Error('session is owned by a subagent runtime'), { code: 'session/subagent-owned' });
  assert.equal(isSubagentOwnershipError(ownership), true);
  const controller = fakeController((_request, n) => (n === 1 ? Promise.reject(ownership) : Promise.resolve({ accepted: true })));
  const coldWake = createColdWaker({
    getService: () => controller,
    isRootSession: (id) => id === 'session-root',
    parentOf: (id) => (id === 'session-lead' ? 'session-root' : undefined),
    clock: () => 1,
  });
  const result = coldWake('session-lead', 'child-1', 'wake');
  assert.equal(result.woke, true);
  await flush();
  assert.equal(controller.requests.length, 2, 'L2 失败后应有一条 L3 升级投递');
  assert.equal(controller.requests[1].sessionId, 'session-root');
  assert.ok(controller.requests[1].content[0].text.includes('通知链告警'));
});

test('7.24.0 L2 非 ownership 错误 → 不盲目升级（只留痕）', async () => {
  const controller = fakeController(() => Promise.reject(new Error('network down')));
  const coldWake = createColdWaker({
    getService: () => controller,
    isRootSession: (id) => id === 'session-root',
    parentOf: () => 'session-root',
    clock: () => 1,
  });
  assert.equal(coldWake('session-lead', 'child-1', 'wake').woke, true);
  await flush();
  assert.equal(controller.requests.length, 1, '非 ownership 错误不升级，避免向祖先刷噪音');
});

test('7.24.0 全失败 fail-open：只返回原因，不抛错', () => {
  const coldWake = createColdWaker({ getService: () => { throw new Error('boom'); } });
  let result;
  assert.doesNotThrow(() => { result = coldWake('session-lead', 'child-1', 'wake'); });
  assert.equal(result.woke, false);
  assert.equal(result.reason, 'cold-failed');
  const settled = handleSettlement({
    info: endInfo(),
    getService: () => ({ get: () => undefined }),
    coldWake,
  });
  assert.equal(settled.woke, false);
  assert.equal(settled.reason, 'cold-failed');
});

test('7.24.0 同一 childId 只冷唤醒一次（去重）', () => {
  const controller = fakeController(() => Promise.resolve({}));
  const coldWake = createColdWaker({ getService: () => controller, clock: () => 1 });
  assert.equal(coldWake('session-lead', 'child-1', 'wake').woke, true);
  const second = coldWake('session-lead', 'child-1', 'wake');
  assert.equal(second.woke, false);
  assert.equal(second.reason, 'already-woken');
});

test('7.24.0 root 会话不冷唤醒', () => {
  const controller = fakeController(() => Promise.resolve({}));
  const coldWake = createColdWaker({
    getService: () => controller,
    isRootSession: (id) => id === 'session-root',
    clock: () => 1,
  });
  const result = handleSettlement({
    info: endInfo({ parentSessionId: 'session-root' }),
    getService: () => ({ get: () => undefined }),
    coldWake,
  });
  assert.equal(result.woke, false);
  assert.equal(result.reason, 'parent-is-root');
});

test('7.24.0 没有 sessionController → 保持旧返回 parent-not-live（不破坏现有语义）', () => {
  const coldWake = createColdWaker({ getService: () => ({ get: () => undefined }) });
  const result = handleSettlement({
    info: endInfo(),
    getService: () => ({ get: () => undefined }),
    coldWake,
  });
  assert.equal(result.woke, false);
  assert.equal(result.reason, 'parent-not-live');
});
