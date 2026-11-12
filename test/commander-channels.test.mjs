/**
 * 7.0.0 派发通道硬门禁的测试（`lib/guard.js` 的 `evaluateCommanderChannels()`）。
 *
 * ## 用户要求（逐字）
 *
 * 「不能出现这种另辟蹊径开子智能体的方法，需要把这种指挥官->小组长->小组长的手下 这种
 * 分发没问题」；口径已明确：**连 Worker Session 一起禁**。
 *
 * ## 现场（两次真实会话）
 *
 * - `session-2cd6ae3c`：指挥者在 Worker 停滞被停掉后，向用户推荐「改用 specialist 分 4 路」
 *   —— 直接用名册生成的 `subagent_<id>` 开 4 个子智能体，**跳过小组长层**；
 * - `session-fb21d6a0`：`subagent_implementer` 报内部错误后，指挥者取消工单、新建工单、
 *   **换到 Worker Session** 继续 —— 每一步都"看起来在解决问题"，但整条小组长层被跳过。
 *
 * ## 本文件钉住四件事
 *
 * 1. **拒绝面**：指挥官（root agent）调 `workflow` / `subagent_<id>` / `commander_worker_*`
 *    一律 deny；
 * 2. **放行面**：小组长 / 子智能体（`isDelegatedAgent` 命中）调同样工具一律放行 ——
 *    它们派自己的手下是 L1→L2，用户明确认可；
 * 3. **不可配置**：`delegationHierarchy: false` 也拦（没有开关）；
 * 4. **拒因是纠正指令**：必须写清「只建小组长」+「需要小组长 / 小组长失败」的唯一恢复阶梯
 *    +「任何一步都不许换通道」（用户 2026-11-12 追问过 session-fb21d6a0 的恢复路径）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDER_DISPATCH_TOOLS,
  COMMANDER_FORBIDDEN_DISPATCH,
  COMMANDER_WORKER_TOOL_PREFIX,
  buildCommanderChannelReason,
  evaluateCommanderChannels,
  isCommanderForbiddenChannel,
} from '../lib/guard.js';
import { LEAD, SUBAGENT, TEAMMATE } from './helpers.mjs';

/** 断言被拒绝并返回理由。 */
function denyReason(decision, label) {
  assert.ok(decision !== undefined, `${label} 应当被拒绝，实际放行了`);
  assert.equal(decision.kind, 'deny');
  assert.equal(typeof decision.reason, 'string');
  assert.ok(decision.reason.length > 0, '拒绝理由不能为空（它是给模型的纠正指令）');
  return decision.reason;
}

/** 断言放行（`undefined` = 放行）。 */
function allows(decision, label) {
  assert.equal(decision, undefined, `${label} 应当放行，实际被拒绝：${decision?.reason}`);
}

// ---------------------------------------------------------------- 常量 ---

test('7.0.0 常量：只有 workflow 在硬禁用清单里，Worker 前缀单独导出', () => {
  assert.deepEqual([...COMMANDER_FORBIDDEN_DISPATCH], ['workflow']);
  assert.equal(Object.isFrozen(COMMANDER_FORBIDDEN_DISPATCH), true);
  assert.equal(COMMANDER_WORKER_TOOL_PREFIX, 'commander_worker_');
  // 唯一允许的通道清单：建小组长 + 派活 + 任务板 + 读状态 + 纠偏。
  for (const name of ['subagent', 'subagent_fork', 'send_message', 'team_task_create', 'list_agents', 'interrupt_agent']) {
    assert.ok(COMMANDER_DISPATCH_TOOLS.includes(name), `允许清单缺 ${name}`);
  }
  // 被禁的通道绝不能在允许清单里。
  for (const name of ['workflow', 'commander_worker_spawn']) {
    assert.ok(!COMMANDER_DISPATCH_TOOLS.includes(name), `允许清单不得含 ${name}`);
  }
});

