/**
 * 配置 schema 与读取器的测试（`lib/config.js`）。
 *
 * 这一层同时是**设置页的契约**与**运行时的兜底**，两边出错的方式不一样：
 *
 * - schema 错：设置页拿不到字段（字段没声明/没 `volatile`），或者用户合法的输入被拒；
 *   反过来，本该拒绝的名册被接受，`lib/specialists.js` 就会拿着非法 id 去注册工具，
 *   整个注册表跟着失败。
 * - 读取器错：配置来自 profile patch 手写、Loader 的 volatile 引用、或设置页保存后的
 *   引用对象。形态没兜住，名册/门禁/协议会在某条路径上静默用错值 —— 这类"看起来
 *   生效了其实没有"的故障最难查。
 *
 * 每条断言都对应一个具体的配置故障场景。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_BLOCKED_TOOLS } from '../lib/guard.js';
import { DEFAULT_SPECIALISTS, defaultSpecialistIds } from '../lib/presets.js';
import * as configModule from '../lib/config.js';
import {
  Config,
  KNOWN_CONFIG_KEYS,
  readBlockedTools,
  readFlag,
  readMaxSpecialists,
  readMaxTeammates,
  readPositiveNumber,
  readSpecialists,
  readString,
  resolveConfig,
} from '../lib/config.js';

/** 一份合法的名册条目。 */
function specialist(overrides = {}) {
  return {
    id: 'architect',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    description: '负责系统架构与拆分',
    ...overrides,
  };
}

// ---------------------------------------------------------------- schema ---

test('默认配置保持 0.1.x 的行为', () => {
  // Loader 不传 config（或用户只在 patch 里写了部分键）时，这里就是实际生效的配置。
  // 任何一个默认值变了都会静默改变模式行为：例如 confirmPlan 变 false，
  // 「规划完成后先让用户确认」这条核心要求就凭空消失了。
  const config = Config();
  assert.equal(config.confirmPlan, true);
  assert.equal(config.escalateOnConflict, true);
  // 3.0.0（规则 2）：并行上限取运行时「子智能体」设置（maxActiveSubagents / maxMembers
  // 都是 16），插件不再自己压低到 8。
  assert.equal(config.maxTeammates, 16);
  assert.equal(config.registerSkill, true);
  assert.equal(config.maxSpecialists, 20);
  assert.deepEqual(config.blockedTools, [...DEFAULT_BLOCKED_TOOLS]);
});

test('specialists 是唯一的 volatile 字段，默认是出厂预置名册', () => {
  // 只有 volatile 字段才能被「设置 → 插件」读写。名册不 volatile → 设置页只能看不能改；
  // 别的字段变成 volatile → 设置页会暴露加载期配置的编辑入口（改了也不生效）。
  assert.equal(Config.dict.specialists.meta.volatile, true);
  const config = Config();
  assert.equal(typeof config.specialists.get, 'function', '解析后的 volatile 字段必须是引用');
  const roster = config.specialists.get();
  // 开箱即有按主流开发流程划分的专家（architect/implementer/reviewer/tester/
  // security-auditor/doc-writer），且模型留空 = 继承指挥者。
  assert.deepEqual(roster.map((entry) => entry.id), defaultSpecialistIds());
  for (const entry of roster) {
    assert.equal(entry.provider, '', `${entry.id} 的 provider 应为空（继承指挥者）`);
    assert.equal(entry.model, '', `${entry.id} 的 model 应为空（继承指挥者）`);
    assert.ok(entry.description.length > 0, `${entry.id} 必须有定位描述`);
  }
  for (const key of ['maxSpecialists', 'confirmPlan', 'escalateOnConflict', 'maxTeammates', 'delegationHierarchy', 'blockedTools', 'registerSkill']) {
    assert.notEqual(Config.dict[key].meta?.volatile, true, `${key} 不该是 volatile`);
  }
});

test('默认名册每次解析都是独立副本（会话间不共享）', () => {
  // 实测：schemastery 会克隆 `.default(...)` 并**冻结**副本（写入抛 TypeError），
  // 所以既不会跨解析共享引用，也不可能污染模块常量。这两条都是"默认值安全"的证据。
  const first = Config().specialists.get();
  const second = Config().specialists.get();
  assert.notEqual(first, second, '每次解析必须是新数组');
  assert.notEqual(first[0], second[0], '元素也必须是新对象');
  assert.notEqual(first[0], DEFAULT_SPECIALISTS[0], '不能直接暴露模块常量');
  assert.throws(() => {
    first[0].description = '被改过的定位';
  }, TypeError);
  assert.equal(DEFAULT_SPECIALISTS[0].description.includes('系统架构与拆分'), true);
});

