/**
 * 「通知链兜底」的测试（`lib/wake-chain.js`，7.5.0 新增）。
 *
 * ## 用户口径（2026-11-15）
 *
 * > 「子智能体完成通知小组长，小组长完成通知指挥官，而不是定期去检查进度，
 * >   除非用户确认进度」
 *
 * 要**通知链**，不要轮询。但实测这条链会断：`session-1d8c8c60` 里小组长派了
 * 7 个子智能体、全部正常结束，只收到 2 次完成通知，另外 5 次静默丢失
 * （丢/送与"父会话当时有没有开着的回合"完全相关）。
 *
 * 运行时侧原因已定位到 `@deepseek-ai/dsh-subagent` 的 `sendWaking()`：
 * 父级 activation 已结算时走 `parent.followup()`（排队，不唤醒），只有 `steer` 才唤醒。
 *
 * ## 这里钉什么
 *
 * 1. **只补 depth ≥ 1 的父级**（小组长）：指挥者是 root，实测通知可靠，补它是重复噪音；
 * 2. **只补"结束了"的结算**：payload 不可用 / 没有 stopReason 就不动；
 * 3. **必须用 steer**（唤醒），不能 inject（只写历史）；
 * 4. **全程 fail-open**：没有 agents 服务 / 父级不在线 / steer 抛错 → 静默跳过。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWakeText,
  handleSettlement,
  parseSettlement,
  shouldCompensate,
  shouldWakeFor,
  steerParent,
  WAKE_SOURCE_KIND,
} from '../lib/wake-chain.js';

/** 一个"小组长"父级（depth 1，可 steer）。 */
function leadAgent(overrides = {}) {
  const steered = [];
  return {
    steered,
    id: 'session-lead',
    session: { id: 'session-lead', header: { id: 'session-lead', parentSession: 'session-root', delegationDepth: 1 } },
    steer: (message) => { steered.push(message); },
    ...overrides,
  };
}

/** 一个"指挥者"父级（root，无父会话）。 */
function rootAgent() {
  const steered = [];
  return {
    steered,
    id: 'session-root',
    session: { id: 'session-root', header: { id: 'session-root' } },
    steer: (message) => { steered.push(message); },
  };
}

/** `subagent/end` 的典型 payload（来自 `runInfo()` + stopReason）。 */
function endInfo(overrides = {}) {
  return {
    runId: 'run-1',
    provider: 'local',
    parentSessionId: 'session-lead',
    id: 'child-u3',
    local: true,
    stopReason: 'completed',
    ...overrides,
  };
}

// ------------------------------------------------------------ 解析 ---

test('7.5.0：parseSettlement 只认带 parentSessionId + id 的 payload', () => {
  assert.deepEqual(parseSettlement(endInfo()), {
    parentSessionId: 'session-lead',
    childId: 'child-u3',
    stopReason: 'completed',
  });
  // 缺关键字段 → undefined（不猜）
  assert.equal(parseSettlement({ id: 'x' }), undefined);
  assert.equal(parseSettlement({ parentSessionId: 'p' }), undefined);
  assert.equal(parseSettlement(null), undefined);
  assert.equal(parseSettlement('nope'), undefined);
  // stopReason 缺失 → unknown（仍然值得唤醒）
  assert.equal(parseSettlement(endInfo({ stopReason: undefined })).stopReason, 'unknown');
});

test('7.5.0：shouldWakeFor 对所有"结束了"的原因都唤醒', () => {
  for (const reason of ['completed', 'aborted', 'max-tokens', 'refusal', 'error', 'weird-future']) {
    assert.equal(shouldWakeFor(reason), true, `${reason} 应当唤醒父级`);
  }
  assert.equal(shouldWakeFor(''), false);
  assert.equal(shouldWakeFor(undefined), true, '未知原因也唤醒（宁可多叫一次）');
});

// ------------------------------------------------- 只补小组长（depth ≥ 1） ---

test('7.5.0：父级是小组长（depth ≥ 1）才补唤醒', () => {
  assert.equal(shouldCompensate(leadAgent()), true);
  // 三种证据任一命中即算子级
  assert.equal(shouldCompensate({ steer: () => {}, session: { header: { parentSession: 'p' } } }), true);
  assert.equal(shouldCompensate({ steer: () => {}, session: { header: { origin: 'subagent' } } }), true);
  assert.equal(shouldCompensate({ steer: () => {}, session: { header: { delegationDepth: 2 } } }), true);
});

