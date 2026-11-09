/**
 * 插件级测试：用 mock 的 Cordis 上下文驱动真正的 `apply()`（模式行）。
 *
 * 这里证明单元测试证明不了的事：
 *
 * 1. **接线是对的** —— prompt section、skill、`tools/pre-execute` 监听器、以及 specialist
 *    的 preset/工具安装都真的注册上了，而且用的是约定的名字与 order。
 * 2. **监听器的契约是对的** —— 拒绝时返回决策，放行时**调用 `next()`**。在 waterfall 里
 *    直接返回 `{ kind: 'allow' }` 会短路掉后面的监听器（包括用户审批那道门），那是绕过
 *    安全检查，不是放行。
 * 3. **门禁自己出错时不弄挂工具调用** —— 抛错一律降级为放行。
 * 4. **配置从 `commanderSettings` 服务来** —— 服务缺失时用默认值降级（模式仍成立）；
 *    名册变化时重建 specialist。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, FALLBACK_OPTIONS, SECTION_NAME, SECTION_ORDER } from '../agent.js';
import { emptyLedger } from '../lib/ledger.js';
import { CommanderLedger } from '../lib/ledger-service.js';
import { PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID } from '../lib/tickets.js';
import { SYNC_CONTEXT_NAME, SYNC_CONTEXT_ORDER } from '../lib/sync.js';

// ---------------------------------------------------------------- 夹具 ---

/** 让排队的微任务/异步重建跑完。 */
async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 一个合法的 specialist 名册。 */
const ROSTER = [
  { id: 'architect', provider: 'sub2api', model: 'glm-5.3-flash', description: '负责架构与拆分' },
  { id: 'reviewer', provider: 'sub2api', model: 'gpt-6.1-sol', description: '负责审查与测试', persona: '你特别挑剔。' },
];

/** `commanderSettings` 服务的替身（配置行提供）。 */
function makeSettings(initial = {}) {
  let options = {
    confirmPlan: true,
    escalateOnConflict: true,
    registerSkill: true,
    maxTeammates: 4,
    blockedTools: ['write', 'edit', 'pwsh', 'bash', 'job_kill', 'plugin_manager'],
    maxSpecialists: 20,
    ledger: true,
    stateDir: '',
    requireMandate: true,
    requireTicket: true,
    asyncDelegation: true,
    maxAsyncTasks: 4,
    workerSessions: true,
    workRoot: '',
    maxWorkers: 3,
    prepareCommand: '',
    workerPermission: 'danger-full-access',
    ticketStallMs: 10 * 60 * 1000,
    maxTickets: 100,
    ...(initial.options ?? {}),
  };
  let roster = initial.specialists ?? [];
  const listeners = new Set();
  return {
    options: () => ({ ...options }),
    // 与真实服务一致：名册按 maxSpecialists 截断（真实实现走 resolveRoster）。
    specialists: () => roster.slice(0, options.maxSpecialists).map((entry) => ({ ...entry })),
    maxSpecialists: () => options.maxSpecialists,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 测试助手：改名册并广播（等价于配置行收到 loader/volatile-update）。 */
    update(next) {
      roster = next;
      for (const listener of [...listeners]) listener([['specialists']]);
    },
    setOptions(next) {
      options = { ...options, ...next };
    },
    listenerCount: () => listeners.size,
  };
}

/** `subagents` 服务的替身：记录 startActivation，result 返回给定结算。 */
function makeSubagents(record, settlement = { output: [{ type: 'text', text: '子代理答复' }], stopReason: 'completed' }) {
  return {
    resolveMaxDepth: (depth) => depth,
    startActivation: async (request) => {
      record.activations.push(request);
      return { childId: 'child-1', result: Promise.resolve(settlement), dispose: async () => {} };
    },
  };
}

/**
 * 一个 Cordis 上下文的替身。
 *
 * `inject` 回调收到的子上下文带着该依赖对应的桩服务；`effect()` 立即执行回调（与 Cordis
 * 的挂载语义一致），返回的 disposer 被记录下来。
 */
function makeCtx({ withSkills = true, withSpecialistServices = true, settings = makeSettings(), settlement, agentTeams, ledger, workers } = {}) {
  const record = {
    sections: [],
    contexts: [],
    skills: [],
    listeners: [],
    warnings: [],
    effects: [],
    tools: [],
    presets: [],
    activations: [],
    settingsPolicies: [],
    /** 记录 `agent.inject()` 收到的消息（结算是靠它兜底的）。 */
    injected: [],
  };
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (...args) => record.warnings.push(args.map(String).join(' ')),
  };
  const services = {
    ...(agentTeams === undefined ? {} : { agentTeams }),
    ...(ledger === undefined ? {} : { commanderLedger: ledger }),
    ...(workers === undefined ? {} : { commanderWorkers: workers }),
    ...(withSkills ? {
      skills: {
        register: (definition) => {
          record.skills.push(definition);
          return () => {};
        },
      },
    } : {}),
    ...(withSpecialistServices ? {
      tools: {
        register: (definition) => {
          record.tools.push(definition);
          return () => {
            record.tools = record.tools.filter((entry) => entry !== definition);
          };
        },
      },
      subagents: makeSubagents(record, settlement),
      agentPresets: {
        register: async (definition) => {
          record.presets.push(definition);
          return async () => {
            record.presets = record.presets.filter((entry) => entry !== definition);
          };
        },
      },
      commanderSettings: settings,
    } : {
      commanderSettings: settings,
    }),
  };
  const ctx = {
    logger,
    systemPrompt: {
      section: (definition) => {
        record.sections.push(definition);
        return () => {};
      },
      context: (definition) => {
        record.contexts.push(definition);
        return () => {};
      },
    },
    on: (event, listener) => {
      record.listeners.push({ event, listener });
      return () => {};
    },
    effect: (callback) => {
      record.effects.push(callback);
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: (name) => services[name],
    inject: (dependencies, callback) => {
      const available = {};
      for (const dependency of dependencies) {
        if (services[dependency] !== undefined) available[dependency] = services[dependency];
      }
      // 与真实 Cordis 一样：依赖缺一个，回调就不执行。
      if (Object.keys(available).length !== dependencies.length) return;
      callback({
        ...available,
        logger,
        effect: ctx.effect,
        on: ctx.on,
        get: ctx.get,
      });
    },
  };
  return { ctx, record, settings };
}

/** 跑一次 apply，返回记录与服务。 */
function boot(options = {}) {
  const settings = options.settings ?? makeSettings({ specialists: options.specialists });
  const made = makeCtx({ ...options, settings });
  apply(made.ctx);
  return made;
}