test('maxSpecialists 允许 0（禁用名册），拒绝负数与小数', () => {
  // 0 是用户关掉名册的开关；若 min 被改成 1，这个开关就没了。
  assert.equal(Config.dict.maxSpecialists.meta.default, 20);
  assert.equal(Config.dict.maxSpecialists.meta.min, 0);
  assert.equal(Config({ maxSpecialists: 0 }).maxSpecialists, 0);
  assert.throws(() => Config({ maxSpecialists: -1 }));
  assert.throws(() => Config({ maxSpecialists: 2.5 }));
});

test('maxTeammates 被限制在 1-16', () => {
  // 这个数字会原样写进协议（"建议并行 N 个"）。0 会让协议写出"最多 0 个"，
  // 100 会让模型一次扇出几十个 teammate 把配额烧光。
  // 3.0.0（规则 2）：上限从 12 抬到 16，与运行时 `subagent.maxActiveSubagents=16` /
  // `agent-team.maxMembers=16` 对齐——插件不再自己压低并行度。
  assert.equal(Config({ maxTeammates: 1 }).maxTeammates, 1);
  assert.equal(Config({ maxTeammates: 16 }).maxTeammates, 16);
  assert.throws(() => Config({ maxTeammates: 0 }));
  assert.throws(() => Config({ maxTeammates: 17 }));
});

test('readMaxTeammates 把 null 当作"未配置"，而不是 0', () => {
  // 手写 patch 里把 `maxTeammates:` 留空会得到 YAML null；`Number(null) === 0` 曾被夹成 1，
  // 协议于是静默变成"建议并行 1 个"，与 undefined/NaN 回退默认值的行为不一致。
  // 3.0.0 起默认值是 16（运行时并行上限）。
  assert.equal(readMaxTeammates(null), 16);
  assert.equal(readMaxTeammates(undefined), 16);
  assert.equal(readMaxTeammates(Number.NaN), 16);
  assert.equal(readMaxTeammates({ get: () => null }), 16, 'volatile 引用解引用后是 null 也要回退');
});

test('blockedTools 的默认值必须与 guard 的默认拦截清单一致', () => {
  // 两处各写一份清单：guard 是判定用的常量，schema 是默认配置。guard 加了一项
  // 而这里没跟，默认部署就少拦一个工具，而且不会报错。
  assert.deepEqual([...Config().blockedTools].sort(), [...DEFAULT_BLOCKED_TOOLS].sort());
});

test('默认配置数组不跨解析共享（否则一次运行会污染下一次）', () => {
  // schemastery 的 `.default([...])` 每次解析要给出新数组。若共享同一个引用，
  // 某次运行里对默认清单的 push 会泄漏到下一次 Loader 重载（甚至污染常量）。
  const first = Config();
  const second = Config();
  first.blockedTools.push('junk');
  assert.deepEqual(second.blockedTools, [...DEFAULT_BLOCKED_TOOLS]);
  assert.deepEqual([...DEFAULT_BLOCKED_TOOLS], [...DEFAULT_BLOCKED_TOOLS], 'guard 的常量不应被改动');
});

test('schema 拒绝非法名册条目', () => {
  // 设置页会先做一遍校验，但配置也可能来自手写的 profile patch。这里的 schema 是
  // 最后一道：非法 id 会拼进工具名（`tools.register()` 整个失败），缺 description
  // 等于没有定位，maxTokens 非法会让子代理起不来。
  //
  // 注意 provider/model 是**可空**的（空 = 继承指挥者模型），所以"缺 provider/model"
  // 不再被 schema 拒绝 —— 只填一半由 normalizeRoster 兜底。
  const invalid = [
    ['id 大写', { specialists: [specialist({ id: 'Architect' })] }],
    ['id 数字开头', { specialists: [specialist({ id: '1a' })] }],
    ['id 含点', { specialists: [specialist({ id: 'a.b' })] }],
    ['id 超长', { specialists: [specialist({ id: 'a'.repeat(49) })] }],
    ['缺 description', { specialists: [{ id: 'a' }] }],
    ['maxTokens 为 0', { specialists: [specialist({ maxTokens: 0 })] }],
    ['maxTokens 为小数', { specialists: [specialist({ maxTokens: 1.5 })] }],
    ['maxTokens 为字符串', { specialists: [specialist({ maxTokens: '4096' })] }],
    ['specialists 不是数组', { specialists: {} }],
  ];
  for (const [label, input] of invalid) {
    assert.throws(() => Config(input), undefined, `应拒绝：${label}`);
  }
});

