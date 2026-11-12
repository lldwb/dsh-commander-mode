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

/**
 * 拒因里出现的**名册生成的一次性专家工具名**（`subagent_<id>`）。
 *
 * 6.0.0 起拒因会以占位符 `subagent_<id>` 说明"这条通道归小组长、你不要调用"，也会点名
 * Team 通道 `subagent_fork`；这两者都不是"编造出来的具体专家工具名"，所以这里排除掉，
 * 只留下真正的具体工具名（`subagent_architect` 之类）。
 */
function specialistToolNamesIn(reason) {
  return (reason.match(/subagent_[a-z0-9][a-z0-9_-]*/gu) ?? []).filter((name) => name !== 'subagent_fork');
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
    'ask_user_question', 'present', 'subagent', 'send_message', 'wait_agent', 'list_agents',
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
  // 6.0.0：Team 常驻（`subagent` / `subagent_fork` + `send_message`），正常部署里 canDelegate
  // 不会为 false；这条是防御性兜底 —— 推导异常时也不能把会话锁死。
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
  assert.ok(reason.includes('subagent'), '要引导它建 teammate');
  assert.ok(reason.includes('send_message'), '要引导它派活');
  assert.ok(reason.includes('team_task_create'), '要给出任务板这条路');
  // 明确不要重试
  assert.ok(reason.includes('不要重试'));
});

test('派发工具清单恰好是 6.0.0 的五个派发入口（旧 Team 工具已移除）', () => {
  // 6.0.0（DSH 0.2.2-rc.2）：`subagent` / `subagent_fork` 建小组长、`send_message` 续做、
  // `team_task_create` 建任务板、`workflow` 一次性扇出 —— 任一存在即视为"能派活"，门禁才敢拦。
  // 旧 Team 专属工具（`spawn_teammate`）已随 rc.2 移除，不得再出现在清单里。
  assert.deepEqual(
    [...DELEGATION_TOOLS],
    ['subagent', 'subagent_fork', 'send_message', 'team_task_create', 'workflow'],
  );
  assert.equal(Object.isFrozen(DELEGATION_TOOLS), true);
  assert.ok(!DELEGATION_TOOLS.includes('spawn_teammate'), '已移除的 spawn_teammate 不得再出现');
});

// ------------------------------------------------- 拒绝理由必须适配真实部署 ---
//
// 这一组是端到端探测抓回来的真实缺陷：headless 探测 profile 里没有 Agent Teams，模型的
// 工具只有 `subagent` / `send_message` / `workflow`，而拒绝理由却写死了 Team 专属工具名
// （0.1.x 是 `spawn_teammate`；6.0.0 起 Team 通道变成标准 `subagent` / `subagent_fork`）。
// 模型找不到那个工具，**当场卡住** —— 既不能自己动手，也没被指引到它真正能用的那条路。

test('拒绝理由只点名 agent 真正拥有的派发工具', () => {
  const headless = ['read', 'write', 'edit', 'pwsh', 'subagent', 'send_message', 'workflow', 'todo_write'];
  // 6.0.0：`subagent` / `subagent_fork` 是建小组长的 Team 通道（旧 `spawn_teammate` 已移除），
  // 所以视图里有 `subagent` 时**必须**点名它；「只点名它真有的工具」这条仍然成立 ——
  // 它没有 team_task_create / ask_user_question，就不能点名它们。
  //
  // ⚠️ 已知 lib 偏差（非阻塞，见本次迁移回报）：hierarchy 分支末尾那句
  // 「团队活交给小组长（`subagent` / `subagent_fork` 建人 …）」硬编码了两个建人工具，
  // 视图只有 `subagent` 时也会提到它没有的 `subagent_fork`。
  const reason = buildDenialReason('write', headless);
  assert.ok(reason.includes('send_message'), '应当指引到它真有的 send_message（交给小组长）');
  assert.ok(reason.includes('小组长'), '指引要落到小组长身上');
  assert.ok(reason.includes('subagent'), '6.0.0：subagent 是建小组长的 Team 通道，视图里有就该点名');
  assert.ok(!reason.includes('team_task_create'), '不得点名它没有的 team_task_create');
  assert.ok(!reason.includes('ask_user_question'), '不得点名它没有的 ask_user_question');
  // 6.0.0：`subagent_<id>` 是名册生成的一次性专家工具（归小组长）。拒因只允许以占位符
  // 「`subagent_<id>` … 你不要调用」的反面措辞提到它，不得出现具体的专家工具名。
  assert.deepEqual(specialistToolNamesIn(reason), [], `不得点名具体的一次性专家工具：${reason}`);
  assert.ok(!reason.includes('spawn_teammate'), '旧 Team 工具已随 rc.2 移除，拒因不得再提');
  // 没有 ask_user_question 时要退化成"写在正文里问用户"。
  assert.ok(reason.includes('正文'));

  // 显式关掉层级门禁 → 回到 2.x 的 specialist / 一次性子智能体指引（这条语义也要留住覆盖）。
  const legacy = buildDenialReason('write', headless, { delegationHierarchy: false });
  assert.ok(legacy.includes('subagent'), '关闭层级门禁后应指引到它真有的 subagent');
  assert.ok(!legacy.includes('spawn_teammate'), '2.x 语义下同样不得点名已移除的 spawn_teammate');
  assert.ok(!legacy.includes('team_task_create'), '2.x 语义下同样不得点名它没有的 team_task_create');
});

