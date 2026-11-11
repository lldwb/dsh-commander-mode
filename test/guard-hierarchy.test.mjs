/**
 * 三层指挥链的**确定性门禁**测试（`lib/guard.js` 的 3.0.0 新增部分）。
 *
 * 用户 2026-11-11 的规则 4 与规则 3 不是"建议"：它们由 `tools/pre-execute` 上的三条
 * 判定函数确定性执行 —— 指挥官（Lead）自己改任务板进展 / 工单推进状态 / 直接派子智能体
 * 都会被拒绝并收到纠正指令。这里用纯函数把每条判定钉死：
 *
 * - **拒绝面**：Lead 的哪些动作会被拦（漏一个 = 规则没落地）；
 * - **放行面**：哪些必须放行（拦死 = 模式废掉，或小组长干不了活）；
 * - **纠正指令**：拒绝理由要告诉模型"现在该调哪个工具"，且只点名它真的有的工具
 *   （点名一个不存在的工具会让模型当场卡住 —— 0.1.x 踩过）。
 *
 * 接线层（真实 `apply()` 里的顺序与开关）由 `test/hierarchy-wiring.test.mjs` 覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEADER_ONLY_TASK_ACTIONS,
  LEADER_ONLY_TICKET_STATUSES,
  buildBoardWriteReason,
  buildSpecialistDispatchReason,
  buildTicketWriteReason,
  evaluateBoardWrite,
  evaluateSpecialistDispatch,
  evaluateTicketWrite,
  hasUsableDispatchChannel,
  isSpecialistDispatchTool,
} from '../lib/guard.js';
import { LEAD, TEAMMATE } from './helpers.mjs';

/** 判定为"拒绝"并返回理由。 */
function denyReason(decision) {
  assert.ok(decision !== undefined, '应当被拒绝，实际放行了');
  assert.equal(decision.kind, 'deny');
  assert.equal(typeof decision.reason, 'string');
  assert.ok(decision.reason.length > 0, '拒绝理由不能为空（它是给模型的纠正指令）');
  return decision.reason;
}

/** 断言放行（`undefined` = 放行）。 */
function allows(decision, label) {
  assert.equal(decision, undefined, `${label} 应当放行，实际被拒绝：${decision?.reason}`);
}

// ------------------------------------------------------ 常量（契约清单） ---

test('LEADER_ONLY_TASK_ACTIONS 恰好是五个"进度 + 排期"动作', () => {
  // 规则 4：「只有小组长可以修改智能体团队的任务进展并做排期」。
  // 刻意不含 reassign / edit / delete —— 那是指挥官的派单与清理。
  assert.deepEqual(
    [...LEADER_ONLY_TASK_ACTIONS],
    ['claim', 'release', 'complete', 'reopen', 'set_dependencies'],
  );
  assert.equal(Object.isFrozen(LEADER_ONLY_TASK_ACTIONS), true);
});

test('LEADER_ONLY_TICKET_STATUSES 恰好是五个"推进状态"，终态留给指挥官', () => {
  // 工单状态会投影到共享任务板（team-board-bridge），所以它和 team_task_update 是同一块
  // 写入口的两个面。`done` / `cancelled` 是**指挥官的验收与取消**，必须放行。
  assert.deepEqual(
    [...LEADER_ONLY_TICKET_STATUSES],
    ['progress', 'waiting', 'ready', 'blocked', 'failed'],
  );
  assert.equal(Object.isFrozen(LEADER_ONLY_TICKET_STATUSES), true);
  for (const terminal of ['done', 'cancelled', 'dropped']) {
    assert.ok(!LEADER_ONLY_TICKET_STATUSES.includes(terminal), `${terminal} 必须留给指挥官`);
  }
});

// ---------------------------------------------------------- 任务板门禁 ---

