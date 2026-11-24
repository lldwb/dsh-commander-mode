/**
 * 「使用指挥官模式时，智能体团队默认启用且不可关闭」（6.0.0，用户 2026-11-12 硬要求）。
 *
 * 这是本次改造的**验收核心**：DSH 0.2.2-rc.2 把 Agent Teams 改成按根会话选择
 * （`team/mode` 事件），新会话默认关闭；而指挥官模式的三层指挥链完全建立在 Team 上。
 *
 * 本文件钉四件事：
 *
 * 1. `agentPreset === 'commander'` 的**根** agent 创建时 → `setEnabled(agent, true)`；
 * 2. 指挥官会话的 `team/mode { enabled:false }` → 立刻重开；
 * 3. 非指挥官会话 / 子代理（继承父 preset）**不受影响**；
 * 4. `agentTeams` 服务缺失 → **显式 error 日志**（硬依赖，不静默降级）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_PRESET_SELECTED_EVENT,
  COMMANDER_PRESET_ID,
  TEAM_MODE_EVENT,
  agentPresetOf,
  currentAgentPreset,
  deferToNextTask,
  installForcedTeamMode,
  isCommanderSession,
  isRootAgent,
  liveAgentOf,
} from '../lib/team-mode.js';

/** 让排队的微任务跑完（监听器里是 async 的）。 */
async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 一个最小的 profile 顶层 ctx 替身。
 *
 * @param {object} [options] - 夹具开关。
 * @param {object} [options.agentTeams] - `agentTeams` 服务替身；`null` 表示缺失。
 * @param {object} [options.agents] - `agents` 服务替身。
 * @param {object} [options.subagents] - `subagents` 服务替身。
 * @returns {{ ctx: object, record: object }} 上下文与记录。
 */
function makeHostCtx({ agentTeams = makeTeamService(), agents, subagents, agentPresets } = {}) {
  const record = {
    listeners: [],
    infos: [],
    warnings: [],
    errors: [],
    enabledCalls: [],
  };
  const logger = {
    info: (...args) => record.infos.push(args.map(String).join(' ')),
    warn: (...args) => record.warnings.push(args.map(String).join(' ')),
    error: (...args) => record.errors.push(args.map(String).join(' ')),
    debug: () => {},
  };
  const services = {
    ...(agentTeams === null ? {} : { agentTeams }),
    ...(agents === undefined ? {} : { agents }),
    ...(subagents === undefined ? {} : { subagents }),
    ...(agentPresets === undefined ? {} : { agentPresets }),
  };
  const ctx = {
    logger,
    on: (event, listener) => {
      record.listeners.push({ event, listener });
      return () => {};
    },
    get: (name) => services[name],
  };
  return { ctx, record };
}

/**
 * `agentTeams` 服务替身：记录 setEnabled 调用，状态按调用更新。
 *
 * @param {object} [options] - 夹具开关。
 * @param {boolean} [options.enabled] - 初始是否已开启。
 * @param {Error} [options.failWith] - `setEnabled` 抛错。
 * @returns {object} 服务替身。
 */
function makeTeamService({ enabled = false, failWith } = {}) {
  let state = enabled;
  const calls = [];
  return {
    calls,
    isEnabled: () => state,
    setEnabled: async (agent, next) => {
      calls.push({ agent, enabled: next });
      if (failWith !== undefined) throw failWith;
      state = next;
    },
  };
}

/** 取第一个匹配事件的监听器。 */
function listenerOf(record, event) {
  const entry = record.listeners.find((item) => item.event === event);
  if (entry === undefined) throw new Error(`没有注册 ${event} 监听器`);
  return entry.listener;
}

/** 一个 commander 根 agent。 */
const COMMANDER_ROOT = Object.freeze({
  id: 'session-root',
  session: { id: 'session-root', header: { id: 'session-root', agentPreset: COMMANDER_PRESET_ID } },
});