test('7.0.0 isCommanderForbiddenChannel：三类通道 + 不误伤 Team 建人工具', () => {
  // ① workflow
  assert.equal(isCommanderForbiddenChannel('workflow'), true);
  // ② 名册生成的一次性专家
  assert.equal(isCommanderForbiddenChannel('subagent_architect'), true);
  assert.equal(isCommanderForbiddenChannel('subagent_doc-writer'), true);
  // ③ Worker Session
  for (const name of ['commander_worker_spawn', 'commander_worker_send', 'commander_worker_status', 'commander_worker_stop']) {
    assert.equal(isCommanderForbiddenChannel(name), true, `${name} 属于 Worker 通道`);
  }
  // Team 建人 / 派活 / 任务板 / 读状态 / 纠偏 —— 都不是被禁通道。
  for (const name of ['subagent', 'subagent_fork', 'send_message', 'team_task_create', 'team_task_update', 'list_agents', 'interrupt_agent', 'commander_ticket_update', 'read', 'write', '']) {
    assert.equal(isCommanderForbiddenChannel(name), false, `${name} 不应被识别为被禁通道`);
  }
  // 非字符串输入不抛错（门禁在工具调用路径上，抛错会让调用整体失败）。
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isCommanderForbiddenChannel(value), false);
  }
});

// ---------------------------------------------------------------- 拒绝面 ---

test('7.0.0：指挥官调 workflow / subagent_<id> / commander_worker_* 一律被拒', () => {
  for (const name of ['workflow', 'subagent_architect', 'subagent_implementer', 'commander_worker_spawn', 'commander_worker_send', 'commander_worker_status', 'commander_worker_stop']) {
    const reason = denyReason(evaluateCommanderChannels({ agent: LEAD, name }), `Lead 调 ${name}`);
    // 拒因必须点名被拦工具 + 唯一出路 + 不许换通道。
    assert.ok(reason.includes(name), `${name} 的拒因应点名被拦工具：${reason}`);
    assert.ok(reason.includes('建小组长'), `${name} 的拒因应给出「建小组长」：${reason}`);
    assert.ok(reason.includes('不要换通道'), `${name} 的拒因应说明「不要换通道」：${reason}`);
    assert.ok(reason.includes('subagent'), `${name} 的拒因应给出 subagent 出路：${reason}`);
    assert.ok(reason.includes('send_message'), `${name} 的拒因应给出 send_message 出路：${reason}`);
  }
});

test('7.0.0：指挥官的唯一通道（subagent / send_message / team_task_* / list_agents / interrupt_agent）放行', () => {
  for (const name of COMMANDER_DISPATCH_TOOLS) {
    allows(evaluateCommanderChannels({ agent: LEAD, name }), `Lead 的 ${name}`);
  }
  // 其它工具（只读 / 执行类）不由这条门禁管 —— 它们各自由执行边界等门禁处理。
  for (const name of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question', 'write', 'pwsh', 'wait_agent']) {
    allows(evaluateCommanderChannels({ agent: LEAD, name }), `Lead 的 ${name}`);
  }
});

// ---------------------------------------------------------------- 放行面 ---

test('7.0.0：小组长 / 子智能体调同样工具一律放行（L1→L2 是用户认可的链路）', () => {
  const forbidden = ['workflow', 'subagent_architect', 'commander_worker_spawn'];
  for (const [label, agent] of [['小组长', TEAMMATE], ['子智能体', SUBAGENT]]) {
    for (const name of forbidden) {
      allows(evaluateCommanderChannels({ agent, name }), `${label} 的 ${name}`);
    }
  }
});

test('7.0.0：身份读不到时按既有纪律放行（isDelegatedAgent fail-open）', () => {
  // 与其它门禁同一方向：宁可漏拦，不可拦死。拦错小组长的代价是它派不了自己的手下
  // （L1→L2 断链）；而指挥官的身份在真实运行时总是可读的（根会话有 session.header）。
  for (const agent of [undefined, null, {}, { session: {} }, { session: { header: null } }]) {
    allows(evaluateCommanderChannels({ agent, name: 'workflow' }), `身份读不到（${JSON.stringify(agent)}）`);
  }
});

// ---------------------------------------------------------------- 不可配置 ---

