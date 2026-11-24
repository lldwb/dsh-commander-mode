/**
 * 「指挥者 · CC 模式」（7.26.0）的测试。
 *
 * ## 这个模式是什么
 *
 * 用户 2026-11-20 要求：给指挥者模式加一个 CC 变体，**小组长那一层不派 DSH 子智能体，
 * 改派 Claude Code 会话**（`subagent_claude_code`）。
 *
 * ## 为什么必须测这四组
 *
 * 1. **变体判定**：两个 preset 共用同一个模式行（`dsh-commander-mode/agent`），差异只来自
 *    会话头的 `agentPreset`。判错的后果是"普通指挥者模式的小组长被禁掉 L1→L2"，整条链断掉。
 * 2. **深度门禁**：`subagent` 既是"指挥官建小组长"的通道，也是"小组长建子智能体"的通道，
 *    所以只能按 agent 层级收紧 —— 必须证明**只拦子级、不拦指挥官**。
 * 3. **CC 通道不被误伤**：`subagent_claude_code` 长着 `subagent_<id>` 的名字，第一版就被
 *    `isSpecialistDispatchTool()` 当成名册专家拦掉了（真实踩过），必须钉死放行。
 * 4. **协议差异**：指挥官要知道下级换成了 CC；小组长要知道任务书必须自包含、CC 不能追问。
 *    原生模式下这两段都不能出现（否则 token 白烧、还教它一个不存在的用法）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CC_PRESET_ID,
  DELEGATION_VARIANTS,
  delegationVariantOf,
  normalizeVariant,
  presetIdOf,
} from '../lib/mode-variant.js';
import {
  evaluateCcDelegation,
  evaluateCcExecution,
  isCcExecutionTool,
  isDshDelegationTool,
} from '../lib/guard.js';
import {
  CC_LEAD_BRIEF,
  renderCcLeadBrief,
  renderCommanderSection,
} from '../lib/protocol.js';

/** 造一个最小 agent（只需要会话头）。 */
function agentOf(preset, depth = 0) {
  return { id: `session-${preset}-${depth}`, session: { id: `session-${preset}-${depth}`, header: { agentPreset: preset, delegationDepth: depth } } };
}

test('7.26.0：变体按 preset id 判定，读不到时退回 native', () => {
  assert.equal(CC_PRESET_ID, 'commander-cc');
  assert.deepEqual([...DELEGATION_VARIANTS], ['native', 'cc']);

  assert.equal(delegationVariantOf(agentOf('commander-cc')), 'cc');
  assert.equal(delegationVariantOf(agentOf('commander-cc', 1)), 'cc');
  assert.equal(delegationVariantOf(agentOf('commander')), 'native');
  assert.equal(delegationVariantOf(agentOf('standard')), 'native');
  // 任何 `*-cc` 变体都算（将来加模式不必改代码）
  assert.equal(delegationVariantOf(agentOf('interview-cc')), 'cc');

  // 读不到身份 → native（宁可少拦，不能把普通模式的小组长链切掉）
  assert.equal(delegationVariantOf(undefined), 'native');
  assert.equal(delegationVariantOf({}), 'native');
  assert.equal(delegationVariantOf({ session: { header: {} } }), 'native');
  assert.equal(presetIdOf(agentOf('commander-cc')), 'commander-cc');
  assert.equal(presetIdOf({}), undefined);

  assert.equal(normalizeVariant('cc'), 'cc');
  assert.equal(normalizeVariant('native'), 'native');
  assert.equal(normalizeVariant(undefined), 'native');
  assert.equal(normalizeVariant('CC'), 'native', '大小写不敏感不是需求，别猜');
});

test('7.26.0：CC 模式下小组长的 DSH 委派被拒，指挥官的照旧放行', () => {
  const root = agentOf('commander-cc', 0);
  const lead = agentOf('commander-cc', 1);

  // 小组长：所有 DSH 委派通道都被拒
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'subagent_architect', 'commander_worker_spawn']) {
    const decision = evaluateCcDelegation({ agent: lead, name, variant: 'cc' });
    assert.equal(decision?.kind, 'deny', `${name} 应当被拒`);
    assert.ok(decision.reason.includes('subagent_claude_code'), '拒绝理由必须点名可用的 CC 通道');
  }

  // 小组长：CC 通道与控制类工具必须放行
  for (const name of ['subagent_claude_code', 'send_message', 'list_agents', 'interrupt_agent', 'team_task_list', 'read', 'write', 'pwsh']) {
    assert.equal(evaluateCcDelegation({ agent: lead, name, variant: 'cc' }), undefined, `${name} 应当放行`);
  }

  // 指挥官本人不受影响（它要能建小组长）
  assert.equal(evaluateCcDelegation({ agent: root, name: 'subagent', variant: 'cc' }), undefined);
  assert.equal(evaluateCcDelegation({ agent: root, name: 'workflow', variant: 'cc' }), undefined);

  // 原生模式一整条不受影响
  const nativeLead = agentOf('commander', 1);
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'subagent_architect']) {
    assert.equal(evaluateCcDelegation({ agent: nativeLead, name, variant: 'native' }), undefined);
  }
});