test('有 Agent Teams 时指引用 Team 工具', () => {
  const withTeams = ['read', 'write', 'ask_user_question', 'subagent', 'send_message', 'team_task_create', 'team_task_update'];
  const reason = buildDenialReason('edit', withTeams);
  assert.ok(reason.includes('subagent'));
  assert.ok(reason.includes('send_message'));
  assert.ok(reason.includes('team_task_create'));
  assert.ok(reason.includes('ask_user_question'));
});

test('只有 workflow 时指引 workflow', () => {
  const reason = buildDenialReason('pwsh', ['read', 'write', 'pwsh', 'workflow']);
  assert.ok(reason.includes('workflow'));
  // 6.0.0：视图里没有 `subagent` / `subagent_fork` / `send_message`，就不得把它们当出路点名；
  // 一次性专家 `subagent_<id>` 只以"归小组长、你不要调用"的占位符出现。
  assert.ok(!reason.includes('`subagent`'), `不得把 subagent 当出路点名：${reason}`);
  assert.ok(!reason.includes('subagent_fork'), `不得点名它没有的 subagent_fork：${reason}`);
  assert.deepEqual(specialistToolNamesIn(reason), [], `不得点名具体的一次性专家工具：${reason}`);
});

test('一条派发路径都没有时给逃生口，而不是让模型死磕', () => {
  // 3.0.0 默认（层级门禁开启）：没有 Team / 小组长通道时，逃生口措辞是
  // 「本模式下你没有可用的派活通道（一次性专家工具归小组长）」——仍然是不让死磕。
  const reason = buildDenialReason('write', ['read', 'write', 'glob']);
  assert.ok(reason.includes('没有可用的派活通道'), reason);
  assert.ok(reason.includes('请用户决定'), reason);
  assert.ok(reason.includes('小组长'), reason);
  // 6.0.0：视图里没有任何派发工具，不得把 `subagent` / `subagent_fork` 当出路点名；
  // `subagent_<id>` 只允许以"归小组长"的占位符出现（它不是给指挥官的通道）。
  assert.ok(!reason.includes('`subagent`'), reason);
  assert.ok(!reason.includes('subagent_fork'), reason);
  assert.deepEqual(specialistToolNamesIn(reason), [], reason);

  // 显式关掉层级门禁 → 2.x 的逃生口措辞（这条语义也要留住覆盖）。
  const legacy = buildDenialReason('write', ['read', 'write', 'glob'], { delegationHierarchy: false });
  assert.ok(legacy.includes('没有可用的委派工具'), legacy);
  assert.ok(legacy.includes('请用户决定'), legacy);
  assert.ok(!legacy.includes('subagent'), legacy);
});

test('读不到工具视图时按"都有"处理，生成完整指引', () => {
  const reason = buildDenialReason('write');
  assert.ok(reason.includes('subagent'));
  assert.ok(reason.includes('ask_user_question'));
});