/** 一个非指挥官根 agent（standard 模式）。 */
const STANDARD_ROOT = Object.freeze({
  id: 'session-standard',
  session: { id: 'session-standard', header: { id: 'session-standard', agentPreset: 'standard' } },
});

/** 一个 commander 会话下的子代理（继承父 preset，但 origin=subagent）。 */
const COMMANDER_CHILD = Object.freeze({
  id: 'session-child',
  session: {
    id: 'session-child',
    header: { id: 'session-child', agentPreset: COMMANDER_PRESET_ID, origin: 'subagent', parentSession: 'session-root', delegationDepth: 1 },
  },
});

/** 一个「根」subagents 服务：只有登记过的 agent 才是根。 */
function makeSubagents(rootAgent) {
  return {
    rootOf: (agent) => {
      if (agent === rootAgent) return rootAgent;
      throw new Error('agent has no active runtime owner');
    },
  };
}

// ---------------------------------------------------------------- 辅助函数 ---

test('agentPresetOf / isCommanderSession：只认指挥官根会话', () => {
  const { ctx } = makeHostCtx();
  assert.equal(agentPresetOf(COMMANDER_ROOT.session), COMMANDER_PRESET_ID);
  assert.equal(agentPresetOf(STANDARD_ROOT.session), 'standard');
  assert.equal(agentPresetOf(undefined), undefined);
  assert.equal(agentPresetOf({ header: {} }), undefined);
  assert.equal(agentPresetOf({ header: { agentPreset: '' } }), undefined);

  assert.equal(isCommanderSession(ctx, COMMANDER_ROOT.session), true);
  assert.equal(isCommanderSession(ctx, STANDARD_ROOT.session), false);
  // 子代理继承父 preset，但 origin=subagent → 不是"根会话"
  assert.equal(isCommanderSession(ctx, COMMANDER_CHILD.session), false);
  assert.equal(isCommanderSession(ctx, undefined), false);
});

test('currentAgentPreset：优先读 agentPresets 投影（支持在输入框里切模式）', () => {
  // 会话头是创建时的 standard，但投影已被 agent-preset/selected 改成 commander ——
  // Web 里"先建会话再选指挥者模式"就是这条路径。
  const presets = { presetForSession: (session) => (session === COMMANDER_ROOT.session ? COMMANDER_PRESET_ID : 'standard') };
  const { ctx } = makeHostCtx({ agentPresets: presets });
  assert.equal(currentAgentPreset(ctx, COMMANDER_ROOT.session), COMMANDER_PRESET_ID);
  assert.equal(currentAgentPreset(ctx, STANDARD_ROOT.session), 'standard');
  // 投影读不到时回退 header
  const bare = makeHostCtx().ctx;
  assert.equal(currentAgentPreset(bare, COMMANDER_ROOT.session), COMMANDER_PRESET_ID);
  const throwing = { presetForSession: () => { throw new Error('boom'); } };
  assert.equal(currentAgentPreset(makeHostCtx({ agentPresets: throwing }).ctx, COMMANDER_ROOT.session), COMMANDER_PRESET_ID);
});

