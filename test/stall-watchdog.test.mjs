/**
 * 「停滞看门狗」的测试（`lib/stall-watchdog.js`，7.16.0 新增）。
 *
 * ## 为什么必须做它（用户第 3 次报同一问题）
 *
 * 到 7.15.0 为止，插件所有"防退化"能力都是**看板**——只在**回合运行时**渲染。
 * 于是结构性死角：
 *
 * > **告警的可见性建立在"它正在运行"这个前提上，而"停下来"恰恰是"它不运行"。**
 *
 * 实测 `session-1d8c8c60`（重启后 582 事件）：13 个回合间隙、累计空闲 **134.2 分钟**；
 * 唤醒源 **用户消息 3 次 / 下级通知 10 次 / 自己 0 次**；最近一次空闲 **11 分钟**后
 * 用户问「进度如何了？」才继续。同期 `长会话体检`/`dispatch-focus` 都在报 —— 但检测不会唤醒。
 *
 * ## 这里钉什么
 *
 * 1. **该叫的必须叫**：无回合、无下级在跑、有活、超出宽限 → 叫；
 * 2. **不该叫的绝不叫**：回合在跑 / 下级在跑 / 没活 / 等用户 / 宽限内 / 冷却内；
 * 3. **冷却必须生效**：同一停滞不重复叫（这是 7.11.0 那 98 次刷屏的直接教训）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STALL_COOLDOWN_MS,
  STALL_GRACE_MS,
  buildStallNotice,
  shouldWakeStall,
} from '../lib/stall-watchdog.js';
const NOW = 1_000_000_000_000;
/** 已空闲 10 分钟（> 5 分钟宽限）的基准输入。 */
const stalled = (over = {}) => ({
  now: NOW,
  lastActiveAt: NOW - 10 * 60 * 1000,
  turnRunning: false,
  runningChildren: 0,
  openWork: 2,
  waitingOnUser: false,
  lastWokeAt: 0,
  ...over,
});

test('7.18.0：宽限期从 5 分钟缩到 90 秒（用户比看门狗先动就说明太慢）', () => {
  // 现场：04:08:12 结算完最后一项结束回合，空闲 **3 分 17 秒** 时用户就发「继续推进」把它叫醒
  // （04:11:32）——**用户比看门狗先动**。宽限期一旦超过用户容忍时间，看门狗永远来不及。
  assert.equal(STALL_GRACE_MS, 90 * 1000);
  // 90 秒 + 1 秒：该叫
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - 91 * 1000 })).wake, true);
  // 90 秒内：不叫
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - 60 * 1000 })).reason, 'within-grace');
});

test('7.18.0：回合刚结束 + 还有 open 工单 + 无下级 → 15 秒就叫（最强停滞信号）', () => {
  // 它刚"确认没活了"并结束回合，但台账里明明还有未结算项，而且没有下级会回来叫它。
  const justEnded = stalled({ lastActiveAt: NOW - 20 * 1000, justEndedTurn: true });
  const decision = shouldWakeStall(justEnded);
  assert.equal(decision.wake, true, `15 秒后就该叫：${JSON.stringify(decision)}`);
  // 但 15 秒内仍不叫（给收尾留一点余地）
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - 10 * 1000, justEndedTurn: true })).reason, 'within-grace');
  // 没有 open 工单时，即使刚结束回合也不叫
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - 60 * 1000, justEndedTurn: true, openWork: 0 })).reason, 'no-open-work');
  // 有下级在跑时也不叫（它们会走通知链）
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - 60 * 1000, justEndedTurn: true, runningChildren: 1 })).reason, 'children-running');
});

test('7.16.0：真停滞（无回合 + 无下级 + 有活 + 超宽限）→ 叫醒', () => {
  const decision = shouldWakeStall(stalled());
  assert.equal(decision.wake, true, JSON.stringify(decision));
  assert.equal(decision.reason, 'stalled');
});

test('7.16.0：回合在跑 / 下级在跑 → 不叫（不打断正在干活的）', () => {
  assert.equal(shouldWakeStall(stalled({ turnRunning: true })).reason, 'turn-running');
  assert.equal(shouldWakeStall(stalled({ runningChildren: 1 })).reason, 'children-running');
  // 有下级在跑时不需要看门狗：它们结束时走通知链（7.5.0 已补唤醒）
  assert.equal(shouldWakeStall(stalled({ runningChildren: 0 })).wake, true);
});

test('7.16.0：没活 / 在等用户 → 不叫', () => {
  assert.equal(shouldWakeStall(stalled({ openWork: 0 })).reason, 'no-open-work');
  assert.equal(shouldWakeStall(stalled({ waitingOnUser: true })).reason, 'waiting-on-user');
});

test('7.16.0：宽限期内不叫（刚结束回合的收尾不算停滞）', () => {
  const justEnded = stalled({ lastActiveAt: NOW - 60 * 1000 });
  assert.equal(shouldWakeStall(justEnded).reason, 'within-grace');
  // 刚好到宽限边界就该叫
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: NOW - STALL_GRACE_MS })).wake, true);
});

test('7.16.0：冷却期内不重复叫（防 7.11.0 那种刷屏）', () => {
  const recent = stalled({ lastWokeAt: NOW - 5 * 60 * 1000 });
  assert.equal(shouldWakeStall(recent).reason, 'cooldown');
  // 超过冷却期可以再叫一次
  assert.equal(shouldWakeStall(stalled({ lastWokeAt: NOW - STALL_COOLDOWN_MS })).wake, true);
});

test('7.16.0：活动时间未知时不叫（信息不足不乱叫）', () => {
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: 0 })).reason, 'unknown-activity');
  assert.equal(shouldWakeStall(stalled({ lastActiveAt: Number.NaN })).reason, 'unknown-activity');
});

test('7.16.0：唤醒文本要说清"没有通知会来"并给出可执行动作', () => {
  const text = buildStallNotice({ idleMinutes: 11, openWork: 3 });
  assert.ok(text.includes('停滞看门狗'), text);
  assert.ok(text.includes('11 分钟'), text);
  assert.ok(text.includes('3 项'), text);
  assert.ok(text.includes('没有下级在跑'), text);
  assert.ok(text.includes('send_message'), text);
  assert.ok(text.includes('subagent'), text);
  // 不允许用"继续"一句糊过去
  assert.ok(text.includes('不要只回一句'), text);
});