test('任务板门禁：Lead 的 claim/release/complete/reopen/set_dependencies 全部被拒', () => {
  for (const action of LEADER_ONLY_TASK_ACTIONS) {
    const reason = denyReason(evaluateBoardWrite({
      agent: LEAD,
      name: 'team_task_update',
      args: { action, task_id: 'task-1', revision: 3 },
    }));
    // 拒因是纠正指令：说清"由小组长做"+"让 owner 结算"+"reassign 改派"。
    assert.ok(reason.includes('小组长'), `${action} 的拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('reassign'), `${action} 的拒因应给出 reassign 出路：${reason}`);
    assert.ok(reason.includes(action), `${action} 的拒因应点名被拦的动作：${reason}`);
  }
});

test('任务板门禁：reassign / edit / delete 放行（派单与清理属于指挥官）', () => {
  for (const action of ['reassign', 'edit', 'delete']) {
    allows(
      evaluateBoardWrite({ agent: LEAD, name: 'team_task_update', args: { action } }),
      `Lead 的 ${action}`,
    );
  }
  // action 缺省 / 非法 / 大小写异常：缺省与非法放行，大小写按归一化处理（CLAIM 仍被拒）。
  allows(evaluateBoardWrite({ agent: LEAD, name: 'team_task_update', args: {} }), '缺省 action');
  allows(evaluateBoardWrite({ agent: LEAD, name: 'team_task_update' }), '没有 args');
  allows(evaluateBoardWrite({ agent: LEAD, name: 'team_task_update', args: { action: 42 } }), '非字符串 action');
  assert.equal(
    evaluateBoardWrite({ agent: LEAD, name: 'team_task_update', args: { action: 'CLAIM' } })?.kind,
    'deny',
    'action 应归一化（大小写/空白），CLAIM 仍属拒绝面',
  );
});

test('任务板门禁：teammate（小组长 / 子智能体）与身份读不到一律放行', () => {
  // 这是整个门禁的方向：宁可漏拦，不可拦死。小组长必须能改任务板，否则规则 4 没人能执行。
  for (const action of LEADER_ONLY_TASK_ACTIONS) {
    allows(evaluateBoardWrite({ agent: TEAMMATE, name: 'team_task_update', args: { action } }), `teammate 的 ${action}`);
  }
  for (const agent of [undefined, null, {}, { session: {} }, { session: { header: null } }]) {
    allows(evaluateBoardWrite({ agent, name: 'team_task_update', args: { action: 'claim' } }), `身份读不到（${JSON.stringify(agent)}）`);
  }
  // 不是 team_task_update 的工具完全不受这条门禁影响。
  for (const name of ['team_task_create', 'team_task_list', 'team_task_get', 'write', 'todo_write']) {
    allows(evaluateBoardWrite({ agent: LEAD, name, args: { action: 'claim' } }), name);
  }
});

test('任务板门禁：拒因按 agent 实际可用工具生成，不点名它没有的工具', () => {
  // 0.1.x 的教训：拒因写死 spawn_teammate / team_task_create，在没有 Agent Teams 的部署里
  // 模型收到"请用 spawn_teammate"却找不到这个工具，当场卡住。
  const bare = buildBoardWriteReason({ action: 'claim', availableTools: ['read', 'glob'] });
  assert.ok(!bare.includes('`send_message`'), `不该点名没有的 send_message：${bare}`);
  assert.ok(!bare.includes('`team_task_create`'), `不该点名没有的 team_task_create：${bare}`);
  assert.ok(bare.includes('owner'), '仍要给出"让 owner 结算"这条不依赖工具名的指引');
  assert.ok(bare.includes('reassign'), 'reassign 是 team_task_update 自己的参数，可以点名');

  const full = buildBoardWriteReason({ action: 'complete', availableTools: ['send_message', 'team_task_create', 'read'] });
  assert.ok(full.includes('`send_message`'), '有 send_message 时应给出这条出路');
  assert.ok(full.includes('`team_task_create`'), '有 team_task_create 时应给出这条出路');
  // 未知（undefined）时按"都有"生成完整指引。
  const unknown = buildBoardWriteReason({ action: 'complete' });
  assert.ok(unknown.includes('`send_message`'));
  // 被拦动作要写进理由（模型据此知道是哪一次调用）。
  assert.ok(full.includes('`action:"complete"`'));
});

// ---------------------------------------------------------- 工单门禁 ---

test('工单门禁：Lead 的 progress/waiting/ready/blocked/failed 全部被拒', () => {
  for (const status of LEADER_ONLY_TICKET_STATUSES) {
    const reason = denyReason(evaluateTicketWrite({
      agent: LEAD,
      name: 'commander_ticket_update',
      args: { ticket: 't-1', status },
    }));
    assert.ok(reason.includes('小组长'), `${status} 的拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('`done`'), `${status} 的拒因应说明 done 仍由指挥官写：${reason}`);
    assert.ok(reason.includes(status), `${status} 的拒因应点名被拦的状态：${reason}`);
  }
});