test('7.5.0：父级是指挥者（root）不补 —— 避免重复噪音', () => {
  assert.equal(shouldCompensate(rootAgent()), false);
  assert.equal(shouldCompensate(undefined), false);
  // 没有 steer 能力（读不到可唤醒通道）也不补
  assert.equal(shouldCompensate({ session: { header: { parentSession: 'p' } } }), false);
});

// ------------------------------------------------------------ 唤醒 ---

test('7.5.0：唤醒正文极短，且明确"详情以运行时通知为准"', () => {
  const text = buildWakeText({ childId: 'child-u3', stopReason: 'completed' }, 'u3-field-diff');
  assert.ok(text.includes('【子智能体完成】'), text);
  assert.ok(text.includes('u3-field-diff'), text);
  assert.ok(text.includes('已完成'), text);
  assert.ok(text.includes('运行时'), '要说明这是兜底、详情看运行时通知');
  // 不能把结论重复一遍（真实通知已在队列里）
  assert.ok(text.length < 200, `唤醒正文应极短，实际 ${text.length} 字符`);
  // 没有可读名时退回会话 id
  assert.ok(buildWakeText({ childId: 'child-x', stopReason: 'error' }).includes('child-x'));
  // 非 completed 的原因要显示出来
  assert.ok(buildWakeText({ childId: 'c', stopReason: 'max-tokens' }).includes('max-tokens'));
});

test('7.5.0：steerParent 用 steer（唤醒），且 source 带插件标记', () => {
  const parent = leadAgent();
  assert.equal(steerParent(parent, 'hi', 'summary'), true);
  assert.equal(parent.steered.length, 1);
  const message = parent.steered[0];
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, 'hi');
  assert.equal(message.source.kind, WAKE_SOURCE_KIND);
  assert.equal(message.source.form, 'notice');
  assert.ok(typeof message.id === 'string' && message.id.length > 0);
});

test('7.5.0：steer 抛错时返回 false，不冒泡', () => {
  const broken = leadAgent({ steer: () => { throw new Error('closed'); } });
  assert.equal(steerParent(broken, 'hi', 's'), false);
  assert.equal(steerParent({}, 'hi', 's'), false);
  assert.equal(steerParent(null, 'hi', 's'), false);
});

// ------------------------------------------------------ handleSettlement ---

test('7.5.0：父级是小组长 → 真的唤醒一次', () => {
  const parent = leadAgent();
  const result = handleSettlement({
    info: endInfo({ name: 'u3-field-diff' }),
    getService: () => ({ get: (id) => (id === 'session-lead' ? parent : undefined) }),
  });
  assert.equal(result.woke, true);
  assert.equal(result.reason, 'steered');
  assert.equal(parent.steered.length, 1);
  assert.ok(parent.steered[0].content[0].text.includes('u3-field-diff'));
});

test('7.5.0：父级是指挥者 → 不补（运行时通知可靠）', () => {
  const root = rootAgent();
  const result = handleSettlement({
    info: endInfo({ parentSessionId: 'session-root' }),
    getService: () => ({ get: (id) => (id === 'session-root' ? root : undefined) }),
  });
  assert.equal(result.woke, false);
  assert.equal(result.reason, 'parent-is-root');
  assert.equal(root.steered.length, 0);
});

test('7.5.0：读不到服务 / 父级不在线 / payload 不可用 → 静默跳过', () => {
  const cases = [
    [{ getService: () => undefined }, 'no-agents-service'],
    [{ getService: () => ({}) }, 'no-agents-service'],
    [{ getService: () => ({ get: () => undefined }) }, 'parent-not-live'],
    [{ info: { id: 'x' } }, 'payload-unusable'],
  ];
  for (const [overrides, expected] of cases) {
    const result = handleSettlement({ info: endInfo(), getService: () => ({ get: (id) => undefined }), ...overrides });
    assert.equal(result.woke, false, JSON.stringify(overrides));
    assert.equal(result.reason, expected);
  }
});

test('7.5.0：兜底自身抛错也返回 woke:false，不冒泡', () => {
  const result = handleSettlement({
    info: endInfo(),
    getService: () => { throw new Error('boom'); },
  });
  assert.equal(result.woke, false);
  assert.equal(result.reason, 'error');
});