/** 取 `tools/pre-execute` 的监听器。 */
function preExecute(record) {
  const entry = record.listeners.find((item) => item.event === 'tools/pre-execute');
  assert.ok(entry, '没有注册 tools/pre-execute 监听器');
  return entry.listener;
}

/**
 * 取某个事件的监听器。
 *
 * @param {object} record - `makeCtx()` 的记录。
 * @param {string} event - 事件名。
 * @returns {Function} 监听器。
 */
function listenerOf(record, event) {
  const entry = record.listeners.find((item) => item.event === event);
  assert.ok(entry, `没有注册 ${event} 监听器`);
  return entry.listener;
}

/** 取同步看板的运行时上下文定义。 */
function syncContext(record) {
  const entry = record.contexts.find((item) => item.name === SYNC_CONTEXT_NAME);
  assert.ok(entry, '没有注册同步看板运行时上下文');
  return entry;
}

/** 取 specialist 工具（排除 0.6.0 的 commander_ticket_* 工单工具）。 */
function specialistTools(record) {
  return record.tools.filter((tool) => typeof tool.name === 'string' && tool.name.startsWith('subagent_'));
}

/** 一个 Lead agent。 */
const LEAD = { id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead' } } };

/** 一个 teammate。 */
const TEAMMATE = {
  id: 'session-child',
  session: { id: 'session-child', header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
};

/**
 * 让一个 Lead agent 可以被注入消息，并记录注入的内容。
 *
 * `agent/turn-stopping` 的兜底靠 `agent.inject()`；真实实现里它是 AgentLoop 的方法。
 *
 * @returns {object} 带 inject 记录的 agent。
 */
function injectableLead() {
  const agent = { id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead' } }, injected: [] };
  agent.inject = (message) => {
    agent.injected.push(message);
  };
  return agent;
}

/**
 * `agentTeams` 服务的替身。
 *
 * 只有 `tryMembership` / `listTasks` / `listMembers` 三个读方法是本插件用到的。
 *
 * @param {{ tasks?: object[], members?: object[], member?: boolean }} [options] - 初始视图。
 * @returns {object} 服务替身（`tasks`/`members` 可在测试里直接替换）。
 */
function makeAgentTeams(options = {}) {
  const service = {
    member: options.member !== false,
    tasks: options.tasks ?? [],
    // 真实 `listMembers()` 的 row 用 `status`（running / inactive / provisioning / failed），
    // Lead 自己也在列表里（role: 'lead'）。
    members: options.members ?? [{ id: 'lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] }],
    tryMembership: () => (service.member ? { role: 'lead' } : undefined),
    listTasks: () => service.tasks,
    listMembers: () => service.members,
  };
  return service;
}

/** 一个总是被调用到的 `next()`，记录自己被调了几次。 */
function spyNext(value = { kind: 'allow' }) {
  const calls = { count: 0 };
  const next = () => {
    calls.count += 1;
    return Promise.resolve(value);
  };
  return { next, calls };
}

// ---------------------------------------------------------------- 接线 ---

test('注册了指挥者 prompt section，名字与 order 是约定的', () => {
  const { record } = boot();
  assert.equal(record.sections.length, 1);
  assert.equal(record.sections[0].name, SECTION_NAME);
  assert.equal(record.sections[0].order, SECTION_ORDER);
  assert.equal(SECTION_NAME, 'commander:mode');
  // 排在 team 策略（600）之后、工具指导块之前。
  assert.equal(SECTION_ORDER, 650);
});

test('section 文本每次求值都是完整的指挥者协议', () => {
  const { record } = boot();
  const text = record.sections[0].text({ agent: LEAD });
  assert.ok(typeof text === 'string' && text.length > 500);
  assert.ok(text.includes('指挥者'));
  assert.ok(text.includes('ask_user_question'));
});

test('配置服务的选项真的影响协议文本', () => {
  const settings = makeSettings({ options: { confirmPlan: false, maxTeammates: 9 } });
  const { record } = boot({ settings });
  const text = record.sections[0].text({ agent: LEAD });
  assert.ok(!text.includes('规划或拆分完成'), 'confirmPlan=false 时不该出现规划确认');
  assert.ok(text.includes('9'), 'maxTeammates 应写进协议');
});

test('没有配置服务时用默认值降级（模式仍然成立）', () => {
  const made = makeCtx({ withSpecialistServices: false });
  // 没有任何服务：模式行仍要注册协议与门禁。
  apply(made.ctx);
  assert.equal(made.record.sections.length, 1);
  const text = made.record.sections[0].text({ agent: LEAD });
  assert.ok(text.includes('指挥者'));
  assert.ok(text.includes('ask_user_question'));
  preExecute(made.record);
  // 默认值来自 resolveConfig(undefined)，与 schema 默认一致。
  assert.equal(FALLBACK_OPTIONS.confirmPlan, true);
  assert.equal(FALLBACK_OPTIONS.maxTeammates, 4);
});

test('注册了 commander-mode skill', () => {
  const { record } = boot();
  assert.equal(record.skills.length, 1);
  assert.equal(record.skills[0].name, 'commander-mode');
  assert.equal(record.skills[0].source, 'runtime');
  assert.ok(record.skills[0].content.includes('指挥者'));
  assert.deepEqual(record.skills[0].invocation, { modelInvocable: true, userInvocable: true });
});

test('registerSkill: false 时不注册 skill', () => {
  const { record } = boot({ settings: makeSettings({ options: { registerSkill: false } }) });
  assert.equal(record.skills.length, 0);
});

test('没有 skills 服务的部署里不炸', () => {
  const { record } = boot({ withSkills: false });
  assert.equal(record.skills.length, 0);
  assert.equal(record.sections.length, 1);
  assert.ok(record.listeners.some((item) => item.event === 'tools/pre-execute'));
});

test('注册了三个确定性钩子：门禁、计划清单记录、结算兜底', () => {
  // 门禁（不执行操作）+ 计划清单记录（todo_write 之后更新账本）+ 回合结束兜底（结算同步）。
  const events = boot().record.listeners.map((item) => item.event);
  assert.deepEqual([...events].sort(), ['agent/turn-stopping', 'tools/post-execute', 'tools/pre-execute']);
});

// ---------------------------------------------------------------- 监听器 ---

test('指挥者自己调用 write 会被拒绝', async () => {
  const listener = preExecute(boot().record);
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: LEAD }, next);
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes('write'));
  assert.equal(calls.count, 0, '拒绝时不该调用 next');
});

test('放行时必须走 next()，不能自己返回 allow', async () => {
  // 直接返回 { kind: 'allow' } 会短路掉后面的监听器（含用户审批门禁）——那是绕过安全检查。
  const listener = preExecute(boot().record);

  for (const exec of [
    { name: 'read', agent: LEAD },
    { name: 'write', agent: TEAMMATE },
    { name: 'spawn_teammate', agent: LEAD },
  ]) {
    const { next, calls } = spyNext();
    const decision = await listener(exec, next);
    assert.deepEqual(decision, { kind: 'allow' });
    assert.equal(calls.count, 1, `${exec.name} 应当放行并调用 next`);
  }
});

test('teammate 写文件必须放行（否则子代理干不了活）', async () => {
  const listener = preExecute(boot().record);
  for (const name of ['write', 'edit', 'pwsh', 'bash']) {
    const { next, calls } = spyNext();
    const decision = await listener({ name, agent: TEAMMATE }, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(calls.count, 1);
  }
});

test('blockedTools 从配置服务读，可以收窄或放宽', async () => {
  const custom = preExecute(boot({ settings: makeSettings({ options: { blockedTools: ['pwsh'] } }) }).record);
  assert.equal((await custom({ name: 'pwsh', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind, 'deny');
  assert.equal(
    (await custom({ name: 'write', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind,
    'allow',
    'write 不在自定义清单里，应当放行',
  );

  const off = preExecute(boot({ settings: makeSettings({ options: { blockedTools: [] } }) }).record);
  assert.equal((await off({ name: 'write', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
});

test('没有派发工具时放行，避免会话死锁', async () => {
  const listener = preExecute(boot().record);
  const strandedLead = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] } },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: strandedLead }, next);
  assert.equal(decision.kind, 'allow');
  assert.equal(calls.count, 1);
});

test('agent 自己的 scope 里有 spawn_teammate 时照常拦截', async () => {
  const listener = preExecute(boot().record);
  const normalLead = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [{ name: 'spawn_teammate' }, { name: 'read' }, { name: 'write' }] } },
  };
  const { next } = spyNext();
  const decision = await listener({ name: 'write', agent: normalLead }, next);
  assert.equal(decision.kind, 'deny');
});

test('只有 specialist 工具时也算有派发通道（不会被误判成死锁）', async () => {
  const listener = preExecute(boot({ specialists: ROSTER }).record);
  const specialistLead = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [{ name: 'subagent_reviewer' }, { name: 'read' }, { name: 'write' }] } },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: specialistLead }, next);
  assert.equal(decision.kind, 'deny');
  assert.equal(calls.count, 0);
});

test('监听器自己出错时放行，而不是让工具调用失败', async () => {
  const { record } = boot();
  const listener = preExecute(record);
  const hostile = {
    id: 'session-lead',
    get session() {
      throw new Error('boom');
    },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: hostile }, next);
  assert.equal(decision.kind, 'allow');
  assert.equal(calls.count, 1);
  // 出错路径不应当被记成 warning —— 身份读不出来是预期内的降级，不是异常。
  assert.deepEqual(record.warnings, []);
});