test('工单门禁：done / cancelled / 只改描述字段放行（验收与取消属于指挥官）', () => {
  for (const status of ['done', 'cancelled', 'dropped']) {
    allows(
      evaluateTicketWrite({ agent: LEAD, name: 'commander_ticket_update', args: { ticket: 't-1', status } }),
      `Lead 的 status=${status}`,
    );
  }
  // 只改 title / intent / acceptance / scope（不碰 status）→ 放行。
  for (const args of [
    { ticket: 't-1' },
    { ticket: 't-1', acceptance: '新判据' },
    { ticket: 't-1', title: '新标题', intent: '新意图', scope: ['a'] },
  ]) {
    allows(evaluateTicketWrite({ agent: LEAD, name: 'commander_ticket_update', args }), `只改描述字段（${JSON.stringify(args)}）`);
  }
  // 大小写归一化：DONE 是终态，仍放行。
  allows(
    evaluateTicketWrite({ agent: LEAD, name: 'commander_ticket_update', args: { status: 'DONE' } }),
    'status=DONE',
  );
});

test('工单门禁：teammate 与身份读不到放行；别的工具不受影响', () => {
  for (const status of LEADER_ONLY_TICKET_STATUSES) {
    allows(evaluateTicketWrite({ agent: TEAMMATE, name: 'commander_ticket_update', args: { status } }), `teammate 的 ${status}`);
  }
  for (const agent of [undefined, null, {}]) {
    allows(evaluateTicketWrite({ agent, name: 'commander_ticket_update', args: { status: 'progress' } }), '身份读不到');
  }
  for (const name of ['commander_ticket_create', 'commander_tickets', 'team_task_update', 'write']) {
    allows(evaluateTicketWrite({ agent: LEAD, name, args: { status: 'progress' } }), name);
  }
});

test('工单门禁：拒因按实际可用工具生成', () => {
  const bare = buildTicketWriteReason({ status: 'progress', availableTools: ['read'] });
  assert.ok(!bare.includes('`send_message`'), `不该点名没有的 send_message：${bare}`);
  assert.ok(bare.includes('STATUS'), '仍要给出结构化回报的格式要求');
  const full = buildTicketWriteReason({ status: 'progress', availableTools: ['send_message'] });
  assert.ok(full.includes('`send_message`'));
  assert.ok(full.includes('`status:"progress"`'), '被拦状态要写进理由');
});

// ------------------------------------------------------ 子智能体派发门禁 ---

test('isSpecialistDispatchTool：识别 subagent / subagent_fork / subagent_<id>', () => {
  for (const name of ['subagent', 'subagent_fork', 'subagent_architect', 'subagent_doc-writer', 'subagent_a1']) {
    assert.equal(isSpecialistDispatchTool(name), true, `${name} 应被识别为子智能体派发工具`);
  }
  // workflow 不算：它是编排，不是"派给某个子智能体"这条被规则 3 约束的通道。
  for (const name of ['workflow', 'spawn_teammate', 'send_message', 'team_task_update', 'subagentx', 'subagent_', 'Subagent_architect', '']) {
    assert.equal(isSpecialistDispatchTool(name), false, `${name} 不应被识别为子智能体派发工具`);
  }
  // 非字符串输入不抛错（门禁在工具调用路径上，抛错会让调用整体失败）。
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isSpecialistDispatchTool(value), false);
  }
});

