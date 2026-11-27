/**
 * `lib/offpeak-paused.js` 的单测：谷峰暂停判定与提示渲染。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFFPEAK_PAUSED_TITLE,
  collectOffpeakPaused,
  isOffpeakPause,
  lastTurnEndReason,
  renderOffpeakPausedNotice,
} from '../lib/offpeak-paused.js';

test('isOffpeakPause：只认 aborted + hook + offpeak-pause', () => {
  assert.equal(isOffpeakPause({ kind: 'aborted', reason: { kind: 'hook', reason: 'offpeak-pause' } }), true);
  assert.equal(isOffpeakPause({ kind: 'aborted', reason: { kind: 'hook', reason: 'shutdown' } }), false);
  assert.equal(isOffpeakPause({ kind: 'aborted', reason: { kind: 'user' } }), false);
  assert.equal(isOffpeakPause({ kind: 'aborted', reason: { kind: 'disposed' } }), false);
  assert.equal(isOffpeakPause({ kind: 'completed' }), false);
  assert.equal(isOffpeakPause({ kind: 'interrupted' }), false);
  assert.equal(isOffpeakPause(undefined), false);
});

test('lastTurnEndReason：取最后一个 turn/end 的 reason', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'offpeak-pause' } } } }
  ];
  assert.equal(isOffpeakPause(lastTurnEndReason(events)), true);
  assert.equal(lastTurnEndReason([]), undefined);
  assert.equal(lastTurnEndReason(undefined), undefined);
  assert.equal(lastTurnEndReason([{ type: 'turn/start', data: { turn: 1 } }]), undefined);
});

test('renderOffpeakPausedNotice：列出被暂停的下级，并明确「不是失败/别重派/会自动恢复」', () => {
  const text = renderOffpeakPausedNotice({
    paused: [{ id: 'c1', name: 'disk-scan-lead' }],
    resumeToolPresent: true
  });
  assert.ok(text.startsWith(OFFPEAK_PAUSED_TITLE));
  assert.ok(text.includes('disk-scan-lead'));
  assert.ok(text.includes('c1'));
  assert.ok(text.includes('不是失败'));
  assert.ok(text.includes('不要重新派一批'));
  assert.ok(text.includes('会自动续跑'));
  assert.ok(text.includes('session_resume_subagents'), '有工具时要给出立刻推进的通道');
});

test('renderOffpeakPausedNotice：没有这类下级时返回空串（不占 token）', () => {
  assert.equal(renderOffpeakPausedNotice({ paused: [] }), '');
  assert.equal(renderOffpeakPausedNotice({}), '');
  assert.equal(renderOffpeakPausedNotice({ paused: [{ id: '' }] }), '');
});

test('renderOffpeakPausedNotice：没有 session_resume_subagents 时改为「等它自己恢复」', () => {
  const text = renderOffpeakPausedNotice({
    paused: [{ id: 'c1', name: 'lead' }],
    resumeToolPresent: false
  });
  assert.ok(text.includes('没有 `session_resume_subagents`'));
  assert.ok(text.includes('等它们自动恢复'));
});

test('renderOffpeakPausedNotice：超过 8 个只列前 8 个并给出剩余数量', () => {
  const paused = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, name: `lead-${index}` }));
  const text = renderOffpeakPausedNotice({ paused, resumeToolPresent: true });
  assert.ok(text.includes('lead-7'));
  assert.equal(text.includes('lead-8'), false);
  assert.ok(text.includes('还有 2 个'));
});

test('collectOffpeakPaused：挑出被谷峰暂停的直接下级（跳过运行中/非 child/深层/已恢复）', async () => {
  const rows = [
    { kind: 'child', depth: 1, id: 'paused', path: 'sleep-runner', activity: 'inactive' },
    { kind: 'child', depth: 1, id: 'running', path: 'busy-lead', activity: 'running' },
    { kind: 'child', depth: 2, id: 'grand', path: 'grand/child', activity: 'inactive' },
    { kind: 'diagnostic', depth: 1, id: 'diag', activity: 'inactive' },
    { kind: 'child', depth: 1, id: 'normal', path: 'done-lead', activity: 'inactive' }
  ];
  const readSession = async (id) => {
    if (id === 'paused') {
      return {
        events: [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'offpeak-pause' } } } }
        ]
      };
    }
    return {
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
      ]
    };
  };
  const paused = await collectOffpeakPaused({ rows, readSession });
  assert.deepEqual(paused, [{ id: 'paused', name: 'sleep-runner' }]);
});

test('collectOffpeakPaused：读日志失败按「不是暂停」处理（不误报），且不抛错', async () => {
  const rows = [{ kind: 'child', depth: 1, id: 'broken', path: 'broken', activity: 'inactive' }];
  const paused = await collectOffpeakPaused({
    rows,
    readSession: async () => {
      throw new Error('corrupt log');
    }
  });
  assert.deepEqual(paused, []);
  // 没有 readSession 也安全。
  assert.deepEqual(await collectOffpeakPaused({ rows }), []);
});

test('collectOffpeakPaused：缓存命中时不再读日志；过期后重读', async () => {
  const rows = [{ kind: 'child', depth: 1, id: 'c1', path: 'lead', activity: 'inactive' }];
  let reads = 0;
  const readSession = async () => {
    reads += 1;
    return {
      events: [{ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'offpeak-pause' } } } }]
    };
  };
  const cache = new Map();
  const first = await collectOffpeakPaused({ rows, readSession, cache, now: 1_000, ttlMs: 500 });
  assert.equal(reads, 1);
  assert.equal(first.length, 1);

  const second = await collectOffpeakPaused({ rows, readSession, cache, now: 1_200, ttlMs: 500 });
  assert.equal(reads, 1, '缓存命中不重读');
  assert.equal(second.length, 1);

  await collectOffpeakPaused({ rows, readSession, cache, now: 1_600, ttlMs: 500 });
  assert.equal(reads, 2, '过期后重读');
});