test('exec 形状异常时不炸', async () => {
  const listener = preExecute(boot().record);
  for (const exec of [undefined, null, {}, { name: undefined }, { name: 42 }, 'nope']) {
    const { next, calls } = spyNext();
    const decision = await listener(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(calls.count, 1);
  }
});

test('没有 next 时返回 undefined，不冒充 allow', async () => {
  const listener = preExecute(boot().record);
  assert.equal(await listener({ name: 'read', agent: LEAD }, undefined), undefined);
  assert.equal((await listener({ name: 'write', agent: LEAD }, undefined)).kind, 'deny');
});

// ---------------------------------------------------------- 结算同步（0.4.0） ---

test('指挥者协议不注入给 teammate（0.4.0 修复的系统提示泄漏）', () => {
  // 0.3.x 的实测现象：teammate 与指挥者共用同一个 preset scope，于是每个执行者的
  // 系统提示里都带着整份「指挥者模式 … 你不执行操作」（约 4.4 KB/请求），
  // 既浪费 token 又和它自己的执行者人设打架。0.4.0 起 section 按 agent 判定。
  const { record } = boot();
  const section = record.sections[0];
  assert.equal(section.text({ agent: TEAMMATE }), '');
  // 不传 agent（旧调用方 / 单测直接调用）时仍按指挥者渲染 —— 不能因为拿不到身份就整段消失。
  assert.ok(section.text().includes('指挥者模式'));
  assert.ok(section.text({ agent: LEAD }).includes('指挥者模式'));
});

test('注册了同步看板运行时上下文，名字与 order 是约定的', () => {
  const { record } = boot();
  const context = syncContext(record);
  assert.equal(context.name, SYNC_CONTEXT_NAME);
  assert.equal(context.name, 'commander:sync-board');
  // 排在 TEAM_IDENTITY（125）之后、HARNESS_SOURCE（200）之前。
  assert.equal(context.order, SYNC_CONTEXT_ORDER);
  assert.equal(context.order, 130);
  // 每轮求值：text 必须是函数而不是静态字符串。
  assert.equal(typeof context.text, 'function');
});

test('没有智能体团队的部署里，同步看板不产生任何文本', () => {
  const { record } = boot();
  assert.equal(syncContext(record).text({ agent: LEAD }), '');
  // teammate 也永远拿不到看板。
  assert.equal(syncContext(record).text({ agent: TEAMMATE }), '');
});

test('任务结算后，看板立刻指出计划清单没同步', () => {
  const agentTeams = makeAgentTeams({
    tasks: [
      { id: 'task-1', status: 'in_progress', subject: '实现', ownerName: 'browser-ops' },
      { id: 'task-2', status: 'pending', subject: '验收' },
    ],
  });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const postExecute = listenerOf(record, 'tools/post-execute');
  // 规划阶段先写一次计划清单（否则看板只会说"未建立"，不构成"结算没同步"）。
  postExecute({ name: 'todo_write', agent: LEAD, arguments: { todos: [{ content: '实现', status: 'in_progress' }, { content: '验收', status: 'pending' }] } }, undefined, spyNext({ kind: 'accept' }).next);

  // 第一次只建基线，不应报"未同步"（账本之前的历史不算）。
  const first = context.text({ agent: LEAD });
  assert.ok(first.includes('任务板'), '应当给出任务板摘要');
  assert.ok(!first.includes('⚠️'), `基线不该报未同步：${first}`);

  // 队友把 task-1 做完 → 下一次求值必须报"计划清单没更新"。
  agentTeams.tasks = [
    { id: 'task-1', status: 'completed', subject: '实现', ownerName: 'browser-ops' },
    { id: 'task-2', status: 'pending', subject: '验收' },
  ];
  const second = context.text({ agent: LEAD });
  assert.ok(second.includes('⚠️'), `结算后应当出现未同步提示：${second}`);
  assert.ok(second.includes('todo_write'), '提示里应给出纠正动作');
  assert.ok(second.includes('task-1'), '提示里应点名未同步的任务');
});

test('post-execute 记录 todo_write 之后，看板不再报未同步', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress', subject: '实现' }] });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const postExecute = listenerOf(record, 'tools/post-execute');

  context.text({ agent: LEAD }); // 建基线
  agentTeams.tasks = [{ id: 'task-1', status: 'completed', subject: '实现' }];
  assert.ok(context.text({ agent: LEAD }).includes('⚠️'));

  // 指挥者调 todo_write 把清单同步掉。
  const { next } = spyNext({ kind: 'accept' });
  postExecute({ name: 'todo_write', agent: LEAD, arguments: { todos: [{ content: '实现', status: 'completed' }] } }, undefined, next);
  const after = context.text({ agent: LEAD });
  assert.ok(!after.includes('⚠️'), `同步后不应再报：${after}`);
  assert.ok(after.includes('计划清单 1/1 已完成'), after);
});