test('子智能体派发门禁：Lead 调 subagent_<id> / subagent / subagent_fork 被拒', () => {
  for (const name of ['subagent_architect', 'subagent_implementer', 'subagent', 'subagent_fork']) {
    const reason = denyReason(evaluateSpecialistDispatch({ agent: LEAD, name }));
    // 拒因要给出正确通道：建小组长 + 派活；并说明一次性专家由小组长自己调用。
    assert.ok(reason.includes('小组长'), `${name} 的拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('spawn_teammate'), `${name} 的拒因应给出 spawn_teammate 出路：${reason}`);
    assert.ok(reason.includes('send_message'), `${name} 的拒因应给出 send_message 出路：${reason}`);
    assert.ok(reason.includes(name), `${name} 的拒因应点名被拦的工具：${reason}`);
    // 层级口径：你是 L0，子智能体是 L2。
    assert.ok(reason.includes('L0') || reason.includes('L2'), `${name} 的拒因应说明层级：${reason}`);
  }
});

test('子智能体派发门禁：workflow 放行（编排不是"派给某个子智能体"）', () => {
  // 规则 3 约束的是"任务下发给谁"，workflow 是一次性扇出的编排通道，不在拦截面里。
  for (const name of ['workflow', 'spawn_teammate', 'send_message', 'team_task_create', 'write']) {
    allows(evaluateSpecialistDispatch({ agent: LEAD, name }), name);
  }
});

test('子智能体派发门禁：teammate（小组长 / L2）与身份读不到放行', () => {
  // 规则 3：小组长可以自己执行，也可以把子任务交给下级子智能体 —— 这正是它该做的事。
  for (const name of ['subagent_architect', 'subagent', 'subagent_fork', 'workflow']) {
    allows(evaluateSpecialistDispatch({ agent: TEAMMATE, name }), `teammate 的 ${name}`);
  }
  for (const agent of [undefined, null, {}, { session: {} }]) {
    allows(evaluateSpecialistDispatch({ agent, name: 'subagent_architect' }), '身份读不到');
  }
});

test('子智能体派发门禁：拒因按实际可用工具生成，不点名没有的 Team 工具', () => {
  const bare = buildSpecialistDispatchReason({ toolName: 'subagent_architect', availableTools: ['read', 'workflow'] });
  assert.ok(!bare.includes('`spawn_teammate`'), `不该点名没有的 spawn_teammate：${bare}`);
  assert.ok(!bare.includes('`team_task_create`'), `不该点名没有的 team_task_create：${bare}`);
  assert.ok(bare.includes('小组长'), '仍要给出"交给小组长"这条不依赖工具名的指引');

  const full = buildSpecialistDispatchReason({
    toolName: 'subagent_architect',
    availableTools: ['spawn_teammate', 'send_message', 'team_task_create'],
  });
  assert.ok(full.includes('`spawn_teammate`'));
  assert.ok(full.includes('`send_message`'));
  assert.ok(full.includes('`team_task_create`'));
  assert.ok(full.includes('`subagent_architect`'), '被拦工具要写进理由');
});

// ------------------------------------------- 3.4.0 无 Team 通道的降级放行 ---
//
// 交叉审计发现的同类死锁：`evaluateSpecialistDispatch()` 假设"指挥官总能用 Team 通道"。
// 在没有 Agent Teams 的部署里，一次性子智能体是指挥官**唯一**能派活的路；拦了它 = 既不能
// 自己动手（执行边界）也不能派活 —— 整个模式死锁。所以没有 Team 通道时**放行**。

test('3.4.0 降级：没有 Team 通道时 Lead 调子智能体工具放行（否则模式死锁）', () => {
  // 工具视图里既没有 spawn_teammate 也没有 send_message —— 一次性子智能体是唯一出路。
  const noTeam = ['read', 'write', 'glob', 'subagent_architect', 'subagent_reviewer', 'workflow', 'todo_write'];
  for (const name of ['subagent_architect', 'subagent_reviewer', 'subagent', 'subagent_fork']) {
    allows(
      evaluateSpecialistDispatch({ agent: LEAD, name, availableTools: noTeam }),
      `没有 Team 通道时 Lead 调 ${name}`,
    );
  }
  // 连 workflow 之外什么都没有（只有 subagent）时同样放行。
  allows(
    evaluateSpecialistDispatch({ agent: LEAD, name: 'subagent', availableTools: ['read', 'subagent'] }),
    '只有通用 subagent 时',
  );
});

test('3.4.0 降级不是无条件放行：有 Team 通道时仍然拦', () => {
  // 这条是"降级不是放宽"的证明：只要 Team 通道在，指挥官就不该越过小组长。
  const withSpawn = ['read', 'spawn_teammate', 'subagent_architect'];
  const withSend = ['read', 'send_message', 'subagent_architect'];
  const withBoth = ['read', 'spawn_teammate', 'send_message', 'subagent_architect'];
  for (const [label, availableTools] of [
    ['只有 spawn_teammate', withSpawn],
    ['只有 send_message', withSend],
    ['两者都有', withBoth],
  ]) {
    const reason = denyReason(evaluateSpecialistDispatch({ agent: LEAD, name: 'subagent_architect', availableTools }));
    assert.ok(reason.includes('小组长'), `${label}：拒因应点名小组长：${reason}`);
    assert.ok(reason.includes('subagent_architect'), `${label}：拒因应点名被拦工具：${reason}`);
  }
  // 工具视图读不到（undefined）时按"有 Team"处理 → 仍拦（宁可漏拦的方向不适用于这里：
  // 读不到视图不等于"没有 Team"，而"没有 Team"是运行时事实）。
  denyReason(evaluateSpecialistDispatch({ agent: LEAD, name: 'subagent_architect' }));
  denyReason(evaluateSpecialistDispatch({ agent: LEAD, name: 'subagent_architect', availableTools: undefined }));
  // 非数组的 availableTools 同样按"未知 → 有 Team"处理。
  denyReason(evaluateSpecialistDispatch({ agent: LEAD, name: 'subagent_architect', availableTools: 'spawn_teammate' }));
});

test('3.4.0 降级只影响 Lead：teammate 无论有无 Team 通道都放行', () => {
  // 小组长把子任务交给下级子智能体是规则 3 本身，与 Team 通道是否存在无关。
  for (const availableTools of [undefined, ['read', 'subagent_architect'], ['read', 'spawn_teammate', 'send_message']]) {
    for (const name of ['subagent_architect', 'subagent', 'subagent_fork']) {
      allows(
        evaluateSpecialistDispatch({ agent: TEAMMATE, name, availableTools }),
        `teammate 的 ${name}（availableTools=${JSON.stringify(availableTools)}）`,
      );
    }
  }
});

// ------------------------------- 3.4.0 可用派活通道判定（blockedTools 死锁） ---
//
// 交叉审计发现的同类死锁：`canDelegate` 原来只看工具视图里有没有派发工具，**不看
// blockedTools**。用户把 `spawn_teammate`/`send_message` 写进 blockedTools 时，
// 会得出"能派活"的假结论 → 执行边界继续拦 `write` → 而真正能调用的派发工具全被禁
// → 既不能动手也不能派活。`hasUsableDispatchChannel()` 按"真的能调用"来算。

test('3.4.0 hasUsableDispatchChannel：默认（有 Team + specialist + workflow，未 block）→ true', () => {
  const tools = ['read', 'spawn_teammate', 'send_message', 'subagent_architect', 'workflow'];
  assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: [], delegationHierarchy: true }), true);
  // blocked 不传 / 传 Set 都可以。
  assert.equal(hasUsableDispatchChannel({ availableTools: tools }), true);
  assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: new Set(['read']) }), true);
});

test('3.4.0 hasUsableDispatchChannel：Team 工具全被 block 但 workflow 在 → true（不误判死锁）', () => {
  const tools = ['read', 'spawn_teammate', 'send_message', 'workflow'];
  assert.equal(
    hasUsableDispatchChannel({ availableTools: tools, blocked: ['spawn_teammate', 'send_message'] }),
    true,
    'workflow 仍是可用派活通道',
  );
});

test('3.4.0 hasUsableDispatchChannel：无 Team 工具（降级）+ subagent_* → true', () => {
  const tools = ['read', 'write', 'subagent_architect', 'subagent_reviewer'];
  assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: [], delegationHierarchy: true }), true);
  // 通用 subagent / subagent_fork 同样算。
  assert.equal(hasUsableDispatchChannel({ availableTools: ['read', 'subagent'], blocked: [] }), true);
  assert.equal(hasUsableDispatchChannel({ availableTools: ['read', 'subagent_fork'], blocked: [] }), true);
});

test('3.4.0 hasUsableDispatchChannel：无 Team 且 subagent_* 也被 block → false', () => {
  const tools = ['read', 'write', 'subagent_architect', 'subagent_reviewer'];
  assert.equal(
    hasUsableDispatchChannel({ availableTools: tools, blocked: ['subagent_architect', 'subagent_reviewer'] }),
    false,
  );
});

test('3.4.0 hasUsableDispatchChannel：只有 read（无任何派活通道）→ false', () => {
  for (const tools of [['read', 'write', 'glob'], ['read', 'write', 'todo_write'], []]) {
    assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: [] }), false, JSON.stringify(tools));
  }
});

test('3.4.0 hasUsableDispatchChannel：availableTools 读不到（undefined / 非数组）→ undefined（按"有"处理）', () => {
  assert.equal(hasUsableDispatchChannel({ availableTools: undefined }), undefined);
  assert.equal(hasUsableDispatchChannel({}), undefined);
  for (const value of [null, 'read', 42, {}]) {
    assert.equal(hasUsableDispatchChannel({ availableTools: value }), undefined, String(value));
  }
  // 门禁自身异常也按"未知"处理（不能把会话卡死）。
  assert.equal(
    hasUsableDispatchChannel({
      availableTools: ['read'],
      blocked: {
        has() {
          throw new Error('boom');
        },
        [Symbol.iterator]: () => {
          throw new Error('boom');
        },
      },
    }),
    undefined,
  );
});

test('3.4.0 hasUsableDispatchChannel：层级门禁关闭 + 只有 specialist → true', () => {
  // 关掉层级门禁（2.x 行为）时一次性子智能体对指挥官是开放的。
  const tools = ['read', 'write', 'subagent_architect'];
  assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: [], delegationHierarchy: false }), true);
  // 层级门禁开启 + 只有 specialist 且**没有 Team 工具** → 也 true（降级放行）。
  assert.equal(hasUsableDispatchChannel({ availableTools: tools, blocked: [], delegationHierarchy: true }), true);
});

test('3.4.0 hasUsableDispatchChannel：层级门禁开启 + 有 Team + 只有 specialist（被 block）→ true（Team 仍在）', () => {
  const tools = ['read', 'spawn_teammate', 'subagent_architect'];
  assert.equal(
    hasUsableDispatchChannel({ availableTools: tools, blocked: ['subagent_architect'], delegationHierarchy: true }),
    true,
    'Team 通道未被 block，仍可派活',
  );
  // 反过来：层级门禁开启 + 有 Team + Team 被 block + specialist 被 block → false。
  assert.equal(
    hasUsableDispatchChannel({
      availableTools: ['read', 'spawn_teammate', 'subagent_architect'],
      blocked: ['spawn_teammate', 'subagent_architect'],
      delegationHierarchy: true,
    }),
    false,
    'Team 与 specialist 都被禁且层级门禁开着 → 没有任何可用派活通道',
  );
});

test('三条门禁都吞掉自身异常（放行而不是让工具调用失败）', () => {
  // 门禁自己出错时绝不能让工具调用整体失败 —— 那会把会话卡死。
  // 用 getter 抛错的 args / agent 触发内部异常路径。
  const hostileArgs = {
    get action() {
      throw new Error('boom');
    },
    get status() {
      throw new Error('boom');
    },
  };
  const hostileAgent = {
    get session() {
      throw new Error('boom');
    },
  };
  allows(evaluateBoardWrite({ agent: LEAD, name: 'team_task_update', args: hostileArgs }), 'args 抛错');
  allows(evaluateTicketWrite({ agent: LEAD, name: 'commander_ticket_update', args: hostileArgs }), 'args 抛错');
  allows(evaluateBoardWrite({ agent: hostileAgent, name: 'team_task_update', args: { action: 'claim' } }), 'agent 抛错');
  allows(evaluateTicketWrite({ agent: hostileAgent, name: 'commander_ticket_update', args: { status: 'progress' } }), 'agent 抛错');
  allows(evaluateSpecialistDispatch({ agent: hostileAgent, name: 'subagent_architect' }), 'agent 抛错');
});