test('evaluatePreExecute 会把工具视图透传给理由生成', () => {
  // 2.x 语义（显式关掉层级门禁）：视图里有 subagent → 理由点名 subagent（一次性子智能体通道），
  // 且不点名视图里没有的 Team / 任务板工具。
  const legacy = evaluatePreExecute({
    agent: leadAgent(),
    name: 'write',
    canDelegate: true,
    availableTools: ['read', 'write', 'subagent'],
    delegationHierarchy: false,
  });
  assert.ok(legacy);
  assert.ok(legacy.reason.includes('subagent'));
  assert.ok(!legacy.reason.includes('send_message'), `不得点名它没有的 send_message：${legacy.reason}`);
  assert.ok(!legacy.reason.includes('team_task_create'), `不得点名它没有的 team_task_create：${legacy.reason}`);
  assert.ok(!legacy.reason.includes('spawn_teammate'), `旧 Team 工具已移除：${legacy.reason}`);

  // 6.0.0 默认（层级门禁开启）：`subagent` 是建小组长的 Team 通道，视图里有它就点名它；
  // "透传"依然生效 —— 视图里没有 send_message / team_task_create，所以理由不得点名它们。
  const current = evaluatePreExecute({
    agent: leadAgent(),
    name: 'write',
    canDelegate: true,
    availableTools: ['read', 'write', 'subagent'],
  });
  assert.ok(current);
  assert.ok(current.reason.includes('subagent'), current.reason);
  assert.deepEqual(specialistToolNamesIn(current.reason), [], current.reason);
  assert.ok(!current.reason.includes('send_message'), `视图里没有 send_message，不得点名：${current.reason}`);
  assert.ok(!current.reason.includes('team_task_create'), `视图里没有 team_task_create，不得点名：${current.reason}`);
  assert.ok(current.reason.includes('小组长'), '要落到"交给小组长"这条不依赖工具名的出路');
});

// ---------------------------------------------------------------- 工具视图 ---

test('agentToolNames 从 agent 自己的 scope 读工具名', () => {
  const agent = {
    ctx: { tools: { schemas: () => [{ name: 'subagent' }, { name: 'read' }, { name: '' }] } },
  };
  assert.deepEqual(agentToolNames(agent), ['subagent', 'read']);
});

test('读不到工具视图时返回 undefined', () => {
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
});

test('空视图必须当作"读不到"，否则门禁在 web-app 式部署里会整个失效', () => {
  // 这是端到端探测抓回来的真实事故：`dsh-web-app` 把能力行全局禁用、工具都在 preset 层，
  // 于是 `agent.ctx.tools.schemas()` 返回 `[]`（连 write 都"不存在"）。第一版把 [] 当成
  // 事实 → `canDelegate === false` → 放行 → 指挥者照常 write/pwsh，门禁形同不存在。
  assert.equal(agentToolNames({ ctx: { tools: { schemas: () => [] } } }), undefined);
  assert.equal(
    agentToolNames({ ctx: { tools: { schemas: () => [{ name: '' }, { name: '' }] } } }),
    undefined,
    '只读出空名字的视图同样是坏视图',
  );
});

test('空视图走"未知"分支，也就是照常拦截', () => {
  const agent = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [] } },
  };
  // canDelegate 由 index.js 从 agentToolNames 推导：undefined → undefined → 不触发放行。
  const availableTools = agentToolNames(agent);
  assert.equal(availableTools, undefined);
  const decision = evaluatePreExecute({ agent, name: 'pwsh', canDelegate: undefined, availableTools });
  assert.ok(decision, '空视图下 pwsh 必须被拒绝 —— 这正是桌面版曾经漏掉的那一拦');
  assert.equal(decision.kind, 'deny');
  // 而且理由要按"都有"生成完整指引，不能因为空视图就落到逃生口。
  // 逃生口在 3.0.0 有两种措辞：默认（层级开启）是"没有可用的派活通道"，
  // 显式关掉层级门禁是 2.x 的"没有可用的委派工具" —— 两种都不该出现。
  assert.ok(decision.reason.includes('subagent'));
  assert.ok(!decision.reason.includes('没有可用的派活通道'));
  assert.ok(!decision.reason.includes('没有可用的委派工具'));
});

// ---------------------------------------------------------------- specialist ---