test('post-execute 只记录指挥者自己的 todo_write，teammate 的不记', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress' }] });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const postExecute = listenerOf(record, 'tools/post-execute');

  context.text({ agent: LEAD });
  agentTeams.tasks = [{ id: 'task-1', status: 'completed' }];
  const { next } = spyNext({ kind: 'accept' });
  postExecute({ name: 'todo_write', agent: TEAMMATE, arguments: { todos: [{ content: '子代理自己的清单', status: 'completed' }] } }, undefined, next);
  const text = context.text({ agent: LEAD });
  assert.ok(text.includes('计划清单：未建立'), `teammate 的清单不该影响指挥者看板：${text}`);
});

test('同一步里"先结算、再写清单"不会被误报成未同步', () => {
  // 模型经常在一步里连发两个工具：team_task_update(complete) + todo_write。
  // 任务板变化要等下一次求值才被账本观测到，如果只比 epoch，这次已经同步好的写入
  // 会被误判成"清单落后于结算"，然后白提醒一轮。
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress' }] });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const postExecute = listenerOf(record, 'tools/post-execute');

  context.text({ agent: LEAD }); // 基线：in_progress
  // 同一步：先结算，再写清单。
  agentTeams.tasks = [{ id: 'task-1', status: 'completed' }];
  postExecute({ name: 'todo_write', agent: LEAD, arguments: { todos: [{ content: '实现', status: 'completed' }] } }, undefined, spyNext({ kind: 'accept' }).next);

  const text = context.text({ agent: LEAD });
  assert.ok(!text.includes('⚠️'), `同一步内已同步，不该再提醒：${text}`);
});

test('回合结束兜底：未同步时注入一次，同一回合不重复', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress' }] });
  const { record } = boot({ agentTeams });
  const stop = listenerOf(record, 'agent/turn-stopping');
  const agent = injectableLead();
  const context = syncContext(record);
  const postExecute = listenerOf(record, 'tools/post-execute');

  // 规划阶段先写清单，再建基线（第一次观测）。
  postExecute({ name: 'todo_write', agent, arguments: { todos: [{ content: '实现', status: 'in_progress' }] } }, undefined, spyNext({ kind: 'accept' }).next);
  context.text({ agent });
  agentTeams.tasks = [{ id: 'task-1', status: 'completed' }];
  context.text({ agent }); // 观测到结算 → 账本里出现未同步项

  stop({ agent, turn: 3, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1, '应当注入一次');
  const message = agent.injected[0];
  assert.equal(message.role, 'user');
  assert.notEqual(message.source.kind, 'user', '不能冒充用户输入');
  const text = message.content.map((block) => block.text ?? '').join('');
  assert.ok(text.includes('结算同步'), text);
  assert.ok(text.includes('task-1'), text);
  assert.ok(text.includes('不要重复刚才的报告'), '要说明不要重复报告');

  // 同一回合再结束一次：不重复注入（否则可能死循环）。
  stop({ agent, turn: 3, signal: { aborted: false } });
  assert.equal(agent.injected.length, 1);

  // 新回合但已同步（清单写了）→ 不注入。
  agent.injected.length = 0;
  postExecute({ name: 'todo_write', agent, arguments: { todos: [{ content: '实现', status: 'completed' }] } }, undefined, spyNext({ kind: 'accept' }).next);
  stop({ agent, turn: 4, signal: { aborted: false } });
  assert.equal(agent.injected.length, 0, '同步完成后的新回合不该再注入');
});

test('回合结束兜底不碰 teammate / 已中断的回合 / 没有团队的状态', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress' }] });
  const { record } = boot({ agentTeams });
  const stop = listenerOf(record, 'agent/turn-stopping');
  const context = syncContext(record);
  const agent = injectableLead();

  context.text({ agent });
  agentTeams.tasks = [{ id: 'task-1', status: 'completed' }];
  context.text({ agent });

  stop({ agent: TEAMMATE, turn: 1, signal: { aborted: false } });
  stop({ agent, turn: 2, signal: { aborted: true } });
  stop({ agent: undefined, turn: 3 });
  assert.equal(agent.injected.length, 0);

  // 没有 agentTeams 服务的部署里连看板都没有，兜底自然也不该注入。
  const bare = boot();
  const bareAgent = injectableLead();
  listenerOf(bare.record, 'agent/turn-stopping')({ agent: bareAgent, turn: 1, signal: { aborted: false } });
  assert.equal(bareAgent.injected.length, 0);
});

test('syncGuard: false 时看板与兜底一起关掉（协议仍要求同步）', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress' }] });
  const settings = makeSettings({ options: { syncGuard: false } });
  const { record } = boot({ agentTeams, settings });
  const context = syncContext(record);
  const agent = injectableLead();

  context.text({ agent });
  agentTeams.tasks = [{ id: 'task-1', status: 'completed' }];
  assert.equal(context.text({ agent }), '');
  listenerOf(record, 'agent/turn-stopping')({ agent, turn: 1, signal: { aborted: false } });
  assert.equal(agent.injected.length, 0);
  // 协议里仍写着结算同步的要求 —— 关掉的只是"看板/兜底"这两样确定性设施。
  assert.ok(record.sections[0].text({ agent: LEAD }).includes('结算同步'));
});