test('schema 接受 provider/model 都为空的条目（继承指挥者模型）', () => {
  // 出厂预置名册就是这种形态：任何部署都可用，不需要先知道 provider/model id。
  const resolved = Config({ specialists: [{ id: 'probe', description: '探针', provider: '', model: '' }] });
  const roster = resolved.specialists.get();
  assert.equal(roster.length, 1);
  assert.equal(roster[0].provider, '');
  assert.equal(roster[0].model, '');
});

test('schema 接受合法的完整名册，且 volatile 引用返回写入的原样', () => {
  // 清洗是 `lib/specialists.js` 的事，schema 只校验形状。读到被改写过的值时，
  // 设置页显示的内容会与用户保存的不一致（例如空串被换成 undefined）。
  const roster = [
    specialist({
      persona: '你特别挑剔。',
      reasoningEffort: 'high',
      maxTokens: 8192,
    }),
  ];
  const config = Config({ specialists: roster });
  assert.deepEqual(config.specialists.get(), roster);
});

test('schema 保留未知键 —— 这正是 resolveConfig 要自己报未知键的原因', () => {
  // schemastery 对未知键是保留而不是拒绝（实测），所以拼错的键会静默存在、
  // 静默不生效。`KNOWN_CONFIG_KEYS` + `resolveConfig` 的 warning 就是补这个洞。
  // 若未来 schemastery 改成拒绝未知键，这条会失败，提醒我们更新注释与兜底逻辑。
  const config = Config({ nope: 1 });
  assert.equal(config.nope, 1);
});

test('KNOWN_CONFIG_KEYS 与 Config 声明的字段完全一致', () => {
  // 漏一个：用户合法地写了新字段，却收到"未知配置键"警告（错误信息把人带偏）。
  // 多一个：拼错的键不再被警告 —— 配置静默不生效，是最难查的一类问题。
  assert.deepEqual([...KNOWN_CONFIG_KEYS].sort(), Object.keys(Config.dict).sort());
});

// ---------------------------------------------------------------- 读取器 ---

test('readSpecialists 同时接受普通数组与 volatile 引用', () => {
  // 设置页保存后 Loader 给的是引用（有 `.get()`）；单测、手写解析、以及
  // 「还没经过 schema 的配置」给的是普通数组。只认一种形态，名册就会在一半路径上为空。
  const roster = [specialist()];
  assert.equal(readSpecialists({ specialists: roster }), roster, '普通数组应原样返回（不复制、不清洗）');
  assert.deepEqual(readSpecialists({ specialists: { get: () => roster } }), roster);
});

test('readSpecialists 对缺失与坏值返回空名册', () => {
  // 空名册是"没有 specialist 通道"的合法状态，模式其余部分照常工作。
  // 这里抛错会让整个插件不激活。
  for (const config of [undefined, null, {}, { specialists: null }, { specialists: 'architect' }, { specialists: { get: () => 'x' } }]) {
    assert.deepEqual(readSpecialists(config), []);
  }
});

test('readMaxSpecialists 只接受非负安全整数，异常回退 20', () => {
  // 字符串 '3'、-1、1.5、Infinity 若被宽松转换：名册可能被静默清空（0 条）
  // 或失去上限保护。回退到默认值是唯一安全方向。
  const cases = [
    [0, 0],
    [5, 5],
    [{ get: () => 7 }, 7],
    [undefined, 20],
    [null, 20],
    [-1, 20],
    [1.5, 20],
    ['3', 20],
    [Number.NaN, 20],
    [Number.POSITIVE_INFINITY, 20],
    [Number.MAX_SAFE_INTEGER + 1, 20],
  ];
  for (const [value, expected] of cases) {
    assert.equal(readMaxSpecialists({ maxSpecialists: value }), expected, `maxSpecialists=${String(value)}`);
  }
});

test('readFlag 只接受真正的布尔值', () => {
  // 配置由 YAML/JSON 提供，字符串 "false" 是经典的"看起来关掉了其实没关"。
  // 这里故意把它当缺省处理：宁可回到默认（true），也不要把字符串当 true/false 猜。
  assert.equal(readFlag(true, false), true);
  assert.equal(readFlag(false, true), false);
  assert.equal(readFlag('false', true), true, '字符串不能当 false —— 那会让用户以为关掉了');
  assert.equal(readFlag('true', false), false);
  assert.equal(readFlag(0, true), true);
  assert.equal(readFlag(undefined, false), false);
});