test('7.0.0：delegationHierarchy:false 也不能放开（本门禁不读任何配置）', () => {
  // `evaluateCommanderChannels` 的签名里**没有**任何配置项 —— 这是"不可配置"的结构性证据。
  // 传一个旧配置键也不会改变判定。
  for (const name of ['workflow', 'subagent_architect', 'commander_worker_spawn']) {
    for (const extra of [{ delegationHierarchy: false }, { blockedTools: [] }, { maxWaitMs: 0 }]) {
      denyReason(
        evaluateCommanderChannels({ agent: LEAD, name, ...extra }),
        `Lead 的 ${name}（${JSON.stringify(extra)}）`,
      );
    }
  }
});

// ---------------------------------------------------------------- 拒因内容 ---

test('7.0.0：拒因包含「需要小组长 / 小组长失败」的唯一恢复阶梯', () => {
  // 用户 2026-11-12 追问「如果遇到需要小组长怎么办，比如 session-fb21d6a0 这种会话」。
  // 阶梯五步都必须出现在拒因里，否则模型在失败之后又会"另辟蹊径"。
  const reason = buildCommanderChannelReason({
    toolName: 'subagent_implementer',
    availableTools: ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'team_task_list', 'interrupt_agent'],
  });
  for (const phrase of [
    '需要小组长',
    '`subagent`',
    '`subagent_fork`',
    '`send_message`',
    'inactive',
    '不要新建',
    '停滞',
    '失败',
    '只读核对产物',
    '`interrupt_agent`',
    '接管同一张工单',
    '`blocked`',
    '内部错误',
    '重试一次',
    '任何一步都不许换通道',
    '不要换通道',
  ]) {
    assert.ok(reason.includes(phrase), `拒因缺少恢复阶梯要素：${phrase}\n${reason}`);
  }
  // 明确点名三类被禁通道（否则模型不知道"换通道"指什么）。
  for (const phrase of ['workflow', '一次性专家', 'Worker Session', 'commander_worker_*']) {
    assert.ok(reason.includes(phrase), `拒因应点名被禁通道：${phrase}\n${reason}`);
  }
  // 说明子任务由小组长再派（L1→L2 不受限），避免模型把"禁"理解成"整条链都不许派"。
  assert.ok(reason.includes('子任务由**小组长自己**再派给它的手下'), reason);
});

test('7.0.0：拒因按实际可用工具生成，不点名 agent 没有的工具', () => {
  // 沿用 buildDenialReason 的既有纪律：点名一个不存在的工具会让模型当场卡住。
  const bare = buildCommanderChannelReason({ toolName: 'workflow', availableTools: ['read', 'glob'] });
  assert.ok(!bare.includes('`subagent`'), `不该点名没有的 subagent：${bare}`);
  assert.ok(!bare.includes('`send_message`'), `不该点名没有的 send_message：${bare}`);
  assert.ok(bare.includes('请用户决定'), '没有任何建人工具时要给逃生口');
  assert.ok(bare.includes('不要换通道'), '仍要说明不要换通道');

  // 视图未知（undefined）时按"都有"生成完整指引。
  const unknown = buildCommanderChannelReason({ toolName: 'workflow' });
  assert.ok(unknown.includes('`subagent`'), unknown);
  assert.ok(unknown.includes('`send_message`'), unknown);

  // 只有 subagent（没有 send_message）时点名 subagent、不点名 send_message。
  const spawnOnly = buildCommanderChannelReason({ toolName: 'workflow', availableTools: ['read', 'subagent'] });
  assert.ok(spawnOnly.includes('`subagent`'), spawnOnly);
  assert.ok(!spawnOnly.includes('`send_message`'), spawnOnly);
});

// ---------------------------------------------------------------- 异常 ---