test('派发通道观测：连续三次一次性 specialist 后，看板报"团队闲置"', () => {
  // 0.5.0 的依据：session-7064696b 里重启后 15 次派活全走一次性 specialist，Team 通道归零，
  // 任务板留着 6 项没收尾。这里验证"派活时记通道 → 看板据此提示 Team 优先"的接线。
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-14', status: 'pending', subject: '核验', ready: true }] });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const preExecuteListener = preExecute(record);

  context.text({ agent: LEAD }); // 建看板基线（同时把任务板记进账本）
  for (let index = 0; index < 3; index += 1) {
    preExecuteListener({ name: 'subagent_implementer', agent: LEAD }, spyNext({ kind: 'allow' }).next);
  }
  const text = context.text({ agent: LEAD });
  assert.ok(text.includes('派发通道：Team 0 次 / 一次性 specialist 3 次'), text);
  assert.ok(text.includes('一次性 specialist'), text);
  // 提示要给出 Team 通道的出路，而且不能把内部 issue code 泄漏到模型看得到的地方。
  assert.ok(text.includes('spawn_teammate'), text);
  assert.ok(!text.includes('channel-drift'), text);
});

test('Team 通道派活会记进配比；等待/读状态/子级派发都不记', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'in_progress', subject: '实现' }] });
  const { record } = boot({ agentTeams });
  const context = syncContext(record);
  const preExecuteListener = preExecute(record);
  context.text({ agent: LEAD });

  for (const exec of [
    { name: 'send_message', agent: LEAD },
    { name: 'spawn_teammate', agent: LEAD },
    { name: 'wait_agent', agent: LEAD }, // 等待不算派活
    { name: 'list_agents', agent: LEAD }, // 读状态不算派活
    { name: 'team_task_create', agent: LEAD }, // 建板不算派活
    { name: 'subagent_implementer', agent: TEAMMATE }, // 子级自己的派发
  ]) {
    preExecuteListener(exec, spyNext({ kind: 'allow' }).next);
  }
  const text = context.text({ agent: LEAD });
  assert.ok(text.includes('Team 2 次 / 一次性 specialist 0 次'), text);
});

test('syncGuard: false 时完全不记派发通道', () => {
  const agentTeams = makeAgentTeams({ tasks: [{ id: 'task-1', status: 'pending', subject: 'x', ready: true }] });
  const settings = makeSettings({ options: { syncGuard: false } });
  const { record } = boot({ agentTeams, settings });
  const preExecuteListener = preExecute(record);
  for (let index = 0; index < 3; index += 1) {
    preExecuteListener({ name: 'subagent_implementer', agent: LEAD }, spyNext({ kind: 'allow' }).next);
  }
  // 看板整体关闭，自然也不该有派发统计。
  assert.equal(syncContext(record).text({ agent: LEAD }), '');
});

test('看板里带上团队状态（teammate 的 running/inactive），但过滤掉 Lead 自己', () => {
  const agentTeams = makeAgentTeams({
    tasks: [{ id: 'task-1', status: 'completed' }],
    members: [
      { id: 'lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'm1', name: 'browser-ops', role: 'teammate', status: 'inactive' },
      { id: 'm2', name: 'expert-knowledge', role: 'teammate', status: 'running' },
    ],
  });
  const { record } = boot({ agentTeams });
  const text = syncContext(record).text({ agent: LEAD });
  assert.ok(text.includes('browser-ops inactive'), text);
  assert.ok(text.includes('expert-knowledge running'), text);
  assert.ok(!text.includes('lead running'), `不该把 Lead 自己算进团队状态：${text}`);
});

// ------------------------------------------------------------ specialist ---

test('空名册不注册任何 specialist preset 或工具', async () => {
  const { record } = boot();
  await flush();
  assert.equal(record.presets.length, 0);
  assert.deepEqual(record.tools.map((tool) => tool.name).filter((name) => name.startsWith('subagent_')), []);
  // 0.6.0：工单工具与名册无关，空名册也应注册（它们是模式自身的能力）。
  // 1.0.0：workerSessions 默认开启，默认还会多出四个 commander_worker_* 工具。
  assert.deepEqual(
    record.tools.map((tool) => tool.name).filter((name) => name.startsWith('commander_ticket')).sort(),
    ['commander_ticket_create', 'commander_ticket_update', 'commander_tickets'],
  );
  assert.deepEqual(
    record.tools.map((tool) => tool.name).filter((name) => name.startsWith('commander_worker_')).sort(),
    ['commander_worker_send', 'commander_worker_spawn', 'commander_worker_status', 'commander_worker_stop'],
  );
});

test('名册里每个 specialist 注册一个 preset 与一个前台工具', async () => {
  const { record } = boot({ specialists: ROSTER });
  await flush();

  assert.equal(record.presets.length, 2);
  assert.deepEqual(specialistTools(record).map((tool) => tool.name).sort(), ['subagent_architect', 'subagent_reviewer']);
  for (const preset of record.presets) {
    // preset 是完整组合：必须带能力行与人设行。
    assert.ok(preset.plugins.some((row) => row.name === 'dsh-commander-mode/specialist'));
    assert.ok(preset.plugins.some((row) => row.id === 'tool-fs'));
    assert.ok(!preset.plugins.some((row) => row.id === 'commander-mode-agent'), 'specialist 不能挂指挥者协议');
  }
  for (const tool of specialistTools(record)) {
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['task']);
    assert.equal(tool.output.schema.type, 'object');
  }
});

test('maxSpecialists 从配置服务读，名册被截断', async () => {
  const settings = makeSettings({ specialists: ROSTER, options: { maxSpecialists: 1 } });
  const { record } = boot({ settings });
  await flush();
  assert.equal(specialistTools(record).length, 1);
  assert.equal(specialistTools(record)[0].name, 'subagent_architect');
});

