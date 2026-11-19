/**
 * 「待投递结算通知」的测试（`lib/pending-notices.js`，7.19.0 新增）。
 *
 * ## 现象（`9fbe2191` = 小组长 `layout-paradigm-lead`，2026-11-18）
 *
 * 它派了 6 个子智能体，**只收到 2 个完成通知**，规律 100% 吻合：
 *
 * | 子智能体 | 结束时小组长 | 通知 |
 * |---|---|---|
 * | `code-structure-analyst` 09:02:55 | turn 1 **在跑** | ✅ |
 * | `bdx-reverser` 09:09:00 | turn 2 **在跑** | ✅ |
 * | `diag-data-analyst` 09:07:00 | 空闲（09:05:01 结束） | ❌ |
 * | `svg-verifier` 09:20:56 | 空闲（09:15:40 结束） | ❌ |
 * | `diag-direction-fields` 09:51:46 | 空闲（09:40:29 结束） | ❌ |
 * | `impl-zero-direction` 09:59:17 | 空闲 | ❌ |
 *
 * 最后是**上级**发来「子智能体已经完成任务了」才把它叫醒（turn 5 @ 10:00:11）
 * ——它自己完全不知道那 4 个已经完成。
 *
 * ## 根因（读运行时源码确证）
 *
 * `@deepseek-ai/dsh-subagent` 的 `notifySettlement()`：
 * `if (parent === void 0 || parent.ctx.fiber.state !== 2 || ...) return;`
 * —— 父级回合不在跑 → **直接 return，通知不生成也不排队，静默丢弃**。
 *
 * ## 这里钉什么
 *
 * 1. 送不出去的通知必须**存下来**（不能丢）；
 * 2. 父级下次醒来时**取走并清空**（不重复轰炸）；
 * 3. 同一子会话只留一条、有 TTL、有上限（不积压、不翻旧账）；
 * 4. 指挥者（depth 0）不补（它拿通知是可靠的，补了只是重复）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PENDING_NOTICES,
  PENDING_NOTICE_TTL_MS,
  drainPendingNotices,
  pushPendingNotice,
  renderPendingNotices,
  shouldQueueNotice,
} from '../lib/pending-notices.js';

test('7.19.0：入队后能取出，且取出即清空（不重复轰炸）', () => {
  const ledger = {};
  assert.equal(pushPendingNotice(ledger, { childId: 'c-1', name: 'svg-verifier', stopReason: 'completed', at: 1000 }), true);
  assert.equal(ledger.pendingNotices.length, 1);

  const drained = drainPendingNotices(ledger, 2000);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].childId, 'c-1');
  assert.equal(drained[0].name, 'svg-verifier');
  // 第二次 drain 必须为空
  assert.deepEqual(drainPendingNotices(ledger, 3000), []);
});

test('7.19.0：同一子会话只留一条（重复的 subagent/end 不占位）', () => {
  const ledger = {};
  pushPendingNotice(ledger, { childId: 'c-1', at: 1000 });
  pushPendingNotice(ledger, { childId: 'c-1', at: 2000 });
  assert.equal(ledger.pendingNotices.length, 1);
  assert.equal(ledger.pendingNotices[0].at, 2000, '应保留最新那条');
});

test('7.19.0：按发生时间升序取出（补投顺序要可读）', () => {
  const ledger = {};
  pushPendingNotice(ledger, { childId: 'c-late', at: 3000 });
  pushPendingNotice(ledger, { childId: 'c-early', at: 1000 });
  const drained = drainPendingNotices(ledger, 4000);
  assert.deepEqual(drained.map((item) => item.childId), ['c-early', 'c-late']);
});

test('7.19.0：过期的通知丢弃（不翻几天前的旧账）', () => {
  const ledger = {};
  pushPendingNotice(ledger, { childId: 'c-old', at: 1000 });
  const drained = drainPendingNotices(ledger, 1000 + PENDING_NOTICE_TTL_MS + 1);
  assert.deepEqual(drained, [], '超过 TTL 应丢弃');
});

test('7.19.0：有上限，不会无限积压', () => {
  const ledger = {};
  for (let i = 0; i < MAX_PENDING_NOTICES + 10; i += 1) pushPendingNotice(ledger, { childId: `c-${i}`, at: i });
  assert.equal(ledger.pendingNotices.length, MAX_PENDING_NOTICES);
  // 保留最新的
  assert.ok(ledger.pendingNotices.some((item) => item.childId === `c-${MAX_PENDING_NOTICES + 9}`));
});

test('7.19.0：非法输入不崩、不入队', () => {
  const ledger = {};
  assert.equal(pushPendingNotice(ledger, null), false);
  assert.equal(pushPendingNotice(ledger, {}), false);
  assert.equal(pushPendingNotice(ledger, { childId: '   ' }), false);
  assert.equal(pushPendingNotice(null, { childId: 'c' }), false);
  assert.deepEqual(drainPendingNotices(null), []);
  assert.deepEqual(drainPendingNotices({}, 1000), []);
});

test('7.19.0：补投文本要说清"运行时静默丢弃"并给出动作', () => {
  const text = renderPendingNotices([
    { childId: 'c-1', name: 'svg-verifier', stopReason: 'completed' },
    { childId: 'c-2', name: 'impl-zero-direction', stopReason: 'completed' },
  ]);
  assert.ok(text.includes('补投'), text);
  assert.ok(text.includes('冷') || text.includes('静默丢弃'), text);
  assert.ok(text.includes('svg-verifier'), text);
  assert.ok(text.includes('impl-zero-direction'), text);
  assert.ok(text.includes('核对'), text);
  // 空列表 → 空串（不能凭空制造提示）
  assert.equal(renderPendingNotices([]), '');
  assert.equal(renderPendingNotices(undefined), '');
});

test('7.20.0：`peek` 只看不吞（看门狗每分钟都要看，不能把队列吃掉）', () => {
  // 现场 layout-paradigm-lead：03:29:07 回合结束 → 子智能体 03:41:37 完成 →
  // 通知进队列但**父级再也不醒来**，补投永远不执行。看门狗要靠 peek 发现"有代投通知"
  // 去叫醒它；如果用 drain，队列会被看门狗吃掉、补投内容就丢了。
  const ledger = {};
  pushPendingNotice(ledger, { childId: 'c-1', at: 1000 });
  pushPendingNotice(ledger, { childId: 'c-2', at: 2000 });
  // peek 两次都应看到 2 条
  assert.equal(ledger.pendingNotices.length, 2);
  assert.equal(ledger.pendingNotices.length, 2, 'peek 不应改变队列');
  // drain 才清空
  assert.equal(drainPendingNotices(ledger, 3000).length, 2);
  assert.deepEqual(drainPendingNotices(ledger, 4000), []);
});

test('7.20.0：该入队的第三种情形 —— 父级空闲的小组长（正是本次现场）', () => {
  // layout-paradigm-lead 当时：depth 1、回合已结束（idle）
  const idleLead = {
    status: 'idle',
    session: { header: { parentSession: 'session-1d8c8c60', delegationDepth: 1, origin: 'subagent' } },
  };
  assert.equal(shouldQueueNotice({ parentAgent: idleLead, stopReason: 'completed' }), true);
});

test('7.19.0：该入队的情形（取不到父级 / 父级空闲）', () => {
  // ① 取不到父级 agent（父级回合已结束、实例被回收）→ 必须存
  assert.equal(shouldQueueNotice({ parentAgent: undefined, stopReason: 'completed' }), true);
  assert.equal(shouldQueueNotice({ parentAgent: null, stopReason: 'completed' }), true);

  // ② 父级是被委派的子级 + 当前空闲 → 存（steer 可能落在已结算的激活上）
  const idleChild = {
    status: 'idle',
    session: { header: { parentSession: 'session-parent', delegationDepth: 1 } },
  };
  assert.equal(shouldQueueNotice({ parentAgent: idleChild, stopReason: 'completed' }), true);
});

test('7.19.0：不该入队的两种情形（避免重复噪音）', () => {
  // 指挥者（depth 0）：运行时通知实测可靠，不补
  const root = { status: 'idle', session: { header: {} } };
  assert.equal(shouldQueueNotice({ parentAgent: root, stopReason: 'completed' }), false);

  // 父级在跑：运行时会把通知直接递进当前回合，不需要存
  const runningChild = {
    status: 'running',
    session: { header: { parentSession: 'session-parent', delegationDepth: 1 } },
  };
  assert.equal(shouldQueueNotice({ parentAgent: runningChild, stopReason: 'completed' }), false);

  // stopReason 为空 → 不入队
  assert.equal(shouldQueueNotice({ parentAgent: undefined, stopReason: '  ' }), false);
});