test('7.0.0：门禁吞掉自身异常（放行而不是让工具调用失败）', () => {
  const hostileAgent = {
    get session() {
      throw new Error('boom');
    },
  };
  // agent 抛错 → isDelegatedAgent 内部 catch 返回 true → 放行（既有方向）。
  allows(evaluateCommanderChannels({ agent: hostileAgent, name: 'workflow' }), 'agent 抛错');
  // 非法 name 不抛错。
  for (const name of [undefined, null, 42, {}, []]) {
    allows(evaluateCommanderChannels({ agent: LEAD, name }), `非法 name（${JSON.stringify(name)}）`);
  }
});

// ------------------------------------------------ model-facing 文案（grep 证明） ---
//
// 任务要求：把「Worker Session」「workflow 扇出」「一次性 specialist」从**指挥官的派发通道**里
// 全部移除。这里用文本扫描把"没有残留的指挥官指引"钉死 —— 比人肉 grep 可重复。

import { COMMANDER_PROTOCOL, renderCommanderSection } from '../lib/protocol.js';
import { TEAM_MODEL, TEAM_MODEL_BRIEF } from '../lib/team-model.js';
import { WORK_DISCIPLINE, WORK_DISCIPLINE_BRIEF } from '../lib/discipline.js';
import { WORKFLOW_PROTOCOL } from '../lib/workflow.js';

test('7.0.0 文案：不再有任何「指挥官用 workflow / Worker / 一次性专家派活」的指令', () => {
  // 旧的"换通道"口径：`workflow` 曾是指挥官的最后一条路。
  const oldPhrases = [
    '改用 `workflow`',
    '用 `workflow` 把这一步',
    '用 `workflow` 扇出',
    '用 `workflow` 把',
    '通道不通就换通道（Team ↔ workflow）',
    '改用 `commander_worker_spawn`',
    '改用 `commander_worker_`',
    '长任务用 Worker Session',
    '一工单一 Worker',
    'Worker 汇报仍要验收',
    '### 异步派工',
    '### Worker Session（0.8.0',
    '派发通道：两条，你只走',
  ];
  const texts = {
    'section（默认）': renderCommanderSection(),
    'section（名册）': renderCommanderSection({
      specialists: [{ id: 'architect', provider: 'deepseek', model: 'deepseek-reasoner', description: '架构' }],
      hasSpecialistTools: true,
    }),
    '长文协议': COMMANDER_PROTOCOL,
    '团队模型': TEAM_MODEL,
    '团队模型紧凑版': TEAM_MODEL_BRIEF.join('\n'),
    '工作纪律': WORK_DISCIPLINE,
    '工作纪律紧凑版': WORK_DISCIPLINE_BRIEF,
    '工作流手册': WORKFLOW_PROTOCOL,
  };
  for (const [label, text] of Object.entries(texts)) {
    for (const phrase of oldPhrases) {
      assert.ok(!text.includes(phrase), `${label} 仍有旧口径：${phrase}`);
    }
  }
});

test('7.0.0 文案：三份正文都写出「不换通道 + 恢复阶梯」', () => {
  // 用户 2026-11-12 追问过 session-fb21d6a0 的恢复路径，所以这条必须同时进
  // 每轮注入的 section、skill 长文与工作纪律（模型看不到 README）。
  const texts = {
    'section': renderCommanderSection(),
    '长文协议': COMMANDER_PROTOCOL,
    '团队模型': TEAM_MODEL,
    '工作纪律': WORK_DISCIPLINE,
  };
  for (const [label, text] of Object.entries(texts)) {
    assert.ok(text.includes('不要换通道'), `${label} 缺「不要换通道」`);
    assert.ok(text.includes('需要小组长') || text.includes('需要小组长时'), `${label} 缺恢复阶梯的起点`);
    assert.ok(text.includes('subagent'), `${label} 缺建小组长的工具`);
  }
  // 恢复阶梯的四步细节（建人 / 冷恢复 / 换人接管 / 报错重试）在 section 与长文里。
  for (const [label, text] of Object.entries({ 'section': renderCommanderSection(), '长文协议': COMMANDER_PROTOCOL })) {
    for (const phrase of ['inactive', '接管同一张工单', 'blocked', '重试一次']) {
      assert.ok(text.includes(phrase), `${label} 的恢复阶梯缺：${phrase}`);
    }
  }
});