test('工具执行会带 agentPreset 与模型覆盖，并返回子代理结算文本', async () => {
  // 同步回退路径（0.5.0 行为）：显式关掉异步。
  const settings = makeSettings({ specialists: [ROSTER[1]], options: { asyncDelegation: false } });
  const { record } = boot({ settings });
  await flush();
  const tool = specialistTools(record)[0];
  assert.equal(tool.name, 'subagent_reviewer');

  const value = await tool.execute({ task: '审一下这个改动' }, { agent: LEAD, signal: new AbortController().signal });
  assert.equal(record.activations.length, 1);
  const activation = record.activations[0];
  assert.equal(activation.provider, 'spawn');
  assert.equal(activation.delivery, 'caller');
  assert.equal(activation.request.parent, LEAD);
  assert.equal(activation.request.agentOptions.provider, 'sub2api');
  assert.equal(activation.request.agentOptions.model, 'gpt-6.1-sol');
  assert.ok(activation.request.agentPreset.startsWith('commander-specialist-reviewer-'));
  assert.equal(activation.request.prompt[0].text, '审一下这个改动');

  assert.equal(value.childId, 'child-1');
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.text, '子代理答复');
  assert.equal(value.truncated, false);
});

test('名册更新后，旧工具执行会被拒绝（重新读名册）', async () => {
  const { record, settings } = boot({ specialists: [ROSTER[1]] });
  await flush();
  const tool = record.tools.find((entry) => entry.name === 'subagent_reviewer');
  assert.ok(tool);

  settings.update([]);
  await flush();
  await assert.rejects(
    async () => tool.execute({ task: 'x' }, { agent: LEAD, signal: new AbortController().signal }),
    /不在当前名册/u,
  );
});

test('配置服务广播变化时重建 specialist', async () => {
  const { record, settings } = boot({ specialists: [...ROSTER] });
  await flush();
  assert.deepEqual(specialistTools(record).map((tool) => tool.name).sort(), ['subagent_architect', 'subagent_reviewer']);

  settings.update([{ id: 'tester', provider: 'sub2api', model: 'glm-5.3-flash', description: '负责测试' }]);
  await flush();

  assert.equal(record.presets.length, 1);
  assert.ok(record.presets[0].id.startsWith('commander-specialist-tester-'));
  assert.deepEqual(specialistTools(record).map((tool) => tool.name), ['subagent_tester'], '旧工具已释放，只留新工具');
});

test('没有 specialist 服务的部署里只退化协议，不炸', async () => {
  const { record } = boot({ withSpecialistServices: false });
  await flush();
  assert.equal(record.presets.length, 0);
  assert.equal(record.tools.length, 0);
  assert.equal(record.sections.length, 1);
});

test('协议只在 specialist 真的安装成功后才点名工具', async () => {
  const { record } = boot({ specialists: ROSTER });
  const textBefore = record.sections[0].text({ agent: LEAD });
  assert.ok(!textBefore.includes('subagent_architect'), '安装完成前协议不应点名工具');

  await flush();
  const textAfter = record.sections[0].text({ agent: LEAD });
  assert.ok(textAfter.includes('subagent_architect'));
  assert.ok(textAfter.includes('subagent_reviewer'));
});

// ---------------------------------------------------------------- 0.6.0 工单 ---

/** 一个内存账本（真实 CommanderLedger，测试不碰磁盘）。 */
function memoryLedger() {
  let state = emptyLedger();
  const ledger = new CommanderLedger({
    file: 'memory.json',
    load: () => ({ state }),
    save: (_file, next) => {
      state = JSON.parse(JSON.stringify(next));
    },
  });
  ledger.load();
  return ledger;
}

/** 取 `tools/post-execute` 的监听器。 */
function postExecute(record) {
  return listenerOf(record, 'tools/post-execute');
}

/** 一张登记了计划授权与工单的账本。 */
function ledgerWithWork() {
  const ledger = memoryLedger();
  ledger.recordMandate({ sessionId: 'session-lead', planHash: 'h1', planSummary: '实现 X' });
  const ticket = ledger.createTicket({ sessionId: 'session-lead', title: '实现 X' });
  return { ledger, ticket };
}

test('0.6.0 门禁：没有计划授权时拒绝派发，并给出固定确认格式', async () => {
  const ledger = memoryLedger();
  const { record } = boot({ ledger });
  await flush();
  const listener = preExecute(record);

  const denied = await listener(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: 't-1' } },
    spyNext({ kind: 'allow' }).next,
  );
  assert.equal(denied.kind, 'deny');
  assert.ok(denied.reason.includes(PLAN_QUESTION_ID), denied.reason);
  assert.ok(denied.reason.includes(PLAN_CONFIRM_LABEL), denied.reason);
});

test('0.6.0 门禁：有授权 + 工单时放行，并记录 Assignment', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  const listener = preExecute(record);

  const decision = await listener(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    spyNext({ kind: 'allow' }).next,
  );
  assert.equal(decision?.kind, 'allow', '合法派发不应被拦');
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.assignments.length, 1);
  assert.equal(stored.assignments[0].channel, 'specialist');
});

test('0.6.0 门禁：有授权但不带工单 → 拒绝并提示 commander_ticket_create', async () => {
  const { ledger } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  const decision = await preExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X' } },
    spyNext({ kind: 'allow' }).next,
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /commander_ticket_create/u);
});

test('0.6.0 授权：计划确认 post-execute 记录 Mandate；未确认或跳过不记录', async () => {
  const ledger = memoryLedger();
  const { record } = boot({ ledger });
  await flush();
  const listener = postExecute(record);
  const plan = {
    id: PLAN_QUESTION_ID,
    question: '按这个计划执行吗？',
    options: [{ label: PLAN_CONFIRM_LABEL }, { label: '需要调整' }],
  };

  // 未选择"确认" → 不授权。
  await listener(
    { name: 'ask_user_question', agent: LEAD, arguments: { questions: [plan] } },
    { isError: false, value: { answers: [{ id: PLAN_QUESTION_ID, selected: ['需要调整'] }] } },
    spyNext().next,
  );
  assert.equal(ledger.activeMandate('session-lead'), null);

  // 选中"确认，开始执行" → 记录授权。
  await listener(
    { name: 'ask_user_question', agent: LEAD, arguments: { questions: [plan] } },
    { isError: false, value: { answers: [{ id: PLAN_QUESTION_ID, selected: [PLAN_CONFIRM_LABEL] }] } },
    spyNext().next,
  );
  const mandate = ledger.activeMandate('session-lead');
  assert.ok(mandate, '应记录计划授权');
  assert.equal(mandate.planSummary, '按这个计划执行吗？');
  assert.equal(mandate.planHash.length, 16);
});