test('readBlockedTools 缺失时用默认清单且不警告', () => {
  // 缺省是正常情况，不该刷 warning。
  for (const value of [undefined, null]) {
    assert.deepEqual(readBlockedTools(value), { tools: [...DEFAULT_BLOCKED_TOOLS], warning: undefined });
  }
  assert.deepEqual(readBlockedTools(undefined, ['read']).tools, ['read'], '回退清单可覆盖');
});

test('readBlockedTools 对非数组回退默认清单并给出警告', () => {
  // 写成字符串 `blockedTools: write` 时若被当成"没有清单"，门禁会全部放行 ——
  // 那等于模式失效。回退到默认清单 + 警告是安全方向。
  for (const value of ['write', 42, {}, { get: () => 'write' }]) {
    const result = readBlockedTools(value);
    assert.deepEqual(result.tools, [...DEFAULT_BLOCKED_TOOLS]);
    assert.ok(result.warning?.includes('blockedTools'), '警告要点名是哪个字段');
  }
});

test('readBlockedTools 清洗数组：trim、去重保序、跳过非字符串与空白', () => {
  // 门禁拿的是精确工具名集合。`' write '` 若不 trim，永远匹配不到 `write`，
  // 用户会看到"明明写了拦截却没拦住"。
  const result = readBlockedTools([' write ', 'write', '', '   ', 42, null, 'bash']);
  assert.deepEqual(result, { tools: ['write', 'bash'], warning: undefined });
});

test('readBlockedTools 的空数组表示"只留协议约束"', () => {
  // 空数组是用户的明确选择，不能被 `||` 之类把它换成默认清单。
  assert.deepEqual(readBlockedTools([]), { tools: [], warning: undefined });
});

test('readMaxTeammates 夹到 1-16 并四舍五入', () => {
  // 这个值会写进 prompt 的并行建议。0 / Infinity / NaN 都会让协议给出无法执行的
  // 建议（"最多 0 个"或"不限量"）。3.0.0：默认与上限都是 16（运行时并行上限）。
  assert.equal(readMaxTeammates(undefined), 16);
  assert.equal(readMaxTeammates({ get: () => 9 }), 9, 'volatile 引用要解引用');
  assert.equal(readMaxTeammates('7'), 7, '数字字符串来自 YAML 时是合法输入');
  assert.equal(readMaxTeammates(3.5), 4);
  assert.equal(readMaxTeammates(3.4), 3);
  assert.equal(readMaxTeammates(13), 13, '13 在 1-16 内，不该再被压到 12');
  assert.equal(readMaxTeammates(16), 16);
  assert.equal(readMaxTeammates(17), 16);
  assert.equal(readMaxTeammates(0), 1);
  assert.equal(readMaxTeammates(-5), 1);
  assert.equal(readMaxTeammates(Number.NaN), 16);
  assert.equal(readMaxTeammates({}), 16);
});

// ---------------------------------------------------------------- 解析 ---

test('resolveConfig 把配置解析成协议渲染用的 options', () => {
  // index.js 直接把这些字段展开进 `renderModeOpening()`。少一个字段，
  // 协议里就会出现 `undefined 个`；多一个不该有的字段则说明职责放错了层。
  assert.deepEqual(resolveConfig({}), {
    options: {
      confirmPlan: true,
      escalateOnConflict: true,
      registerSkill: true,
      syncGuard: true,
      maxTeammates: 16,
      // 3.0.0：三层指挥链门禁（只有小组长改进度/排期、指挥官不直调子智能体）默认开启。
      delegationHierarchy: true,
      blockedTools: [...DEFAULT_BLOCKED_TOOLS],
      maxSpecialists: 20,
      ledger: true,
      stateDir: '',
      requireMandate: true,
      requireTicket: true,
      teamTaskProjection: true,
      requireTeamTask: true,
      requireTeamTaskMarker: false,
      asyncDelegation: true,
      maxAsyncTasks: 16,
      workerSessions: true,
      workRoot: '',
      maxWorkers: 6,
      prepareCommand: '',
      workerPermission: 'danger-full-access',
      ticketStallMs: 600000,
      maxTickets: 100,
      eventInbox: true,
      eventPollMs: 15000,
    },
    warnings: [],
  });
});

test('resolveConfig 对未知键给出可行动的警告', () => {
  // 拼错的键在 schemastery 里会被保留，于是"配置写了但没生效"。警告必须同时
  // 给出拼错的键与已知键清单，用户才能当场看出是 `maxTemmates` 少了个 a。
  const { warnings } = resolveConfig({ maxTemmates: 4, alsoBad: true });
  assert.equal(warnings.length, 1);
  for (const expected of ['maxTemmates', 'alsoBad', 'specialists', 'blockedTools']) {
    assert.ok(warnings[0].includes(expected), `警告里应包含 ${expected}`);
  }
});

