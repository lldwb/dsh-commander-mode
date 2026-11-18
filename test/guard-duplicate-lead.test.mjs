/**
 * 「不许重复建小组长」的测试（`lib/guard.js`，7.17.0 新增）。
 *
 * ## 现场（`session-1d8c8c60`，用户 2026-11-18 指出）
 *
 * 三处重复建人：
 *
 * | 时间 | 事件 |
 * |---|---|
 * | 11-16 11:09 / 11:14 | `criteria-table-lead` **同名建两次**（定位都是「切分判据决策表」） |
 * | 11-17 13:50 → 15:45 | `ordinal-detect-lead` → `ordinal-scheme-lead`，**定位一字不差**（换名绕过同名保护） |
 * | 11-18 01:24 → 02:53 | `feedback-1117-lead` → `feedback-doc-lead`；用户纠正后 94 秒改成 `send_message` |
 *
 * 最后一起是用户原话：「**不是应该安排 feedback-1117-lead 吗？**」——
 * 证明复用完全可行，模型只是**一开始没查谁在做**。
 *
 * ## 判据与边界
 *
 * 定位（`prompt` 里「你是「X」」的 X）最长公共子串 ≥ 4 个字符 → 判为同一功能。
 * 实测：`「11月17日客户反馈分析」` vs `「补出 11/17 客户反馈清单」` 共享「客户反馈」= 4 命中；
 * `「8 个模块补登记」` vs `「模块拆分」` 只共享「模块」= 2 不命中（不误伤）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUPLICATE_LEAD_MIN_OVERLAP,
  evaluateDuplicateLead,
  extractLeadRole,
  longestCommonSubstring,
} from '../lib/guard.js';

test('7.17.0：从 prompt 抽出「你是「X」小组长」里的定位', () => {
  assert.equal(extractLeadRole('你是「切分判据决策表」小组长。工作目录...'), '切分判据决策表');
  assert.equal(extractLeadRole('  [ticket:t-453]\n\n你是「11月17日客户反馈分析」小组长。'), '11月17日客户反馈分析');
  // 抽不到 → 空串（不能瞎猜）
  assert.equal(extractLeadRole('没有定位的 prompt'), '');
  assert.equal(extractLeadRole(undefined), '');
  assert.equal(extractLeadRole(42), '');
});

test('7.17.0：最长公共子串按字符算', () => {
  assert.equal(longestCommonSubstring('abc', 'abc'), 3);
  assert.equal(longestCommonSubstring('客户反馈分析', '客户反馈清单'), 4);
  assert.equal(longestCommonSubstring('模块补登记', '模块拆分'), 2);
  assert.equal(longestCommonSubstring('', 'x'), 0);
  assert.equal(longestCommonSubstring('甲乙', '丙丁'), 0);
});

test('7.17.0：真实案例 —— feedback 那两个 lead 必须被判成重复', () => {
  // 用户原话：「不是应该安排 feedback-1117-lead 吗？」
  const known = new Map([['feedback-1117-lead', '11月17日客户反馈分析']]);
  const decision = evaluateDuplicateLead({
    prompt: '你是「补出 11/17 客户反馈清单」小组长。工作目录 `E:\\顺灵 Boardmate`...',
    knownLeads: known,
  });
  assert.ok(decision, '这两个定位共享「客户反馈」，应判重复');
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes('feedback-1117-lead'), decision.reason);
  // 必须给出复用动作，并且说明"inactive 也能冷恢复"
  assert.ok(decision.reason.includes('send_message'), decision.reason);
  assert.ok(decision.reason.includes('冷恢复'), decision.reason);
  // 必须点明"别换名绕过"
  assert.ok(decision.reason.includes('换'), decision.reason);
});

test('7.17.0：换名绕过必须被拦（ordinal-detect-lead → ordinal-scheme-lead）', () => {
  const known = new Map([['ordinal-detect-lead', '序号检测：方案B + 视觉兜底']]);
  const decision = evaluateDuplicateLead({
    prompt: '你是「序号检测：方案B + 视觉兜底」小组长。',
    knownLeads: known,
  });
  assert.ok(decision, '定位一字不差，换名字也必须拦');
  assert.ok(decision.reason.includes('ordinal-detect-lead'), decision.reason);
});

test('7.17.0：定位确实不同 → 放行（不能把正常派活也拦了）', () => {
  const known = new Map([
    ['feedback-1117-lead', '11月17日客户反馈分析'],
    ['criteria-table-lead', '切分判据决策表'],
  ]);
  for (const prompt of [
    '你是「安装器进度条修复」小组长。',
    '你是「全局白板加载并发池」小组长。',
    '你是「8 个模块补登记」小组长。', // 与「模块拆分」只共享 2 字，不误伤
  ]) {
    assert.equal(evaluateDuplicateLead({ prompt, knownLeads: known }), undefined, `不该拦：${prompt}`);
  }
});

test('7.17.0：没有已知 lead / 抽不到定位 → 放行（信息不足不乱拦）', () => {
  assert.equal(evaluateDuplicateLead({ prompt: '你是「X」小组长', knownLeads: new Map() }), undefined);
  assert.equal(evaluateDuplicateLead({ prompt: '你是「X」小组长', knownLeads: {} }), undefined);
  assert.equal(evaluateDuplicateLead({ prompt: '没有定位', knownLeads: new Map([['a', '定位']]) }), undefined);
  assert.equal(evaluateDuplicateLead({}), undefined);
});

test('7.17.0：阈值是 4 —— 3 个字的重合不拦，4 个字才拦', () => {
  assert.equal(DUPLICATE_LEAD_MIN_OVERLAP, 4);
  const known = new Map([['a', '客户反馈清单文档']]);
  // 「反馈清单」4 字 → 命中
  assert.ok(evaluateDuplicateLead({ prompt: '你是「反馈清单整理」小组长', knownLeads: known }));
  // 「客户反」3 字 → 不命中
  assert.equal(evaluateDuplicateLead({ prompt: '你是「客户反X」小组长', knownLeads: known }), undefined);
});