test('0.6.0 回报：specialist 的 STATUS 行更新工单并补写 childId', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  await preExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    spyNext({ kind: 'allow' }).next,
  );
  await postExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    { isError: false, value: { childId: 'child-9', stopReason: 'completed', text: '改完了\nSTATUS: ready\n验证：单测通过' } },
    spyNext().next,
  );
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.status, 'review');
  assert.equal(stored.lastReport.status, 'ready');
  assert.equal(stored.assignments[0].ref, 'child-9');
  assert.notEqual(stored.assignments[0].endedAt, null);
});

test('0.6.0 回报：没有 STATUS 行按 progress 记录并点名格式缺失', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  await preExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    spyNext({ kind: 'allow' }).next,
  );
  await postExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    { isError: false, value: { childId: 'child-9', text: '做了一些事' } },
    spyNext().next,
  );
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.status, 'working');
  assert.match(stored.lastReport.summary, /STATUS/u);
});

test('0.6.0 看板：每轮上下文给出工单与授权；无工单时安静', async () => {
  const empty = memoryLedger();
  const quiet = boot({ ledger: empty });
  await flush();
  assert.equal(syncContext(quiet.record).text({ agent: LEAD }), '');

  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  const text = syncContext(record).text({ agent: LEAD });
  assert.match(text, /指挥者·工单看板/u);
  assert.match(text, /计划授权：已确认/u);
  assert.ok(text.includes(ticket.id), text);
});

test('ledger:false 时没有工单工具，也不拦截派发（0.5.0 行为）', async () => {
  const ledger = memoryLedger();
  const settings = makeSettings({ options: { ledger: false, requireMandate: false } });
  const { record } = boot({ settings, ledger });
  await flush();
  assert.deepEqual(record.tools.map((tool) => tool.name).filter((name) => name.startsWith('commander_')), []);
  const decision = await preExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X' } },
    spyNext({ kind: 'allow' }).next,
  );
  assert.equal(decision?.kind, 'allow');
});

// ---------------------------------------------------------------- 0.7.0 异步 ---

/** 一个可手动结算的 Promise（不需要额外依赖）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 记录 `agent.steer()` 的指挥者（会话 id 与 ledgerWithWork 一致）。 */
function steeringAgent(steers) {
  return {
    id: 'session-lead',
    session: { id: 'session-lead', header: { id: 'session-lead' } },
    steer: (message) => steers.push(message),
  };
}

test('0.7.0 异步：工具立即返回 started；完成后写账本并 steer 唤醒指挥者', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const settlement = deferred();
  const settings = makeSettings({ specialists: [ROSTER[0]] });
  const { record } = boot({ settings, ledger, settlement: settlement.promise });
  await flush();
  const tool = specialistTools(record)[0];
  const steers = [];
  const agent = steeringAgent(steers);

  // 真实顺序：pre-execute 先记 Assignment，工具再异步启动。
  await preExecute(record)(
    { name: tool.name, agent, arguments: { task: '实现 X', ticket: ticket.id } },
    spyNext({ kind: 'allow' }).next,
  );
  const started = await tool.execute(
    { task: '实现 X', ticket: ticket.id },
    { agent, signal: new AbortController().signal },
  );
  assert.equal(started.async, true);
  assert.equal(started.stopReason, 'started');
  assert.match(started.text, /已启动/u);
  assert.equal(record.activations.length, 1);
  assert.equal(record.activations[0].delivery, 'caller');
  // 工具返回时不应有完成通知，也不应写完成状态。
  assert.equal(steers.length, 0);
  assert.equal(ledger.getTicket(ticket.id, 'session-lead').status, 'working');

  settlement.resolve({ output: [{ type: 'text', text: '改完了\nSTATUS: ready\n验证：单测通过' }], stopReason: 'completed' });
  await flush();
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.status, 'review');
  assert.equal(stored.lastReport.status, 'ready');
  assert.equal(stored.assignments[0].ref, 'child-1');
  assert.notEqual(stored.assignments[0].endedAt, null);
  assert.equal(steers.length, 1);
  const notice = steers[0].content[0].text;
  assert.match(notice, /【指挥者·派工完成】/u);
  assert.ok(notice.includes(ticket.id), notice);
  assert.match(notice, /STATUS: ready/u);
  assert.match(notice, /不要用 `wait_agent`/u);
  assert.equal(steers[0].source.kind, 'dsh-commander-mode');
});

test('0.7.0 异步：结算失败记 failed 并 steer（带工单与错误）', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const settlement = deferred();
  const settings = makeSettings({ specialists: [ROSTER[0]] });
  const { record } = boot({ settings, ledger, settlement: settlement.promise });
  await flush();
  const steers = [];
  const agent = steeringAgent(steers);
  await specialistTools(record)[0].execute(
    { task: '实现 X', ticket: ticket.id },
    { agent, signal: new AbortController().signal },
  );
  settlement.reject(new Error('child 崩了'));
  await flush();
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.status, 'failed');
  assert.match(stored.lastReport.summary, /child 崩了/u);
  assert.equal(steers.length, 1);
  assert.match(steers[0].content[0].text, /失败/u);
  assert.match(steers[0].content[0].text, /child 崩了/u);
});

test('0.7.0 异步：容量上限在启动前拒绝（不会先启动 child）', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const settlement = deferred();
  const settings = makeSettings({ specialists: [ROSTER[0]], options: { maxAsyncTasks: 1 } });
  const { record } = boot({ settings, ledger, settlement: settlement.promise });
  await flush();
  const tool = specialistTools(record)[0];
  const agent = steeringAgent([]);
  await tool.execute({ task: 'A', ticket: ticket.id }, { agent, signal: new AbortController().signal });
  await assert.rejects(
    async () => tool.execute({ task: 'B', ticket: ticket.id }, { agent, signal: new AbortController().signal }),
    /在飞的一次性派发已达上限/u,
  );
  assert.equal(record.activations.length, 1, '超限时不应再启动第二个 child');
  settlement.resolve({ output: [{ type: 'text', text: 'done\nSTATUS: ready' }], stopReason: 'completed' });
  await flush();
});

test('0.7.0 异步：受理结果不会被 post-execute 提前结算 Assignment', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  await preExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    spyNext({ kind: 'allow' }).next,
  );
  const before = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(before.assignments.length, 1);
  assert.equal(before.assignments[0].endedAt, null);

  await postExecute(record)(
    { name: 'subagent_implementer', agent: LEAD, arguments: { task: '实现 X', ticket: ticket.id } },
    { isError: false, value: { childId: 'child-1', stopReason: 'started', text: '已启动', truncated: false, async: true } },
    spyNext().next,
  );
  const after = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(after.assignments[0].endedAt, null, '异步受理不应结束 Assignment');
  assert.equal(after.lastReport, null, '异步受理不应记录回报');
});