test('agent/created：header 是 standard 但投影已是 commander → 也开启团队', async () => {
  const agentTeams = makeTeamService();
  const presets = { presetForSession: () => COMMANDER_PRESET_ID };
  const { ctx, record } = makeHostCtx({ agentTeams, agentPresets: presets, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await listenerOf(record, 'agent/created')({ agent: COMMANDER_ROOT, source: 'startup' });
  await flush();
  assert.deepEqual(agentTeams.calls.map((call) => call.enabled), [true]);
});

test('isRootAgent：subagent 来源一律不是根；rootOf 抛错按"不是根"处理', () => {
  const { ctx } = makeHostCtx({ subagents: makeSubagents(COMMANDER_ROOT) });
  assert.equal(isRootAgent(ctx, COMMANDER_ROOT), true);
  assert.equal(isRootAgent(ctx, COMMANDER_CHILD), false);
  assert.equal(isRootAgent(ctx, STANDARD_ROOT), false); // rootOf 抛错
  // 没有 subagents 服务时退回 header 判据
  const bare = makeHostCtx().ctx;
  assert.equal(isRootAgent(bare, COMMANDER_ROOT), true);
  assert.equal(isRootAgent(bare, COMMANDER_CHILD), false);
});

// ------------------------------------------------ 通道 1：创建即开启 ---

test('agent/created：指挥官根 agent → setEnabled(true)', async () => {
  const agentTeams = makeTeamService();
  const { ctx, record } = makeHostCtx({ agentTeams, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  const created = listenerOf(record, 'agent/created');
  await created({ agent: COMMANDER_ROOT, source: 'startup' });
  await flush();

  assert.deepEqual(agentTeams.calls.map((call) => call.enabled), [true]);
  assert.equal(agentTeams.calls[0].agent, COMMANDER_ROOT);
  assert.equal(agentTeams.isEnabled(), true);
  assert.ok(record.infos.some((line) => line.includes('已为指挥官会话开启智能体团队')));
});

test('agent/created：非指挥官会话不受影响', async () => {
  const agentTeams = makeTeamService();
  const { ctx, record } = makeHostCtx({ agentTeams, subagents: makeSubagents(STANDARD_ROOT) });
  installForcedTeamMode(ctx);

  await listenerOf(record, 'agent/created')({ agent: STANDARD_ROOT, source: 'startup' });
  await flush();
  assert.deepEqual(agentTeams.calls, []);
});

test('agent/created：子代理（继承 commander preset）不受影响', async () => {
  const agentTeams = makeTeamService();
  const { ctx, record } = makeHostCtx({ agentTeams, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await listenerOf(record, 'agent/created')({ agent: COMMANDER_CHILD, source: 'startup' });
  await flush();
  assert.deepEqual(agentTeams.calls, [], '不能对子级调 setEnabled（服务会以 TEAM_LEAD_REQUIRED 拒绝）');
});

test('agent/created：已经开启时不重复写 team/mode 事件（幂等）', async () => {
  const agentTeams = makeTeamService({ enabled: true });
  const { ctx, record } = makeHostCtx({ agentTeams, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await listenerOf(record, 'agent/created')({ agent: COMMANDER_ROOT, source: 'resume' });
  await flush();
  assert.deepEqual(agentTeams.calls, [], 'isEnabled() === true 时不应再 setEnabled');
});

// ------------------------------------------------ 通道 2：被关即重开 ---

test('session/event：指挥官会话的 team/mode 被关闭 → 立刻重新开启', async () => {
  const agentTeams = makeTeamService({ enabled: true });
  const agents = { get: (id) => (id === COMMANDER_ROOT.id ? COMMANDER_ROOT : undefined) };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  const sessionEvent = listenerOf(record, 'session/event');
  // 模拟"被关掉"：先把服务状态置为 false，再投递事件（真实服务是 append 后投影更新）。
  await agentTeams.setEnabled(COMMANDER_ROOT, false);
  agentTeams.calls.length = 0;

  sessionEvent(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  await flush();

  assert.deepEqual(agentTeams.calls.map((call) => call.enabled), [true]);
  assert.equal(agentTeams.isEnabled(), true);
  assert.ok(record.warnings.some((line) => line.includes('team/mode 被关闭')));
  assert.ok(record.infos.some((line) => line.includes('已重新开启智能体团队')));
});

test('session/event：开启事件与非指挥官会话都不触发重开', async () => {
  const agentTeams = makeTeamService({ enabled: true });
  const agents = {
    get: (id) => {
      if (id === COMMANDER_ROOT.id) return COMMANDER_ROOT;
      if (id === STANDARD_ROOT.id) return STANDARD_ROOT;
      return undefined;
    },
  };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);
  const sessionEvent = listenerOf(record, 'session/event');

  // enabled:true（包括我们自己写回去的那条）→ 忽略
  sessionEvent(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: true } });
  // 非指挥官会话被关 → 忽略
  sessionEvent(STANDARD_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  // 其它事件类型 → 忽略
  sessionEvent(COMMANDER_ROOT.session, { type: 'some/other', data: { enabled: false } });
  await flush();

  assert.deepEqual(agentTeams.calls, []);
  assert.deepEqual(record.warnings, []);
});

test('session/event：防循环 —— 重开期间同一会话的再次关闭事件不会重复触发', async () => {
  const agentTeams = makeTeamService({ enabled: true });
  const agents = { get: () => COMMANDER_ROOT };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);
  const sessionEvent = listenerOf(record, 'session/event');

  await agentTeams.setEnabled(COMMANDER_ROOT, false);
  agentTeams.calls.length = 0;
  // 连续两条关闭事件（真实里 setEnabled 自己的 append 只产生 enabled:true，这里模拟极端情况）
  sessionEvent(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  sessionEvent(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  await flush();

  assert.equal(agentTeams.calls.length, 1, '同一会话的重开不能并发触发两次');
});

test('session/event：会话没有活着的 agent 时只记警告，不崩', async () => {
  const agentTeams = makeTeamService({ enabled: true });
  const agents = { get: () => undefined };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await agentTeams.setEnabled(COMMANDER_ROOT, false);
  agentTeams.calls.length = 0;
  listenerOf(record, 'session/event')(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  await flush();

  assert.deepEqual(agentTeams.calls, []);
  assert.ok(record.warnings.some((line) => line.includes('没有活着的 agent')));
});

// ------------------------------------------------ 硬依赖：缺失要显式报错 ---

test('agentTeams 缺失：记显式 error 日志（硬依赖，不静默降级）', async () => {
  const { ctx, record } = makeHostCtx({ agentTeams: null, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await listenerOf(record, 'agent/created')({ agent: COMMANDER_ROOT, source: 'startup' });
  await flush();

  assert.equal(record.errors.length, 1);
  assert.ok(record.errors[0].includes('缺少 agentTeams 服务'));
  assert.ok(record.errors[0].includes('硬依赖'));
});

test('setEnabled 抛错：记 error 日志，不把 agent 创建弄挂', async () => {
  const agentTeams = makeTeamService({ failWith: new Error('TEAM_LEAD_REQUIRED') });
  const { ctx, record } = makeHostCtx({ agentTeams, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  await assert.doesNotReject(async () => {
    await listenerOf(record, 'agent/created')({ agent: COMMANDER_ROOT, source: 'startup' });
    await flush();
  });
  assert.ok(record.errors.some((line) => line.includes('强制开启智能体团队失败')));
});

test('没有 setEnabled 的服务也算缺失（显式报错）', async () => {
  const { ctx, record } = makeHostCtx({ agentTeams: { isEnabled: () => false }, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);
  await listenerOf(record, 'agent/created')({ agent: COMMANDER_ROOT, source: 'startup' });
  await flush();
  assert.ok(record.errors.some((line) => line.includes('没有 setEnabled()')));
});

// ------------------------------------------------ 没有"关闭开关" ---

test('本模块不提供任何关闭团队的入口（没有配置项 / 没有关闭函数）', async () => {
  const mod = await import('../lib/team-mode.js');
  const exported = Object.keys(mod).sort();
  assert.deepEqual(exported, [
    'AGENT_PRESET_SELECTED_EVENT',
    'COMMANDER_PRESET_ID',
    'TEAM_MODE_EVENT',
    'TEAM_SERVICE_NAME',
    'agentPresetOf',
    'currentAgentPreset',
    'deferToNextTask',
    'installForcedTeamMode',
    'isCommanderSession',
    'isRootAgent',
    'liveAgentOf',
  ]);
  // 导出里不允许出现"关闭/禁用"语义的名字
  for (const name of exported) {
    assert.ok(!/disable|turnoff|turnOff|setTeamMode|allowTeamOff/iu.test(name), `不应导出关闭入口：${name}`);
  }
});

// ------------------------------------------------ 通道 2a：切到指挥官即开启 ---

test('session/event：agent-preset/selected → commander 时对活 agent 开启团队', async () => {
  const agentTeams = makeTeamService();
  const agents = { get: (id) => (id === COMMANDER_ROOT.id ? COMMANDER_ROOT : undefined) };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  listenerOf(record, 'session/event')(COMMANDER_ROOT.session, {
    type: AGENT_PRESET_SELECTED_EVENT,
    data: { agentPreset: COMMANDER_PRESET_ID },
  });
  await flush();

  assert.deepEqual(agentTeams.calls.map((call) => call.enabled), [true]);
  assert.equal(agentTeams.isEnabled(), true);
  assert.ok(record.infos.some((line) => line.includes('会话切换到指挥官模式')));
});

test('session/event：切到别的 preset / 无活 agent 时不动', async () => {
  const agentTeams = makeTeamService();
  const agents = { get: () => undefined };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);
  const sessionEvent = listenerOf(record, 'session/event');

  // 切到 standard → 不动
  sessionEvent(COMMANDER_ROOT.session, { type: AGENT_PRESET_SELECTED_EVENT, data: { agentPreset: 'standard' } });
  // 切到 commander 但没有活 agent（preset 挂载发生在发布之前）→ 静默跳过，不告警
  sessionEvent(COMMANDER_ROOT.session, { type: AGENT_PRESET_SELECTED_EVENT, data: { agentPreset: COMMANDER_PRESET_ID } });
  await flush();

  assert.deepEqual(agentTeams.calls, []);
  assert.deepEqual(record.warnings, []);
});

test('liveAgentOf：读不到 agents 服务 / 会话没有 id 时返回 undefined', () => {
  assert.equal(liveAgentOf(makeHostCtx().ctx, COMMANDER_ROOT.session), undefined);
  const withAgents = makeHostCtx({ agents: { get: () => COMMANDER_ROOT } }).ctx;
  assert.equal(liveAgentOf(withAgents, COMMANDER_ROOT.session), COMMANDER_ROOT);
  assert.equal(liveAgentOf(withAgents, {}), undefined);
  assert.equal(liveAgentOf(withAgents, undefined), undefined);
});

// ------------------------------------------------ 写操作必须推迟（实测） ---

test('deferToNextTask：任务在下一个宏任务才执行（不在当前同步栈）', async () => {
  const order = [];
  deferToNextTask(() => order.push('deferred'));
  order.push('sync');
  // 同步栈里只应有 sync；deferred 必须更晚
  assert.deepEqual(order, ['sync']);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['sync', 'deferred']);
});

test('session/event：setEnabled 不在 append 发布栈里同步调用（重入保护）', async () => {
  // 沙箱实测：观察者里同步调 setEnabled 会抛
  // "session append cannot reenter while another append is being published"。
  // 这里用一个"同步栈里调用就报错"的服务替身钉住：handler 返回后（同一同步栈）不能有调用。
  let inObserverStack = true;
  const calls = [];
  const agentTeams = {
    isEnabled: () => false,
    setEnabled: async (agent, next) => {
      if (inObserverStack) throw new Error('session append cannot reenter while another append is being published');
      calls.push({ agent, enabled: next });
    },
  };
  const agents = { get: () => COMMANDER_ROOT };
  const { ctx, record } = makeHostCtx({ agentTeams, agents, subagents: makeSubagents(COMMANDER_ROOT) });
  installForcedTeamMode(ctx);

  listenerOf(record, 'session/event')(COMMANDER_ROOT.session, { type: TEAM_MODE_EVENT, data: { enabled: false } });
  // handler 已返回，但仍处于"观察者栈"语义下：同步阶段不应有调用
  assert.deepEqual(calls, []);
  inObserverStack = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls.map((call) => call.enabled), [true]);
  assert.deepEqual(record.errors, [], '推迟后不应再触发重入错误');
});
