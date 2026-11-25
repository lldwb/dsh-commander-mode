/**
 * 重启后续做（7.28.0）的测试。
 *
 * ## 用户诉求（2026-11-25）
 *
 * 「如果重启后应该复用之前被停止的会话，而不是单独开。比如用户说电脑重启或者应用重启之类的话。」
 *
 * ## 钉什么
 *
 * 1. **只认可续做的直接子级**：`kind === 'child'`、`depth === 1`、`mode === 'continuable'`。
 *    孙级（depth 2）与 diagnostic 行不能进清单 —— 恢复通道只对直接子级有效。
 * 2. **离线/在线分组**：在线的不该进"别新开"的清单（它还在干活）。
 * 3. **离线 ≠ 被中断**：提示必须写清"已完成并结算的也会离线，别浪费恢复"，否则模型会把
 *    做完的子代理再唤醒一遍。
 * 4. **没有离线子级时一个字都不输出**（每轮上下文，不能有噪音/token 成本）。
 * 5. **读不到活 Agent 时按离线处理**（宁可多报一条清单，也不要漏掉可复用的人）。
 * 6. **协议要覆盖"用户提一句重启"这条路**：用户常常只说一句「电脑重启过了，继续」，
 *    证据（离线下级清单）在上下文里，规则在 section 里，两者必须能对上。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REBOOT_RESUME_TITLE,
  isContinuableChild,
  renderRebootResumeNotice,
  snapshotChildren,
  splitChildren,
} from '../lib/reboot-resume.js';
import { REBOOT_RESUME_RULES, renderCommanderSection } from '../lib/protocol.js';

/** 一行可续做子级。 */
const child = (id, path, extra = {}) => ({ kind: 'child', depth: 1, id, path, mode: 'continuable', activity: 'inactive', ...extra });

test('7.28.0：只认"可直接续做的直接子级"', () => {
  assert.equal(isContinuableChild(child('s1', 'a')), true);
  // 孙级：恢复通道只对直接子级有效
  assert.equal(isContinuableChild({ ...child('s2', 'a/b'), depth: 2 }), false);
  // diagnostic 行不是可续做子代理
  assert.equal(isContinuableChild({ kind: 'diagnostic', depth: 1, id: 's3' }), false);
  // 不可续做的 mode
  assert.equal(isContinuableChild(child('s4', 'c', { mode: 'oneshot' })), false);
  // 没有 id / 非对象
  assert.equal(isContinuableChild({ kind: 'child', depth: 1, mode: 'continuable' }), false);
  assert.equal(isContinuableChild(null), false);
  assert.equal(isContinuableChild(42), false);
  // mode 缺省时按可续做处理（rc.5 可能不填）
  assert.equal(isContinuableChild({ kind: 'child', depth: 1, id: 's5' }), true);
});

test('7.28.0：离线/在线分组（在线的不进"别新开"清单）', () => {
  const rows = [
    child('s1', 'lead-a'),
    child('s2', 'lead-b', { activity: 'running' }),
    { ...child('s3', 'lead-a/worker'), depth: 2 },
    { kind: 'diagnostic', depth: 1, id: 's4' },
  ];
  const { offline, online } = splitChildren(rows, (id) => id === 's2');
  assert.deepEqual(offline.map((item) => item.name), ['lead-a']);
  assert.deepEqual(online.map((item) => item.name), ['lead-b']);
  assert.deepEqual(offline[0], { id: 's1', name: 'lead-a' });

  // 读不到活 Agent（抛错）→ 按离线处理
  const throwing = splitChildren([child('s1', 'lead-a')], () => { throw new Error('boom'); });
  assert.equal(throwing.offline.length, 1, '读不到就按离线报，不能漏');

  // 没有 path 时用 name，再没有就用 id
  const noPath = splitChildren([{ kind: 'child', depth: 1, id: 's9', name: 'named', mode: 'continuable' }], () => false);
  assert.equal(noPath.offline[0].name, 'named');
  const bare = splitChildren([{ kind: 'child', depth: 1, id: 's10', mode: 'continuable' }], () => false);
  assert.equal(bare.offline[0].name, 's10');
});

test('7.28.0：没有离线下级时一个字都不输出', () => {
  assert.equal(renderRebootResumeNotice({ offline: [] }), '');
  assert.equal(renderRebootResumeNotice({}), '');
  assert.equal(renderRebootResumeNotice({ offline: [], online: [{ id: 's2', name: 'lead-b' }] }), '');
  assert.equal(renderRebootResumeNotice({ offline: [null, {}] }), '', '脏数据也不输出');
});

test('7.28.0：提示要点名下级、给出 resume 顺序、并警告"已完成的不必恢复"', () => {
  const text = renderRebootResumeNotice({
    offline: [{ id: 's1', name: 'lead-a' }, { id: 's2', name: 'lead-b' }],
    online: [{ id: 's3', name: 'lead-c' }],
  });
  assert.ok(text.startsWith(REBOOT_RESUME_TITLE));
  assert.ok(text.includes('2 个下级会话离线'));
  assert.ok(text.includes('`lead-a`') && text.includes('`s1`'));
  assert.ok(text.includes('session_resume_subagents'), '必须点名恢复工具');
  assert.ok(text.includes('dryRun'), '要先 dryRun 看清单');
  assert.ok(text.includes('完成'), '要警告已完成的不需要恢复');
  assert.ok(text.includes('lead-c'), '在线的要单独说明可以直接 send_message');

  // 超过 8 个要截断并且说明还有多少
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, name: `n${i}` }));
  const long = renderRebootResumeNotice({ offline: many });
  assert.ok(long.includes('还有 3 个'), long.slice(-200));

  // 没有 resume 工具时不能教它调一个不存在的工具
  const noTool = renderRebootResumeNotice({ offline: [{ id: 's1', name: 'lead-a' }], resumeToolPresent: false });
  assert.equal(noTool.includes('`session_resume_subagents`'), false);
  assert.ok(noTool.includes('不要另开'), noTool);
});

test('7.28.0：快照直通 splitChildren（同一份 listDescendants 结果两用）', () => {
  const rows = [child('s1', 'a'), child('s2', 'b')];
  const snap = snapshotChildren(rows, (id) => id === 's2');
  assert.deepEqual(snap.offline.map((item) => item.id), ['s1']);
  assert.deepEqual(snap.online.map((item) => item.id), ['s2']);
});

test('7.28.0：协议里要有"用户提重启 → 先复用"的规则（两种模式都要有）', () => {
  assert.ok(Array.isArray(REBOOT_RESUME_RULES));
  assert.equal(REBOOT_RESUME_RULES.length, 4);

  for (const [label, options] of [['原生', {}], ['CC', { delegation: 'cc' }]]) {
    const text = renderCommanderSection(options);
    assert.ok(text.includes('重启后续做：先复用被停止的下级，别新开'), `${label} 模式缺重启规则段`);
    assert.ok(text.includes('session_resume_subagents'), `${label} 模式要点名恢复工具`);
    assert.ok(text.includes('dryRun'), `${label} 模式要先列清单`);
    assert.ok(text.includes('上一棒'), `${label} 模式要写交接信息`);
  }
});