test('7.26.0：`subagent_claude_code` 不能被当成名册专家（第一版真踩过）', () => {
  // 它匹配 `subagent_<id>` 的形状，但语义完全不同：外部 CC 会话，不是 DSH 子代理。
  assert.equal(isDshDelegationTool('subagent_claude_code'), false);
  assert.equal(isDshDelegationTool('subagent_architect'), true);
  assert.equal(isDshDelegationTool('subagent'), true);
  assert.equal(isDshDelegationTool('subagent_fork'), true);
  assert.equal(isDshDelegationTool('workflow'), true);
  assert.equal(isDshDelegationTool('read'), false);
});

test('7.26.0：协议 —— CC 变体改写"团队模型"，原生模式一字不改', () => {
  const cc = renderCommanderSection({ delegation: 'cc' });
  const native = renderCommanderSection({});

  assert.ok(cc.includes('团队模型：指挥官 → 小组长 → Claude Code 会话'), 'CC 模式的团队模型要写 CC');
  assert.ok(cc.includes('本模式的下级通道：小组长 → Claude Code 会话（一次性）'), cc.slice(0, 200));
  assert.ok(cc.includes('自包含'), '要强调任务书自包含');
  assert.ok(cc.includes('不能追问') || cc.includes('一次性'), '要强调不可追问');

  assert.ok(native.includes('团队模型：指挥官 → 小组长 → 子智能体'), '原生模式保持原样');
  assert.equal(native.includes('Claude Code 会话'), false, '原生模式不该出现 CC 字样');
  assert.ok(native.length < cc.length, 'CC 模式应当比原生多一段');

  // 明确"没有 CC 工具"时要在协议里点名告警，而不是让小组长空转
  const degraded = renderCommanderSection({ delegation: 'cc', hasCcDelegate: false });
  assert.ok(degraded.includes('没有检测到 `subagent_claude_code`'), degraded.slice(-300));
  const unknown = renderCommanderSection({ delegation: 'cc', hasCcDelegate: undefined });
  assert.equal(unknown.includes('没有检测到'), false, '读不到工具视图时不要瞎告警');
});

test('7.27.0：CC 模式下小组长不许自己实现（write/edit），验收手段仍放行', () => {
  const root = agentOf('commander-cc', 0);
  const lead = agentOf('commander-cc', 1);
  const nativeLead = agentOf('commander', 1);

  // 实现动作：只拦 CC 模式的小组长
  for (const name of ['write', 'edit', 'apply_patch']) {
    const decision = evaluateCcExecution({ agent: lead, name, variant: 'cc' });
    assert.equal(decision?.kind, 'deny', `${name} 应当被拒（活要交给 CC）`);
    assert.ok(decision.reason.includes('subagent_claude_code'), '拒因必须点名 CC 通道');
    assert.ok(decision.reason.includes('任务书'), '拒因要告诉它写任务书');
    assert.equal(evaluateCcExecution({ agent: root, name, variant: 'cc' }), undefined, '指挥官本来就被执行边界拦，本函数不重复管');
    assert.equal(evaluateCcExecution({ agent: nativeLead, name, variant: 'native' }), undefined, '原生模式不受影响');
  }

  // 验收与派活：放行
  for (const name of ['read', 'grep', 'glob', 'pwsh', 'bash', 'subagent_claude_code', 'send_message']) {
    assert.equal(evaluateCcExecution({ agent: lead, name, variant: 'cc' }), undefined, `${name} 应当放行`);
  }

  assert.equal(isCcExecutionTool('write'), true);
  assert.equal(isCcExecutionTool('pwsh'), false, 'pwsh 是验收手段，不能拦');
});

test('7.27.0：协议要求"能交给 CC 的活尽量交给 CC"', () => {
  const cc = renderCommanderSection({ delegation: 'cc' });
  assert.ok(cc.includes('CC 产能纪律'), '指挥官协议要有产能纪律');
  assert.ok(cc.includes('能整块交给 CC 的活，就别切碎'));
  assert.ok(cc.includes('这一单由 CC 执行'));

  assert.ok(CC_LEAD_BRIEF.includes('活交给 Claude Code 会话去干'), '小组长 brief 要写明默认分工');
  assert.ok(CC_LEAD_BRIEF.includes('第一反应是写任务书'), '小组长 brief 要压住"自己上手"');
  assert.ok(CC_LEAD_BRIEF.includes('原始输出'), '要让 CC 自己出证据（避免小组长重跑）');
});

test('7.26.0：小组长 brief 只在 CC 模式出现（原生模式子级仍然空串）', () => {
  assert.ok(CC_LEAD_BRIEF.includes('小组长'));
  assert.ok(CC_LEAD_BRIEF.includes('subagent_claude_code'));
  assert.ok(CC_LEAD_BRIEF.includes('一次性'));
  assert.ok(CC_LEAD_BRIEF.length < 1200, `brief 要短（实耗 token），实际 ${CC_LEAD_BRIEF.length} 字符`);

  // 有工具：就是 brief 本体
  assert.equal(renderCcLeadBrief({ hasCcDelegate: true }), CC_LEAD_BRIEF);
  // 读不到：不告警
  assert.equal(renderCcLeadBrief({}), CC_LEAD_BRIEF);
  // 明确没有：追加告警
  const warned = renderCcLeadBrief({ hasCcDelegate: false });
  assert.ok(warned.startsWith(CC_LEAD_BRIEF));
  assert.ok(warned.includes('没有检测到 `subagent_claude_code`'));
});