test('只有 specialist 工具时，拒绝理由点名 specialist 工具而不是 Team 工具（2.x 语义）', () => {
  // 场景：用户关掉了「智能体团队」、只配置了 specialist 名册，并**显式关掉**层级门禁
  // （2.x 行为）。此时 agent 的工具视图里有 subagent_architect / subagent_reviewer，
  // 没有 subagent。拒绝理由若还点名 subagent，模型就会去找一个不存在的工具
  // —— 0.1.x 在 headless 部署里踩过同一课。
  const view = ['read', 'write', 'subagent_architect', 'subagent_reviewer'];
  const legacy = evaluatePreExecute({
    agent: leadAgent(),
    name: 'write',
    canDelegate: true,
    availableTools: view,
    delegationHierarchy: false,
  });
  assert.ok(legacy);
  assert.equal(legacy.kind, 'deny');
  assert.ok(legacy.reason.includes('subagent_architect'), '要点名它真有的 specialist 工具');
  assert.ok(legacy.reason.includes('subagent_reviewer'));
  // 6.0.0：旧 Team 建人工具已移除；`subagent` / `send_message` / `team_task_create`
  // 都不在视图里，不得点名。
  assert.ok(!legacy.reason.includes('`subagent`'), `不得点名它没有的 Team 工具：${legacy.reason}`);
  assert.ok(!legacy.reason.includes('send_message'), `不得点名它没有的 send_message：${legacy.reason}`);
  assert.ok(!legacy.reason.includes('team_task_create'), `不得点名它没有的 team_task_create：${legacy.reason}`);

  // 6.0.0 默认（层级门禁开启）：同一份视图下，一次性专家工具归小组长 —— 不得点名具体的
  // `subagent_<id>`，也不得把视图里没有的 Team 工具当出路；出路是"交给小组长"。
  const current = evaluatePreExecute({
    agent: leadAgent(),
    name: 'write',
    canDelegate: true,
    availableTools: view,
  });
  assert.ok(current);
  assert.equal(current.kind, 'deny');
  assert.deepEqual(specialistToolNamesIn(current.reason), [], `层级门禁开启时不得点名 subagent_*：${current.reason}`);
  assert.ok(!current.reason.includes('`subagent`'), `不得把视图里没有的 subagent 当出路：${current.reason}`);
  assert.ok(current.reason.includes('小组长'), '要给出"交给小组长"的出路');
});

test('3.0.0 P2 回归：层级门禁开启时 write 的拒因不得教指挥官直调 subagent_*', () => {
  // W3 修复的 P2：执行边界拒因曾写"用 `subagent_xxx` 把这一步派给对应的 specialist"，
  // 与层级门禁（指挥官不直调子智能体）**互相矛盾** —— 模型照做会立刻被
  // `evaluateSpecialistDispatch()` 拒绝，连吃两次互相矛盾的纠正指令、白烧一轮。
  //
  // 这条是回归保护：拒因必须给 Team 通道（subagent / subagent_fork / send_message / 小组长），
  // 且绝不能出现具体的一次性专家工具名。只有显式关掉层级门禁时才恢复 2.x 的 specialist 指引。
  const view = [
    'read', 'write', 'pwsh', 'ask_user_question',
    'subagent', 'send_message', 'team_task_create',
    'subagent_architect', 'subagent_reviewer',
  ];
  const reason = buildDenialReason('write', view);
  assert.deepEqual(specialistToolNamesIn(reason), [], `拒因不得点名具体的 subagent_*：${reason}`);
  assert.ok(reason.includes('subagent'), `拒因必须给 Team 通道：${reason}`);
  assert.ok(reason.includes('send_message'), `拒因必须给 Team 通道：${reason}`);
  assert.ok(reason.includes('小组长'), `拒因必须落到小组长：${reason}`);
  // 6.0.0：措辞从"一次性子智能体工具由小组长使用"改成"名册生成的一次性专家工具（`subagent_<id>`）
  // 由小组长使用，你不要调用"——这条"那条通道不是给指挥官的"语义必须保留。
  assert.ok(reason.includes('一次性专家工具'), `要明确那条通道不是给指挥官的：${reason}`);
  assert.ok(reason.includes('由小组长使用'), `要明确那条通道不是给指挥官的：${reason}`);
  assert.ok(reason.includes('你不要调用'), `要明确那条通道不是给指挥官的：${reason}`);
  assert.ok(!reason.includes('spawn_teammate'), `旧 Team 工具已移除：${reason}`);

  const legacy = buildDenialReason('write', view, { delegationHierarchy: false });
  assert.ok(legacy.includes('subagent_architect'), `关闭层级门禁后应恢复 2.x 的 specialist 指引：${legacy}`);
});

test('读不到工具视图时不猜 specialist 工具（不能点名不存在的工具）', () => {
  const decision = evaluatePreExecute({
    agent: leadAgent(),
    name: 'write',
    canDelegate: undefined,
    availableTools: undefined,
  });
  assert.ok(decision);
  // 6.0.0：视图未知时只允许出现占位符 `subagent_<id>`（"归小组长、你不要调用"），
  // 绝不能按前缀编造具体的一次性专家工具名。
  assert.deepEqual(specialistToolNamesIn(decision.reason), [], '未知视图下不得按前缀编造 specialist 工具名');
});