test('resolveConfig 对非数组 blockedTools 回退默认清单并警告', () => {
  const { options, warnings } = resolveConfig({ blockedTools: 'write' });
  assert.deepEqual(options.blockedTools, [...DEFAULT_BLOCKED_TOOLS]);
  assert.ok(warnings.some((line) => line.includes('blockedTools')));
});

test('resolveConfig 对非对象 config 用默认值并警告，对 null/undefined 不警告', () => {
  // Cordis 正常传对象；非对象说明配置层坏了。null/undefined 是"没配置"的正常形态。
  for (const raw of ['x', 42, true]) {
    const { options, warnings } = resolveConfig(raw);
    assert.deepEqual(options, resolveConfig({}).options);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('必须是对象'));
  }
  assert.deepEqual(resolveConfig(null).warnings, []);
  assert.deepEqual(resolveConfig(undefined).warnings, []);
});

test('resolveConfig 解引用所有 volatile 字段', () => {
  // Loader 对 volatile 字段给引用对象。若某个字段漏了解引用，`{get: …}` 这个
  // truthy 对象会被当成配置值：布尔开关永远为 true，数字字段变成 NaN。
  const { options, warnings } = resolveConfig({
    confirmPlan: { get: () => false },
    escalateOnConflict: { get: () => false },
    registerSkill: { get: () => false },
    syncGuard: { get: () => false },
    maxTeammates: { get: () => 9 },
    delegationHierarchy: { get: () => false },
    blockedTools: { get: () => ['read'] },
    maxSpecialists: { get: () => 3 },
  });
  assert.deepEqual(options, {
    confirmPlan: false,
    escalateOnConflict: false,
    registerSkill: false,
    syncGuard: false,
    maxTeammates: 9,
    delegationHierarchy: false,
    blockedTools: ['read'],
    maxSpecialists: 3,
    ledger: true,
    stateDir: '',
    // 3.4.0：confirmPlan=false（解引用后）会自动把 requireMandate 视为 false ——
    // 关掉计划确认后无法记录计划授权，再要求授权会让所有派发被永久拒绝。
    requireMandate: false,
    requireTicket: true,
    teamTaskProjection: true,
    requireTeamTask: true,
    requireTeamTaskMarker: false,
    asyncDelegation: true,
    maxAsyncTasks: 16,
    workerSessions: true,
    workRoot: '',
    maxWorkers: 6,
    prepareCommand: '',
    workerPermission: 'danger-full-access',
    ticketStallMs: 600000,
    maxTickets: 100,
    eventInbox: true,
    eventPollMs: 15000,
  });
  // 解引用本身仍然正确（没有"漏解引用"的告警），但会多一条 confirmPlan/requireMandate 冲突告警。
  assert.equal(warnings.length, 1, `只应有冲突告警：${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /confirmPlan: false 与 requireMandate: true 冲突/u);
  assert.match(warnings[0], /已自动把 requireMandate 视为 false/u);
});

// --------------------------------- 3.4.0 confirmPlan / requireMandate 冲突 ---
//
// 交叉审计发现的第 4 处死锁：`confirmPlan: false` 让协议不再要求 `ask_user_question`，
// 而 Mandate 只能从它的 post-execute 结果记录 → 永远没有授权，所有派发被永久拒绝。
// 两者是同一个决策的两面：关掉确认时自动关掉授权要求，并给一条告警说明原因。

test('3.4.0：confirmPlan:false 自动把 requireMandate 视为 false（并告警）', () => {
  const { options, warnings } = resolveConfig({ confirmPlan: false });
  assert.equal(options.confirmPlan, false);
  assert.equal(options.requireMandate, false, '关掉计划确认后不能再要求计划授权');
  const conflict = warnings.filter((line) => line.includes('requireMandate'));
  assert.equal(conflict.length, 1, `应有一条冲突告警：${JSON.stringify(warnings)}`);
  assert.match(conflict[0], /confirmPlan: false 与 requireMandate: true 冲突/u);
  assert.match(conflict[0], /会让所有派发被永久拒绝/u);
});

test('3.4.0：显式 requireMandate:false + confirmPlan:false → 无告警（不是冲突）', () => {
  const { options, warnings } = resolveConfig({ confirmPlan: false, requireMandate: false });
  assert.equal(options.confirmPlan, false);
  assert.equal(options.requireMandate, false);
  assert.deepEqual(warnings, [], '用户显式关掉两者不是冲突，不应告警');
});

test('3.4.0：confirmPlan:true + requireMandate:true（默认）→ 都开启且无告警', () => {
  const explicit = resolveConfig({ confirmPlan: true, requireMandate: true });
  assert.equal(explicit.options.confirmPlan, true);
  assert.equal(explicit.options.requireMandate, true);
  assert.deepEqual(explicit.warnings, []);
  // 默认（不传）同样如此。
  const defaults = resolveConfig({});
  assert.equal(defaults.options.confirmPlan, true);
  assert.equal(defaults.options.requireMandate, true);
  assert.deepEqual(defaults.warnings, []);
  // 只关 requireMandate（保留 confirmPlan）→ 合法，无告警。
  const mandateOnly = resolveConfig({ requireMandate: false });
  assert.equal(mandateOnly.options.confirmPlan, true);
  assert.equal(mandateOnly.options.requireMandate, false);
  assert.deepEqual(mandateOnly.warnings, []);
});

// ------------------- 3.4.0 teamTaskProjection / requireTeamTask 冲突 ---
//
// 交叉审计发现的同类死锁：关掉投影后工单不会出现在任务板上，而 D-1 要求
// `spawn_teammate` 前工单已有投影 → Team 通道永远派不出去（与 def6609d 同一形状）。
// 既然不投影，就不能再要求"已有投影"。

test('3.4.0：teamTaskProjection:false 自动把 requireTeamTask 视为 false（并告警）', () => {
  const { options, warnings } = resolveConfig({ teamTaskProjection: false });
  assert.equal(options.teamTaskProjection, false);
  assert.equal(options.requireTeamTask, false, '不投影就不可能"已有投影"，不能再要求它');
  const conflict = warnings.filter((line) => line.includes('requireTeamTask'));
  assert.equal(conflict.length, 1, `应有一条冲突告警：${JSON.stringify(warnings)}`);
  assert.match(conflict[0], /teamTaskProjection: false 与 requireTeamTask: true 冲突/u);
  assert.match(conflict[0], /会让 Team 通道永远派不出去/u);
  assert.match(conflict[0], /已自动把 requireTeamTask 视为 false/u);
});

test('3.4.0：显式 requireTeamTask:false + teamTaskProjection:false → 无告警（不是冲突）', () => {
  const { options, warnings } = resolveConfig({ teamTaskProjection: false, requireTeamTask: false });
  assert.equal(options.teamTaskProjection, false);
  assert.equal(options.requireTeamTask, false);
  assert.deepEqual(warnings, [], '用户显式关掉两者不是冲突，不应告警');
});

test('3.4.0：默认（不传）→ teamTaskProjection 与 requireTeamTask 都开启且无告警', () => {
  const { options, warnings } = resolveConfig({});
  assert.equal(options.teamTaskProjection, true);
  assert.equal(options.requireTeamTask, true);
  assert.deepEqual(warnings, []);
  // 只关 requireTeamTask（保留投影）→ 合法，无告警。
  const noRequire = resolveConfig({ requireTeamTask: false });
  assert.equal(noRequire.options.teamTaskProjection, true);
  assert.equal(noRequire.options.requireTeamTask, false);
  assert.deepEqual(noRequire.warnings, []);
  // 两个独立冲突同时触发时，各有一条告警（不是互相吞掉）。
  const both = resolveConfig({ confirmPlan: false, teamTaskProjection: false });
  assert.equal(both.warnings.filter((line) => line.includes('requireMandate')).length, 1);
  assert.equal(both.warnings.filter((line) => line.includes('requireTeamTask')).length, 1);
  assert.equal(both.options.requireMandate, false);
  assert.equal(both.options.requireTeamTask, false);
});

test('resolveConfig 不快照名册 —— 名册只能由 specialists.js 实时清洗', () => {
  // 名册随设置页实时变化：`resolveRoster()` 每次调用都重新读 volatile 引用。
  // 若在这里把它固定进 options，设置页保存后新会话仍然拿旧名册，
  // 而且清洗规则会出现两份（一份在 apply 时，一份在热更新时）。
  const { options } = resolveConfig({ specialists: [specialist()] });
  assert.equal('specialists' in options, false);
});

// ---------------------------------------------------------------- 0.6.0 工单 ---

test('0.6.0 默认：账本与计划授权/工单门禁默认开启', () => {
  const config = Config();
  assert.equal(config.ledger, true);
  assert.equal(config.requireMandate, true);
  assert.equal(config.requireTicket, true);
  assert.equal(config.asyncDelegation, true);
  // 3.0.0：8 → 16（规则 2，与运行时并行上限对齐）。
  assert.equal(config.maxAsyncTasks, 16);
  assert.equal(config.stateDir, '');
  assert.equal(config.ticketStallMs, 10 * 60 * 1000);
  assert.equal(config.maxTickets, 100);
});

test('0.6.0 读取器：ledger 可关、stateDir 去空白、阈值有下限', () => {
  const { options } = resolveConfig({
    ledger: false,
    requireMandate: false,
    requireTicket: false,
    stateDir: '  my-ledger.json  ',
    ticketStallMs: 1,
    maxTickets: 0,
  });
  assert.equal(options.ledger, false);
  assert.equal(options.requireMandate, false);
  assert.equal(options.requireTicket, false);
  assert.equal(options.stateDir, 'my-ledger.json');
  assert.equal(options.ticketStallMs, 600_000, '低于 1 分钟回退默认（10 分钟）');
  assert.equal(options.maxTickets, 100, '非正数回退默认');
});

test('0.6.0 读取器：readString/readPositiveNumber 宽容处理引用与异常值', () => {
  assert.equal(readString({ get: () => ' x ' }), 'x');
  assert.equal(readString(42, 'fallback'), 'fallback');
  assert.equal(readPositiveNumber({ get: () => '300000' }, 1, 60_000), 300_000);
  assert.equal(readPositiveNumber(undefined, 9, 1), 9);
  assert.equal(readPositiveNumber(-5, 9, 1), 9);
  assert.equal(readPositiveNumber(3.6, 9, 1), 4);
});

test('0.6.0 已知键包含新配置，未知键警告仍列出完整清单', () => {
  for (const key of ['ledger', 'stateDir', 'requireMandate', 'requireTicket', 'ticketStallMs', 'maxTickets']) {
    assert.ok(KNOWN_CONFIG_KEYS.includes(key), `KNOWN_CONFIG_KEYS 缺少 ${key}`);
  }
  const { warnings } = resolveConfig({ maxTemmates: 4 });
  assert.match(warnings[0], /requireMandate/u);
});

test('0.7.0 异步配置：默认开、可关、上限夹到 1–16', () => {
  const config = Config();
  assert.equal(config.asyncDelegation, true);
  // 3.0.0：8 → 16（规则 2）。
  assert.equal(config.maxAsyncTasks, 16);
  const disabled = resolveConfig({ asyncDelegation: false }).options;
  assert.equal(disabled.asyncDelegation, false);
  assert.equal(resolveConfig({ maxAsyncTasks: 0 }).options.maxAsyncTasks, 16, '非正数回退默认');
  assert.equal(resolveConfig({ maxAsyncTasks: 99 }).options.maxAsyncTasks, 99, '读取器不夹上限，schema 负责 1–16');
  assert.ok(KNOWN_CONFIG_KEYS.includes('asyncDelegation'));
  assert.ok(KNOWN_CONFIG_KEYS.includes('maxAsyncTasks'));
});

// ------------------------------------------------ 3.0.0 三层指挥链配置 ---

test('3.0.0：maxTeammates / maxAsyncTasks 的 schema 上限都是 16（规则 2）', () => {
  // 用户 2026-11-11 规则 2：并行上限取运行时「子智能体」设置
  // （`subagent.maxActiveSubagents=16`、`agent-team.maxMembers=16`），插件不再自己压低。
  // schema 的上限与默认值必须一起改：只改默认值会让用户写 16 被 schema 拒；
  // 只改上限不改默认值则等于没放开。
  for (const key of ['maxTeammates', 'maxAsyncTasks']) {
    assert.equal(Config.dict[key].meta.default, 16, `${key} 默认值应为 16`);
    assert.equal(Config.dict[key].meta.max, 16, `${key} 上限应为 16`);
  }
});

test('3.0.0：delegationHierarchy 默认 true，可显式关掉（回退 2.x 行为）', () => {
  // 三条层级门禁（任务板写入 / 工单推进状态 / 子智能体派发）默认开启；关掉后只留协议约束。
  // 默认值必须是 true：这是 3.0.0 的破坏性变更本身，默认关掉等于规则 4 没落地。
  assert.equal(Config().delegationHierarchy, true);
  assert.equal(Config.dict.delegationHierarchy.meta.default, true);
  assert.equal(Config({ delegationHierarchy: false }).delegationHierarchy, false);
  assert.equal(resolveConfig({}).options.delegationHierarchy, true);
  assert.equal(resolveConfig({ delegationHierarchy: false }).options.delegationHierarchy, false);
  // 非布尔值按默认处理（YAML 字符串 "false" 不能当关掉——那会让用户以为关掉了）。
  assert.equal(resolveConfig({ delegationHierarchy: 'false' }).options.delegationHierarchy, true);
  assert.ok(KNOWN_CONFIG_KEYS.includes('delegationHierarchy'), 'KNOWN_CONFIG_KEYS 缺少 delegationHierarchy');
});

test('1.0.0 Worker 配置：默认开启、可显式关、目录/上限/权限读取', () => {
  const config = Config();
  assert.equal(config.workerSessions, true, '1.0.0 起默认开启（真实 E2E 已验）');
  assert.equal(config.workRoot, '');
  assert.equal(config.maxWorkers, 6);
  assert.equal(config.prepareCommand, '');
  assert.equal(config.workerPermission, 'danger-full-access');
  const options = resolveConfig({
    workerSessions: true,
    workRoot: '  my-work  ',
    maxWorkers: 0,
    prepareCommand: ' git init ',
    workerPermission: 'workspace-write',
  }).options;
  assert.equal(options.workerSessions, true);
  assert.equal(options.workRoot, 'my-work');
  assert.equal(options.maxWorkers, 6, '非正数回退默认');
  assert.equal(options.prepareCommand, 'git init');
  assert.equal(options.workerPermission, 'workspace-write');
  for (const key of ['workerSessions', 'workRoot', 'maxWorkers', 'prepareCommand', 'workerPermission']) {
    assert.ok(KNOWN_CONFIG_KEYS.includes(key), `KNOWN_CONFIG_KEYS 缺少 ${key}`);
  }
});

test('1.1.0 外部事件配置：默认开启、15 秒轮询、可关、低于下限回退默认', () => {
  const config = Config();
  assert.equal(config.eventInbox, true);
  assert.equal(config.eventPollMs, 15000);
  const options = resolveConfig({ eventInbox: false, eventPollMs: 2000 }).options;
  assert.equal(options.eventInbox, false);
  assert.equal(options.eventPollMs, 2000);
  assert.equal(resolveConfig({ eventPollMs: 0 }).options.eventPollMs, 15000, '非正数回退默认');
  assert.equal(resolveConfig({ eventPollMs: 1 }).options.eventPollMs, 15000, '低于 1s 回退默认（读取器不夹值）');
  for (const key of ['eventInbox', 'eventPollMs']) {
    assert.ok(KNOWN_CONFIG_KEYS.includes(key), `KNOWN_CONFIG_KEYS 缺少 ${key}`);
  }
});

test('3.1.0 禁止等待：配置里不存在 maxWaitMs（不设开关）', () => {
  // 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**。
  // 2.0.0 的 `maxWaitMs`（默认 120000、0 = 关闭）随之下线：只要还能配，部署里就会出现
  // "这次先关掉"。所以 schema、KNOWN_CONFIG_KEYS、resolveConfig 三处都不能再有这个键 ——
  // 任何一处残留都会让用户以为"还能调"。
  const config = Config();
  assert.equal('maxWaitMs' in config, false, 'schema 不应再声明 maxWaitMs');
  assert.equal(Config.dict.maxWaitMs, undefined, 'schema 字段已删除');
  assert.equal(KNOWN_CONFIG_KEYS.includes('maxWaitMs'), false, 'KNOWN_CONFIG_KEYS 不应再含 maxWaitMs');
  assert.equal('maxWaitMs' in resolveConfig({}).options, false, 'resolveConfig 不应再输出 maxWaitMs');
  assert.equal('maxWaitMs' in resolveConfig(undefined).options, false);
  // 即使用户在旧配置里写了这个键，也只会得到"未知配置键"警告，而不会改变任何行为。
  const { options, warnings } = resolveConfig({ maxWaitMs: 0 });
  assert.equal('maxWaitMs' in options, false);
  assert.ok(warnings.some((line) => line.includes('maxWaitMs')), '旧配置键应被报成未知键');
});

test('3.1.0：resolveConfig 恰好输出 26 个键，且等待读取器/常量已删除', () => {
  // 26 = 3.0.0 的 27 个加载期键去掉 maxWaitMs（specialists 本来就不进 options）。
  // 这个数字是"键集合没被悄悄改"的廉价护栏；键名逐项由上面的 deepEqual 钉住。
  const { options } = resolveConfig({});
  assert.equal(Object.keys(options).length, 26);
  // 等待门禁的旧读取器与常量必须彻底删除，而不是留着当"隐藏开关"。
  assert.equal('readWaitCap' in configModule, false, 'readWaitCap 应已删除');
  assert.equal('MIN_MAX_WAIT_MS' in configModule, false, 'MIN_MAX_WAIT_MS 应已删除');
  assert.equal('MAX_MAX_WAIT_MS' in configModule, false, 'MAX_MAX_WAIT_MS 应已删除');
});
