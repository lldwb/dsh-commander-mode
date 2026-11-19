/**
 * 7.24.0 通知补投与「在下级未收尾」提醒的测试。
 *
 * 覆盖：开场补投（有积压 → 渲染一次；第二次为空 = 去重）与 turn-stopping 的有/无在飞下级。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { pushPendingNotice, takePendingForRedelivery } from '../lib/pending-notices.js';
import { buildInFlightAdvisory } from '../lib/in-flight-advisory.js';

test('7.24.0 开场补投：有积压时交付一次，drain 后不重复', () => {
  const ledger = { pendingNotices: [] };
  pushPendingNotice(ledger, { childId: 'c-1', name: 'svg-verifier', stopReason: 'completed', at: 1000 });
  const service = {
    drainPendingNotices: () => {
      const rows = ledger.pendingNotices;
      ledger.pendingNotices = [];
      return rows;
    },
  };
  const first = takePendingForRedelivery({ service, sessionId: 's-1' });
  assert.equal(first.count, 1);
  assert.ok(first.text.includes('【子智能体结算通知（补投）】'), first.text);
  assert.ok(first.text.includes('svg-verifier'));
  const second = takePendingForRedelivery({ service, sessionId: 's-1' });
  assert.equal(second.count, 0, '同一批通知不得补投两次');
  assert.equal(second.text, '');
});

test('7.24.0 开场补投：无积压/服务不可用 → 空结果（fail-open）', () => {
  assert.deepEqual(takePendingForRedelivery({ service: undefined, sessionId: 's-1' }), { count: 0, text: '' });
  assert.deepEqual(takePendingForRedelivery({ service: {}, sessionId: 's-1' }), { count: 0, text: '' });
  assert.deepEqual(takePendingForRedelivery({ service: { drainPendingNotices: () => [] }, sessionId: 's-1' }), { count: 0, text: '' });
  assert.deepEqual(takePendingForRedelivery({ service: { drainPendingNotices: () => [] }, sessionId: '' }), { count: 0, text: '' });
});

test('7.24.0 turn-stopping：有在飞下级 → 注入提醒（点名 + 条件式措辞）', () => {
  const text = buildInFlightAdvisory({
    depth: 1,
    members: [
      { name: 'impl-zero-direction', status: 'running' },
      { name: 'reviewer', status: 'running' },
      { name: 'done-child', status: 'inactive' },
    ],
  });
  assert.ok(text.includes('还有 2 个下级在跑'), text);
  assert.ok(text.includes('impl-zero-direction'));
  assert.ok(text.includes('reviewer'));
  assert.ok(text.includes('有在飞下级时不得结束回合'));
  assert.ok(!text.includes('done-child'), '已结束的下级不点名');
});

test('7.24.0 turn-stopping：无在飞下级 / root / 未知 → 不注入', () => {
  assert.equal(buildInFlightAdvisory({ depth: 1, members: [{ name: 'a', status: 'inactive' }] }), '');
  assert.equal(buildInFlightAdvisory({ depth: 1, members: [] }), '');
  assert.equal(buildInFlightAdvisory({ depth: 0, members: [{ name: 'a', status: 'running' }] }), '');
  assert.equal(buildInFlightAdvisory({}), '');
  assert.equal(buildInFlightAdvisory({ depth: 1, members: null }), '');
});
