/**
 * 门禁的单元测试。
 *
 * 这一组断言守的是**最容易出人命的那条线**：`tools/pre-execute` 监听器必须拒绝指挥者
 * 自己动手，同时**绝不能拦到子代理**。拦错方向的代价是不对称的——
 *
 * - 漏拦一次：指挥者顺手改了个文件，用户体验打折；
 * - 拦错一次：teammate 被自己父级的门禁拦死，**整个模式干不了任何活**。
 *
 * 所以下面每一条"拿不准"的分支都断言成**放行**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BLOCKED_TOOLS,
  DELEGATION_TOOLS,
  agentToolNames,
  buildDenialReason,
  evaluatePreExecute,
  isDelegatedAgent,
} from '../lib/guard.js';

// ---------------------------------------------------------------- 夹具 ---

/** 一个 Lead agent：有会话 header，但没有父会话。 */
function leadAgent(overrides = {}) {
  return { id: 'session-lead', session: { header: { id: 'session-lead', cwd: 'E:\\work', ...overrides } } };
}

/** 一个 teammate：`childSessionMeta()` 会给它写上 parentSession / origin / delegationDepth。 */
function teammateAgent() {
  return {
    id: 'session-child',
    session: { header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
  };
}

// ---------------------------------------------------------------- 身份 ---

test('Lead 不是被委派的子级', () => {
  assert.equal(isDelegatedAgent(leadAgent()), false);
});

test('teammate 的三个证据各自都能独立判定', () => {
  assert.equal(isDelegatedAgent(teammateAgent()), true);
  assert.equal(isDelegatedAgent(leadAgent({ parentSession: 'session-lead' })), true);
  assert.equal(isDelegatedAgent(leadAgent({ origin: 'subagent' })), true);
  assert.equal(isDelegatedAgent(leadAgent({ delegationDepth: 2 })), true);
});

test('delegationDepth 为 0 不算子级', () => {
  // 顶层 Lead 的深度就是 0；只有 > 0 才是被委派出来的。
  assert.equal(isDelegatedAgent(leadAgent({ delegationDepth: 0 })), false);
});

test('身份读不出来时一律当作子级放行', () => {
  // 这是刻意的安全默认：宁可漏拦，不可拦死子代理。
  for (const broken of [undefined, null, 42, 'agent', {}, { session: null }, { session: {} }, { session: { header: null } }]) {
    assert.equal(isDelegatedAgent(broken), true, `应放行：${JSON.stringify(broken)}`);
  }
});

test('getter 抛错时也放行', () => {
  const hostile = {
    get session() {
      throw new Error('boom');
    },
  };
  assert.equal(isDelegatedAgent(hostile), true);
});

// ---------------------------------------------------------------- 判定 ---

test('指挥者自己调用执行类工具会被拒绝', () => {
  for (const name of DEFAULT_BLOCKED_TOOLS) {
    const decision = evaluatePreExecute({ agent: leadAgent(), name, canDelegate: true });
    assert.ok(decision, `${name} 应当被拒绝`);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes(name), `拒绝理由要点名 ${name}`);
  }
});

test('只读工具与派发工具永远不被拦', () => {
  const allowed = ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'skill', 'todo_write',
    'ask_user_question', 'present', 'spawn_teammate', 'send_message', 'wait_agent', 'list_agents',
    'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'workflow'];
  for (const name of allowed) {
    assert.equal(evaluatePreExecute({ agent: leadAgent(), name, canDelegate: true }), undefined, `${name} 不该被拦`);
  }
});

test('子代理调用执行类工具必须放行', () => {
  // 这条就是"整个模式能不能干活"的开关。
  for (const name of DEFAULT_BLOCKED_TOOLS) {
    assert.equal(
      evaluatePreExecute({ agent: teammateAgent(), name, canDelegate: true }),
      undefined,
      `teammate 的 ${name} 被拦了 —— 子代理会干不了活`,
    );
  }
});

test('没有任何派发工具时不拦，避免会话死锁', () => {
  // 精简部署（用户关掉了「智能体团队」）里，既不能自己动手又没法派活 = 死锁。
  assert.equal(evaluatePreExecute({ agent: leadAgent(), name: 'write', canDelegate: false }), undefined);
  // canDelegate 未知（undefined）时按"有"处理，也就是照常拦。
  assert.ok(evaluatePreExecute({ agent: leadAgent(), name: 'write', canDelegate: undefined }));
});

test('blocked 清单可以覆盖', () => {
  assert.equal(evaluatePreExecute({ agent: leadAgent(), name: 'write', blocked: [], canDelegate: true }), undefined);
  assert.ok(evaluatePreExecute({ agent: leadAgent(), name: 'read', blocked: ['read'], canDelegate: true }));
  assert.ok(evaluatePreExecute({ agent: leadAgent(), name: 'write', blocked: new Set(['write']), canDelegate: true }));
});

test('工具名缺失或非法时放行', () => {
  for (const name of [undefined, null, '', 42, {}]) {
    assert.equal(evaluatePreExecute({ agent: leadAgent(), name, canDelegate: true }), undefined);
  }
});

// ---------------------------------------------------------------- 理由 ---

test('拒绝理由同时是纠正指令', () => {
  const reason = buildDenialReason('write');
  // 点出被拦的工具
  assert.ok(reason.includes('write'));
  // 说清边界
  assert.ok(reason.includes('指挥者'));
  // 给出三条可执行路径：先确认计划、用 Team 工具派发、用任务板派发
  assert.ok(reason.includes('ask_user_question'), '要引导它先问用户');
  assert.ok(reason.includes('spawn_teammate'), '要引导它建 teammate');
  assert.ok(reason.includes('send_message'), '要引导它派活');
  assert.ok(reason.includes('team_task_create'), '要给出任务板这条路');
  // 明确不要重试
  assert.ok(reason.includes('不要重试'));
});

test('派发工具清单覆盖智能体团队的九个工具里的派发入口', () => {
  // spawn_teammate 建成员、send_message 派活、team_task_create 建任务 —— 任一存在即视为
  // "能派活"，门禁才敢拦。subagent / workflow 是给没有 Team 的部署留的后路。
  for (const name of ['spawn_teammate', 'send_message', 'team_task_create', 'subagent', 'subagent_fork', 'workflow']) {
    assert.ok(DELEGATION_TOOLS.includes(name), `派发工具清单应包含 ${name}`);
  }
});

// ---------------------------------------------------------------- 工具视图 ---

test('agentToolNames 从 agent 自己的 scope 读工具名', () => {
  const agent = {
    ctx: { tools: { schemas: () => [{ name: 'spawn_teammate' }, { name: 'read' }, { name: '' }] } },
  };
  assert.deepEqual(agentToolNames(agent), ['spawn_teammate', 'read']);
});

test('读不到工具视图时返回 undefined（与"读到空列表"区分开）', () => {
  assert.equal(agentToolNames(undefined), undefined);
  assert.equal(agentToolNames({}), undefined);
  assert.equal(agentToolNames({ ctx: {} }), undefined);
  assert.equal(agentToolNames({ ctx: { tools: { schemas: () => 'nope' } } }), undefined);
  assert.equal(
    agentToolNames({
      ctx: {
        tools: {
          schemas: () => {
            throw new Error('boom');
          },
        },
      },
    }),
    undefined,
  );
  // 真的读到空列表时是 []，而不是 undefined —— 调用方据此判定"确实没有派发工具"。
  assert.deepEqual(agentToolNames({ ctx: { tools: { schemas: () => [] } } }), []);
});