// ---------------------------------------------------------------- 0.8.0 Worker ---

test('1.0.0：显式 workerSessions:false 不注册 Worker 工具', async () => {
  const settings = makeSettings({ options: { workerSessions: false } });
  const { record } = boot({ settings, ledger: memoryLedger() });
  await flush();
  assert.deepEqual(record.tools.map((tool) => tool.name).filter((name) => name.startsWith('commander_worker_')), []);
});

test('0.8.0：workerSessions:true 时注册四个 Worker 工具，spawn 委托给服务', async () => {
  const calls = [];
  const workers = {
    spawn: async (args) => { calls.push(['spawn', args]); return { sessionId: 'worker-t-1' }; },
    send: async (args) => { calls.push(['send', args]); return { ok: true }; },
    status: async (args) => { calls.push(['status', args]); return { ticket: {} }; },
    stop: async (args) => { calls.push(['stop', args]); return { ok: true }; },
  };
  const settings = makeSettings({ options: { workerSessions: true } });
  const { record } = boot({ settings, ledger: memoryLedger(), workers });
  await flush();
  const names = record.tools.map((tool) => tool.name).filter((name) => name.startsWith('commander_worker_'));
  assert.deepEqual(names.sort(), [
    'commander_worker_send',
    'commander_worker_spawn',
    'commander_worker_status',
    'commander_worker_stop',
  ]);
  const spawn = record.tools.find((tool) => tool.name === 'commander_worker_spawn');
  const value = await spawn.execute({ ticket: 't-1', task: '实现 X' }, { agent: LEAD, signal: new AbortController().signal });
  assert.equal(value.sessionId, 'worker-t-1');
  assert.equal(calls[0][0], 'spawn');
  assert.equal(calls[0][1].ticketId, 't-1');
});

test('0.8.0：worker 工具在服务缺失时给可执行错误（而不是假装成功）', async () => {
  const settings = makeSettings({ options: { workerSessions: true } });
  const { record } = boot({ settings, ledger: memoryLedger() });
  await flush();
  const spawn = record.tools.find((tool) => tool.name === 'commander_worker_spawn');
  await assert.rejects(
    async () => spawn.execute({ ticket: 't-1', task: '实现 X' }, { agent: LEAD, signal: new AbortController().signal }),
    /Worker Session 服务不可用/u,
  );
});

// ---------------------------------------------------------------- 0.8.1 派发失败记账 ---

test('0.8.1 派发报错：结算未完成的 Assignment 并记 failed（不留 working 幽灵）', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  await preExecute(record)(
    { name: 'commander_worker_spawn', agent: LEAD, arguments: { ticket: ticket.id, task: 'x' } },
    spyNext({ kind: 'allow' }).next,
  );
  assert.equal(ledger.getTicket(ticket.id, 'session-lead').assignments[0].endedAt, null);

  await postExecute(record)(
    { name: 'commander_worker_spawn', agent: LEAD, arguments: { ticket: ticket.id, task: 'x' } },
    { isError: true, content: [{ type: 'text', text: 'Error: 缺少宿主服务：sessionController、workspaceRegistry' }] },
    spyNext().next,
  );
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.status, 'failed');
  assert.match(stored.lastReport.summary, /派发失败/u);
  assert.match(stored.lastReport.summary, /sessionController/u);
  assert.notEqual(stored.assignments[0].endedAt, null, '失败的 Assignment 必须结算');
  assert.match(stored.lastReport.question, /重试|换通道/u);
});

test('0.8.1 派发报错：已有更新回报时不覆盖', async () => {
  const { ledger, ticket } = ledgerWithWork();
  const { record } = boot({ ledger });
  await flush();
  await preExecute(record)(
    { name: 'commander_worker_spawn', agent: LEAD, arguments: { ticket: ticket.id, task: 'x' } },
    spyNext({ kind: 'allow' }).next,
  );
  // 模拟已有一次更新的回报（例如 worker 已汇报）。
  await postExecute(record)(
    { name: 'commander_worker_spawn', agent: LEAD, arguments: { ticket: ticket.id, task: 'x' } },
    { isError: false, value: { sessionId: 'worker-t-1' } },
    spyNext().next,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  ledger.recordReport(ticket.id, 'session-lead', { status: 'ready', summary: '已就绪' });
  await postExecute(record)(
    { name: 'commander_worker_spawn', agent: LEAD, arguments: { ticket: ticket.id, task: 'x' } },
    { isError: true, content: [{ type: 'text', text: 'Error: late failure' }] },
    spyNext().next,
  );
  const stored = ledger.getTicket(ticket.id, 'session-lead');
  assert.equal(stored.lastReport.status, 'ready', '更新回报不应被迟到错误覆盖');
});

// ---------------------------------------------------------------- 2.0.0 等待门禁 ---

test('2.0.0 等待门禁：超长 wait_agent 被拒绝，短等待与读状态工具放行', async () => {
  // 依据：历史会话里 `wait_agent` 单次最长 127.5 分钟、会话累计 11 小时。用户明确要求
  // "等子代理不要一直等"，所以这条在 `tools/pre-execute` 上做成确定性拒绝。
  const listener = preExecute(boot().record);
  const denied = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 600000 } }, spyNext().next);
  assert.equal(denied.kind, 'deny');
  assert.ok(denied.reason.includes('120000'), denied.reason);
  assert.ok(denied.reason.includes('短等待'), denied.reason);

  const allowed = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 60000 } }, spyNext().next);
  assert.deepEqual(allowed, { kind: 'allow' });

  // 只拦超长等待：读状态 / 唤醒队友的工具不受影响，否则模型被拒后没法推进。
  for (const toolName of ['list_agents', 'team_task_list', 'send_message']) {
    const decision = await listener({ name: toolName, agent: LEAD, arguments: { timeout_ms: 1800000 } }, spyNext().next);
    assert.deepEqual(decision, { kind: 'allow' }, `${toolName} 不该被等待门禁拦`);
  }
});

test('2.0.0 等待门禁：maxWaitMs=0 时关闭（配置服务实时生效）', async () => {
  const settings = makeSettings({ options: { maxWaitMs: 0 } });
  const { record } = boot({ settings });
  const listener = preExecute(record);
  const decision = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 1800000 } }, spyNext().next);
  assert.deepEqual(decision, { kind: 'allow' });
});
