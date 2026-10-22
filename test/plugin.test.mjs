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
function makeCtx({ withSkills = true, withSpecialistServices = true, settings = makeSettings(), settlement } = {}) {
  const record = {
    sections: [],
    skills: [],
    listeners: [],
    warnings: [],
    effects: [],
    tools: [],
    presets: [],
    activations: [],
    settingsPolicies: [],
  };
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (...args) => record.warnings.push(args.map(String).join(' ')),
  };
  const services = {
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

/** 一个 Lead agent。 */
const LEAD = { id: 'session-lead', session: { header: { id: 'session-lead' } } };

/** 一个 teammate。 */
const TEAMMATE = {
  id: 'session-child',
  session: { header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
};

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

test('注册了 tools/pre-execute 监听器', () => {
  const { record } = boot();
  assert.deepEqual(record.listeners.map((item) => item.event), ['tools/pre-execute']);
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

// ------------------------------------------------------------ specialist ---

test('空名册不注册任何 specialist preset 或工具', async () => {
  const { record } = boot();
  await flush();
  assert.equal(record.presets.length, 0);
  assert.equal(record.tools.length, 0);
});

test('名册里每个 specialist 注册一个 preset 与一个前台工具', async () => {
  const { record } = boot({ specialists: ROSTER });
  await flush();

  assert.equal(record.presets.length, 2);
  assert.deepEqual(record.tools.map((tool) => tool.name).sort(), ['subagent_architect', 'subagent_reviewer']);
  for (const preset of record.presets) {
    // preset 是完整组合：必须带能力行与人设行。
    assert.ok(preset.plugins.some((row) => row.name === 'dsh-commander-mode/specialist'));
    assert.ok(preset.plugins.some((row) => row.id === 'tool-fs'));
    assert.ok(!preset.plugins.some((row) => row.id === 'commander-mode-agent'), 'specialist 不能挂指挥者协议');
  }
  for (const tool of record.tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['task']);
    assert.equal(tool.output.schema.type, 'object');
  }
});

test('maxSpecialists 从配置服务读，名册被截断', async () => {
  const settings = makeSettings({ specialists: ROSTER, options: { maxSpecialists: 1 } });
  const { record } = boot({ settings });
  await flush();
  assert.equal(record.tools.length, 1);
  assert.equal(record.tools[0].name, 'subagent_architect');
});

test('工具执行会带 agentPreset 与模型覆盖，并返回子代理结算文本', async () => {
  const { record } = boot({ specialists: [ROSTER[1]] });
  await flush();
  const tool = record.tools[0];
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
  assert.deepEqual(record.tools.map((tool) => tool.name).sort(), ['subagent_architect', 'subagent_reviewer']);

  settings.update([{ id: 'tester', provider: 'sub2api', model: 'glm-5.3-flash', description: '负责测试' }]);
  await flush();

  assert.equal(record.presets.length, 1);
  assert.ok(record.presets[0].id.startsWith('commander-specialist-tester-'));
  assert.deepEqual(record.tools.map((tool) => tool.name), ['subagent_tester'], '旧工具已释放，只留新工具');
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
