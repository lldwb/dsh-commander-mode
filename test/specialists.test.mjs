/**
 * specialist 名册的纯逻辑测试（`lib/specialists.js`）。
 *
 * 这个模块把「用户配置里的一行名册」变成两样东西：一个独立的 agent preset，与一个前台
 * 工具 `subagent_<id>`。这条链上每一处转换出错，故障都不是"少个功能"，而是整条通道
 * 静默失效，甚至把整个模式弄坏：
 *
 * - 名册清洗漏掉必填项 → preset 注册成功，但工具执行时 provider/model 为空，派出去的活直接失败；
 * - preset 指纹不稳定或不随配置变 → `agentPresets.register()` 撞 id，重建时丢 specialist；
 * - specialist preset 误挂指挥者协议 → 子代理以为自己是指挥者，拒绝自己动手（本模式最糟的故障）；
 * - 工具 schema 把 `required` 写进属性里 → DSH 运行时以 `JsonSchemaError` 拒绝注册（实测）；
 * - `execute` 的 activation 契约错一个字段（`delivery` / `maxDepth` / `agentPreset`）→
 *   子代理跑在错误 preset 上，或者结果不回到调用方。
 *
 * 所以下面每条断言都对着一个具体的、用户会看到后果的故障写。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CAPABILITY_ROWS } from '../lib/capabilities.js';
import {
  MAX_RESULT_CHARS,
  SPECIALIST_ROW_NAME,
  buildSpecialistToolDefinition,
  installSpecialist,
  normalizeRoster,
  outputText,
  renderSettlement,
  renderSpecialistPersona,
  resolveRoster,
  rosterToolNames,
  specialistFingerprint,
  specialistPresetDefinition,
  specialistPresetId,
  specialistToolName,
} from '../lib/specialists.js';

// ---------------------------------------------------------------- 夹具 ---

/** 一份各项合法的名册条目；测试按需覆盖字段。 */
function specialist(overrides = {}) {
  return {
    id: 'architect',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    description: '负责系统架构与拆分',
    ...overrides,
  };
}

/** 记录被丢弃条目的日志器（`normalizeRoster` 会把原因写进 `warn`）。 */
function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args.map(String).join(' ')) };
}

/**
 * `subagents` 服务的替身。
 *
 * 只记录 `startActivation()` 收到的完整参数 —— 这些参数就是子代理的启动契约，
 * 断言它们比断言"调用发生了"有意义得多。
 */
function fakeSubagents(options = {}) {
  const settlement = options.settlement ?? { output: [{ type: 'text', text: '子代理答复' }], stopReason: 'completed' };
  // 用 hasOwn 区分"没传"（默认透传 depth）与"显式传 undefined"（服务读不到上限）。
  const hasResolvedMaxDepth = Object.hasOwn(options, 'resolvedMaxDepth');
  const calls = { activations: [], resolveMaxDepth: [] };
  const service = {
    resolveMaxDepth(depth) {
      calls.resolveMaxDepth.push(depth);
      return hasResolvedMaxDepth ? options.resolvedMaxDepth : depth;
    },
    async startActivation(request) {
      calls.activations.push(request);
      return { childId: 'child-1', result: Promise.resolve(settlement), dispose: async () => {} };
    },
  };
  return { calls, service };
}

/** 一个假的插件上下文：只实现 `installSpecialist` 用到的两个注册通道。 */
function fakeInstallCtx({ failToolRegister = false } = {}) {
  const record = { presets: [], tools: [], events: [] };
  const ctx = {
    agentPresets: {
      async register(definition) {
        record.presets.push(definition);
        record.events.push(`preset:register:${definition.id}`);
        return async () => {
          record.presets = record.presets.filter((entry) => entry !== definition);
          record.events.push(`preset:unregister:${definition.id}`);
        };
      },
    },
    tools: {
      register(definition) {
        if (failToolRegister) {
          record.events.push('tool:register-failed');
          throw new Error('tools.register 失败');
        }
        record.tools.push(definition);
        record.events.push(`tool:register:${definition.name}`);
        return () => {
          record.tools = record.tools.filter((entry) => entry !== definition);
          record.events.push(`tool:dispose:${definition.name}`);
        };
      },
    },
  };
  return { ctx, record };
}

// ---------------------------------------------------------------- 标识 ---

test('工具名带 subagent_ 前缀 —— 门禁靠它识别「有派发通道」', () => {
  // `lib/guard.js` 的 `delegate` 判定与 index.js 的 `canDelegate` 都以
  // `startsWith('subagent_')` 识别派发通道。前缀一旦改了，指挥者的工具视图里就
  // "没有任何派发工具" → 门禁自动放行 → 指挥者开始自己写文件，整个模式形同虚设。
  assert.equal(specialistToolName('architect'), 'subagent_architect');
  assert.equal(specialistToolName('a-b_c'), 'subagent_a-b_c');
});

test('指纹是 8 位十六进制，且同一输入永远得到同一指纹', () => {
  // 指纹是 preset id 的一部分。不稳定（例如混入时间/随机数）时，每次重建都会生成
  // 新 preset id，旧 preset 的释放与新建交错——注册表里越积越多，直到撞上上限。
  const entry = specialist();
  const fingerprint = specialistFingerprint(entry);
  assert.match(fingerprint, /^[0-9a-f]{8}$/u);
  assert.equal(fingerprint, specialistFingerprint({ ...entry }), '同内容必须是同指纹');
});

test('指纹随每个影响子代理行为的字段变化', () => {
  // 两个行为不同的 specialist 如果共用 preset id，`agentPresets.register()` 会在
  // 旧 revision 尚未释放时撞 id，安装失败 → 协议里少一个工具，用户看到"配置了却没生效"。
  const base = specialist();
  const fingerprint = specialistFingerprint(base);
  const changes = {
    id: 'reviewer',
    provider: 'sub2api',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    maxTokens: 8192,
    description: '只负责审查，不做实现',
    persona: '你特别挑剔。',
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(
      specialistFingerprint({ ...base, [field]: value }),
      fingerprint,
      `${field} 变化时指纹必须变化，否则不同配置会撞同一个 preset id`,
    );
  }
});

test('指纹把「字段缺失」与「显式空串」归一', () => {
  // 解析路径不同（手写配置 vs schema 默认值）会分别给出 undefined 与 ''。
  // 若不归一，同一份配置在两条路径上算出两个 preset id，热更新时多注册一个孤儿 preset。
  const base = specialist();
  assert.equal(
    specialistFingerprint(base),
    specialistFingerprint({ ...base, reasoningEffort: '', maxTokens: undefined, persona: '' }),
  );
  // 但真实的非空值必须区分开。
  assert.notEqual(specialistFingerprint(base), specialistFingerprint({ ...base, persona: ' ' }));
});

test('preset id 带 specialist id 与指纹，不同模型得到不同 id', () => {
  // 可读 id 是排障入口：日志里看到 `commander-specialist-reviewer-03ab…` 能直接定位。
  const base = specialist();
  const id = specialistPresetId(base);
  assert.match(id, /^commander-specialist-architect-[0-9a-f]{8}$/u);
  assert.equal(id, `commander-specialist-architect-${specialistFingerprint(base)}`);
  assert.notEqual(specialistPresetId({ ...base, model: 'other-model' }), id);
});

// ---------------------------------------------------------------- 名册清洗 ---

test('非数组输入返回空名册（配置可能来自 profile patch 手写）', () => {
  // schema 会拦掉大多数坏配置，但 Host 半必须自己兜底：`specialists` 写成字符串、
  // 对象、null 都可能出现在手写 patch 里。这里抛错会让整个插件不激活。
  for (const entries of [undefined, null, 'architect', 42, {}, { length: 1 }]) {
    assert.deepEqual(normalizeRoster(entries), [], `应返回空名册：${String(entries)}`);
  }
});

test('名册条目被清洗：必填字段 trim，可选字段不残留空白', () => {
  // 设置页输入框很容易带前后空格；不 trim 时 provider/model 会带着空格去路由，
  // 子代理启动失败，而错误信息里看不出来。
  const roster = normalizeRoster([
    {
      id: '  architect  ',
      provider: ' deepseek ',
      model: '\tdeepseek-reasoner\t',
      description: ' 负责架构 ',
      persona: ' 你特别挑剔。 ',
      reasoningEffort: ' high ',
      maxTokens: 4096,
    },
  ]);
  assert.deepEqual(roster, [
    {
      id: 'architect',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      description: '负责架构',
      persona: '你特别挑剔。',
      reasoningEffort: 'high',
      maxTokens: 4096,
    },
  ]);
});

test('重复 id 只保留第一个，并记一条 warn', () => {
  // 重复 id 会生成两个同名工具与两个指向同一工具名的 preset。`tools.register()`
  // 对重名工具的行为不是"后者覆盖"——第二个必然注册失败或互相覆盖，用户看到的是
  // "名册里明明有 reviewer，却调不动"。
  const logger = recordingLogger();
  const roster = normalizeRoster(
    [
      { id: 'architect', provider: 'first', model: 'm', description: '第一次出现' },
      { id: 'architect', provider: 'second', model: 'm', description: '重复项' },
    ],
    { logger },
  );
  assert.equal(roster.length, 1);
  assert.equal(roster[0].provider, 'first');
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes('重复'), '被丢弃的原因要能出现在日志里');
});

test('缺 provider / model / description 任一项的条目被丢弃', () => {
  // 三项里缺任何一项，工具执行时都会生成一个残缺的 activation：缺 provider/model
  // 时子代理无法启动；缺 description 时人设里出现 "undefined"，模型会照着念。
  const logger = recordingLogger();
  const roster = normalizeRoster(
    [
      { id: 'no-provider', model: 'm', description: 'd' },
      { id: 'no-model', provider: 'p', description: 'd' },
      { id: 'no-description', provider: 'p', model: 'm' },
      { id: 'blank', provider: '   ', model: 'm', description: 'd' },
      { id: 'ok', provider: 'p', model: 'm', description: 'd' },
    ],
    { logger },
  );
  assert.deepEqual(roster.map((entry) => entry.id), ['ok']);
  assert.equal(logger.warnings.length, 4, '每一条被丢弃的条目都要留下日志');
  for (const warning of logger.warnings) assert.ok(warning.includes('provider/model/description'));
});

test('被丢弃的条目不会占用 id —— 后面同 id 的合法条目仍能进来', () => {
  // 真实路径：用户先在设置页留了一条缺 provider 的旧配置，又在下面补了一条修好的
  // 同名条目。若去重发生在校验之前，修好的那条会被当成"重复"丢掉，用户改了半天不生效。
  const roster = normalizeRoster([
    { id: 'dup', provider: 'p' }, // 缺 model/description，丢弃
    { id: 'dup', provider: 'p', model: 'm', description: 'd' }, // 合法，保留
  ]);
  assert.deepEqual(roster.map((entry) => entry.id), ['dup']);
  assert.equal(roster[0].model, 'm');
});

test('id 必须是 1-48 位小写标识符，非法 id 一律丢弃', () => {
  // id 直接拼进工具名。DSH 对工具名有语法约束，非法 id 会让 `tools.register()`
  // 整个失败——不是一个 specialist 坏掉，是本轮所有 specialist 都装不上。
  const valid = ['a', 'architect', 'glm-5', 'a_b', 'a1', 'a'.repeat(48)];
  for (const id of valid) {
    assert.equal(normalizeRoster([{ id, provider: 'p', model: 'm', description: 'd' }]).length, 1, `应接受合法 id：${id}`);
  }
  const invalid = ['A', '1abc', '-a', 'a.b', 'a b', '', '   ', '中文', 'a'.repeat(49), 'a/b'];
  const logger = recordingLogger();
  for (const id of invalid) {
    assert.equal(
      normalizeRoster([{ id, provider: 'p', model: 'm', description: 'd' }], { logger }).length,
      0,
      `应拒绝非法 id：${JSON.stringify(id)}`,
    );
  }
  assert.equal(logger.warnings.length, invalid.length);
});

test('非对象条目被跳过，而不是让整次清洗抛错', () => {
  // 名册来自不可信的配置。一条 `null` 或字符串就让 apply() 抛错，整个插件不激活。
  const logger = recordingLogger();
  const roster = normalizeRoster([null, 42, 'architect', [], { id: 'ok', provider: 'p', model: 'm', description: 'd' }], { logger });
  assert.deepEqual(roster.map((entry) => entry.id), ['ok']);
});

test('空白可选字段不写进条目', () => {
  // 写了空串之后，指纹、人设渲染、agentOptions 都得各自处理一次空值；
  // 统一成"不写这个键"是最省事的归一。
  const roster = normalizeRoster([
    { id: 'architect', provider: 'p', model: 'm', description: 'd', persona: '   ', reasoningEffort: '\t' },
  ]);
  assert.deepEqual(roster, [{ id: 'architect', provider: 'p', model: 'm', description: 'd' }]);
});

test('maxTokens 只接受 >=1 的安全整数', () => {
  // 0 / 负数 / 小数 / Infinity 进了 `agentOptions.maxTokens` 会让子代理启动失败，
  // 而失败发生在派活那一刻，用户很难把它和配置联系起来。
  const accepted = [1, 4096, Number.MAX_SAFE_INTEGER];
  for (const maxTokens of accepted) {
    assert.equal(normalizeRoster([{ id: 'a', provider: 'p', model: 'm', description: 'd', maxTokens }])[0].maxTokens, maxTokens);
  }
  const rejected = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4096', Number.MAX_SAFE_INTEGER + 1];
  for (const maxTokens of rejected) {
    assert.equal(
      normalizeRoster([{ id: 'a', provider: 'p', model: 'm', description: 'd', maxTokens }])[0].maxTokens,
      undefined,
      `应丢弃非法 maxTokens：${String(maxTokens)}`,
    );
  }
});

test('超过 maxSpecialists 的条目被截断，且只警告一次', () => {
  // 每个 specialist 都是一个 preset + 一个工具。上限是防御性措施，不是装饰：
  // 名册写错成几百条时，注册表会被撑爆、启动时间失控。
  const many = Array.from({ length: 5 }, (_, index) => ({
    id: `s${index}`,
    provider: 'p',
    model: 'm',
    description: 'd',
  }));
  const logger = recordingLogger();
  const roster = normalizeRoster(many, { maxSpecialists: 2, logger });
  assert.deepEqual(roster.map((entry) => entry.id), ['s0', 's1']);
  assert.equal(logger.warnings.length, 1, '截断只该警告一次，否则每次重建都刷日志');
});

test('名册条数恰好等于上限时不警告', () => {
  // 上限是"最多 N 个"，不是"少于 N 个"。边界判断写成 `>=` 而不是 `>` 的后果是
  // 每一次合法重建都刷一条误导性的警告。
  const entries = Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`, provider: 'p', model: 'm', description: 'd' }));
  const logger = recordingLogger();
  assert.equal(normalizeRoster(entries, { maxSpecialists: 3, logger }).length, 3);
  assert.deepEqual(logger.warnings, []);
});

test('maxSpecialists 为 0 表示禁用名册', () => {
  // 用户想用「智能体团队」那条通道时，0 是唯一能关掉名册的方式。
  assert.deepEqual(normalizeRoster([{ id: 'a', provider: 'p', model: 'm', description: 'd' }], { maxSpecialists: 0 }), []);
});

test('非法 maxSpecialists 回退到 20，而不是把名册清空', () => {
  // 手写 patch 里可能是 -1 或 1.5。若被当成 0，用户的名册会静默消失；
  // 若被当成 Infinity，上限保护失效。回退到默认值是唯一安全的方向。
  const entries = Array.from({ length: 21 }, (_, index) => ({ id: `s${index}`, provider: 'p', model: 'm', description: 'd' }));
  for (const maxSpecialists of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeRoster(entries, { maxSpecialists }).length, 20, `非法上限 ${String(maxSpecialists)} 应回退 20`);
  }
});

test('不传 logger 时清洗照常工作', () => {
  // logger 是可选参数；缺了它只是少日志，不该影响名册结果。
  assert.doesNotThrow(() => normalizeRoster([{ id: 'a' }], {}));
});

// ---------------------------------------------------------------- 名册解析 ---

test('resolveRoster 同时支持普通值与 volatile 引用', () => {
  // 设置页保存后，Loader 交给插件的是引用（有 `.get()`）；单测与手写解析路径给的是
  // 普通数组。只支持一种形态的后果是名册在一半路径上静默为空。
  const entries = [{ id: 'architect', provider: 'p', model: 'm', description: 'd' }];
  assert.deepEqual(resolveRoster({ specialists: entries }), entries);
  assert.deepEqual(resolveRoster({ specialists: { get: () => entries } }), entries);
});

test('resolveRoster 的条数上限以配置为准', () => {
  // index.js 调的是 `resolveRoster(config, { logger })`，不传上限。若上限取自
  // options 而不是 config，设置页改 `maxSpecialists` 就永远不生效。
  const entries = Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`, provider: 'p', model: 'm', description: 'd' }));
  assert.equal(resolveRoster({ specialists: entries, maxSpecialists: 2 }, { maxSpecialists: 99 }).length, 2);
});

test('resolveRoster 对空/坏配置返回空名册', () => {
  for (const config of [undefined, null, {}, { specialists: 'x' }, { specialists: null }]) {
    assert.deepEqual(resolveRoster(config), []);
  }
});

test('rosterToolNames 与工具名规则一致', () => {
  // 协议文本点名工具用的就是这份映射。这里与 `specialistToolName` 漂移的后果是
  // 协议让模型去调一个不存在的工具名，模型连试几次把轮次烧光。
  const roster = [specialist({ id: 'architect' }), specialist({ id: 'reviewer' })];
  assert.deepEqual(rosterToolNames(roster), ['subagent_architect', 'subagent_reviewer']);
});

// ---------------------------------------------------------------- 人设 ---

test('人设文本点名 specialist 的 id 与职责', () => {
  // 子代理看不到派活之前的对话，这行是它唯一能确认"我是谁、我该做什么"的地方。
  const text = renderSpecialistPersona(specialist());
  assert.ok(text.includes('architect'));
  assert.ok(text.includes('负责系统架构与拆分'));
});

test('人设包含职责、边界、可靠性三节', () => {
  // 这三节分别守三件真实事故：把无关任务顺手做了、把活再派给别人（深度预算耗尽）、
  // 检查失败还声称完成。删掉任何一节，子代理就会回到默认行为。
  const text = renderSpecialistPersona(specialist());
  for (const heading of ['## 你的职责', '## 边界', '## 可靠性']) {
    assert.ok(text.includes(heading), `人设缺少 ${heading}`);
  }
  assert.ok(text.includes('不要扮演指挥者'), '边界里必须明确禁止再委派');
});

test('人设要求 specialist 在任务与定位不符时先报告，不要硬做', () => {
  // 指挥者应当按定位派活；但派活是模型行为（概率性的），所以执行者侧也要有兜底：
  // 收到明显超出定位的任务时报告，而不是硬做出低质量结果。
  const text = renderSpecialistPersona(specialist());
  assert.ok(text.includes('任务与你的定位差距大时先报告'));
  assert.ok(text.includes('不要硬做'));
  assert.ok(text.includes('任务与我的定位不符'));
  assert.ok(text.includes('改派给匹配的执行者或新开一个子智能体'));
  // 也禁止两种坏处理方式：自行扩大范围、沉默地按自己的理解做。
  assert.ok(text.includes('不要') && text.includes('自行扩大范围'));
  assert.ok(text.includes('不要沉默地按自己的理解做'));
});

test('配置了 persona 时作为附加人设追加在最后', () => {
  // 附加人设是用户在设置页写的定制部分，必须在最后（它可能包含对前面纪律的补充）。
  const text = renderSpecialistPersona(specialist({ persona: '  你特别挑剔。  ' }));
  assert.ok(text.includes('## 附加人设'));
  assert.ok(text.includes('你特别挑剔。'));
  assert.ok(text.trimEnd().endsWith('你特别挑剔。'), '附加人设应在人设文本的最后');
});

test('空白 persona 不产生空的附加人设段', () => {
  // 空的 `## 附加人设` 标题会浪费 system prompt，还让模型以为后面漏了内容。
  for (const persona of [undefined, '', '   ', '\t\n']) {
    assert.ok(!renderSpecialistPersona(specialist({ persona })).includes('附加人设'), `空白 persona 不应产生附加段：${JSON.stringify(persona)}`);
  }
});

// ---------------------------------------------------------------- preset 定义 ---

test('preset 定义用指纹 id、可读名字与 specialist 描述', () => {
  const definition = specialistPresetDefinition(specialist());
  assert.equal(definition.id, specialistPresetId(specialist()));
  assert.equal(definition.name, '指挥官 specialist: architect');
  assert.equal(definition.description, '负责系统架构与拆分');
});

test('preset 的 plugins 是完整组合：能力行 + 末尾的人设行', () => {
  // DSH 的 preset 是**完整组合**，不是全局工具集上的叠加层：`dsh-web-app` 把随附
  // 能力行全局禁用了，specialist preset 漏掉哪一行，那个子代理就没有那项能力。
  // 漏 `tool-fs` = 没有文件系统，漏 `tool-shell` = 跑不了测试。
  const definition = specialistPresetDefinition(specialist());
  assert.equal(definition.plugins.length, CAPABILITY_ROWS.length + 1, '能力行数量应与能力清单一致，再多一行是人设行');
  assert.equal(definition.plugins.at(-1).id, 'specialist-persona');
  assert.equal(definition.plugins.at(-1).name, SPECIALIST_ROW_NAME);
  assert.equal(definition.plugins.at(-1).config.persona, renderSpecialistPersona(specialist()));
  // 每一行都是展开后的 Loader entry。
  for (const entry of definition.plugins) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.name, 'string');
  }
});

test('specialist preset 绝不包含指挥者协议行', () => {
  // 这是整个设计的关键否定断言：specialist 若挂上 `commander-mode`，它也会读到
  // "指挥者不自己动手"，于是拒绝任何写文件/跑命令的活 —— 模式最糟糕的故障。
  // 注意人设行的 name 是 `dsh-commander-mode/specialist`，是包出口而不是包名本身。
  const { plugins } = specialistPresetDefinition(specialist());
  assert.ok(!plugins.some((entry) => entry.id === 'commander-mode'), '不能有 commander-mode 行');
  assert.ok(!plugins.some((entry) => entry.name === 'dsh-commander-mode'), '不能挂本插件主入口');
  assert.ok(plugins.some((entry) => entry.name === SPECIALIST_ROW_NAME), '但必须挂 specialist 人设行');
});

// ---------------------------------------------------------------- 输出解析 ---

test('outputText 只拼接 text 块，用空行分隔', () => {
  // activation 的 output 是块数组，可能混着图片/工具块。若把非 text 块当成文本，
  // 结果里会出现 "[object Object]" 并把子代理的答复淹没。
  assert.equal(
    outputText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]),
    '第一段\n\n第二段',
  );
  assert.equal(
    outputText([{ type: 'image', data: 'x' }, { type: 'text', text: '正文' }, null, 42, { type: 'text' }, { type: 'text', text: '' }]),
    '正文',
  );
});

test('outputText 对非数组输入返回空串', () => {
  for (const output of [undefined, null, '文本', {}, 42]) assert.equal(outputText(output), '');
});

test('结算：正常输出被 trim，字段齐全', () => {
  const value = renderSettlement({
    output: [{ type: 'text', text: '  改完了，3 个文件。  ' }],
    stopReason: 'completed',
  });
  // childId 由 execute 用 `started.childId` 覆盖，这里只是占位。
  assert.deepEqual(value, { childId: '', stopReason: 'completed', text: '改完了，3 个文件。', truncated: false });
});

test('结算：没有文本时给出可读回退，而不是空字符串', () => {
  // 空字符串会让指挥者以为"工具返回了但什么都没说"，于是重试或空转。
  // 明确写"没有留下收尾文本"才是可以据以决策的信息。
  assert.equal(
    renderSettlement({ output: [], stopReason: 'completed' }).text,
    '（子代理没有留下收尾文本）',
  );
  assert.equal(
    renderSettlement({ output: [{ type: 'text', text: '   ' }], stopReason: 'completed' }).text,
    '（子代理没有留下收尾文本）',
  );
});

test('结算：非 completed 的停止原因写进回退文本', () => {
  // 出错时必须把 stopReason 带回来，否则用户排障时只知道"子代理没说话"。
  const value = renderSettlement({ output: [], stopReason: 'error' });
  assert.equal(value.stopReason, 'error');
  assert.ok(value.text.includes('停止原因：error'));
});

test('结算：stopReason 缺失或非字符串时归一为 unknown', () => {
  // 工具返回值的 `stopReason` 是 schema 里的必填 string；这里不归一，
  // 运行时校验会以 invalid output 拒绝整个工具调用。
  for (const stopReason of [undefined, null, 42, {}]) {
    const value = renderSettlement({ output: [], stopReason });
    assert.equal(value.stopReason, 'unknown');
    assert.equal(typeof value.text, 'string');
  }
});

test('结算：恰好 MAX_RESULT_CHARS 不截断', () => {
  // 边界差一（写成 `>=`）的后果是每个刚好到上限的答复都带上"已截断"，误导用户。
  const exact = 'x'.repeat(MAX_RESULT_CHARS);
  const value = renderSettlement({ output: [{ type: 'text', text: exact }], stopReason: 'completed' });
  assert.equal(value.truncated, false);
  assert.equal(value.text, exact);
});

test('结算：超长输出被截断，并标注原始长度', () => {
  // 子代理可能写很长的报告，全量塞回上下文会挤掉指挥者的工作记忆。
  // 标注里的长度必须是**原始**长度，否则用户会以为原文只有截断后的那么长。
  const oversized = 'x'.repeat(MAX_RESULT_CHARS + 5000);
  const value = renderSettlement({ output: [{ type: 'text', text: oversized }], stopReason: 'completed' });
  assert.equal(value.truncated, true);
  assert.ok(value.text.startsWith(oversized.slice(0, MAX_RESULT_CHARS)), '必须保留原文前缀');
  assert.ok(value.text.includes(`原始长度 ${oversized.length} 字符`), '必须标注原始长度');
  assert.ok(value.text.length < oversized.length, '截断后应比原文短');
});

test('结算：settled 缺失也不炸', () => {
  // activation 的 result 若返回 undefined（适配器异常），工具不能因此抛一个
  // 看不懂的 TypeError —— 至少要把"没有收尾文本"带回给指挥者。
  const value = renderSettlement(undefined);
  assert.equal(value.stopReason, 'unknown');
  assert.equal(value.text, '（子代理没有留下收尾文本；停止原因：unknown）');
});

// ---------------------------------------------------------------- 工具定义 ---

test('工具名与描述写明路由与可选覆盖', () => {
  // 模型靠描述决定"把这个任务派给谁"。路由写错 = 派给错误的模型；
  // 漏写推理等级/输出上限 = 用户配置在模型眼里不存在。
  const withOverrides = buildSpecialistToolDefinition({
    specialist: specialist({ reasoningEffort: 'high', maxTokens: 4096 }),
    presetId: 'preset-x',
    getSubagents: () => undefined,
  });
  assert.equal(withOverrides.name, 'subagent_architect');
  assert.ok(withOverrides.description.includes('deepseek/deepseek-reasoner'));
  assert.ok(withOverrides.description.includes('推理等级 high'));
  assert.ok(withOverrides.description.includes('输出上限 4096 tokens'));

  const bare = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  assert.ok(!bare.description.includes('推理等级'));
  assert.ok(!bare.description.includes('输出上限'));
});

test('工具描述声明"只用于该定位"，并给出错配时的出路', () => {
  // 用户要求：派活要考虑子智能体的定位，差距大就开新子智能体。
  // 工具描述是指挥者每次看到该工具时唯一的定位说明，所以必须在这里写明：
  // 定位是什么、错配时改派给谁（另一个工具或 Team 通道新开子智能体）。
  const tool = buildSpecialistToolDefinition({
    specialist: specialist({ description: '负责代码审查与测试' }),
    presetId: 'preset-x',
    getSubagents: () => undefined,
  });
  assert.ok(tool.description.includes('属于该定位'), '要说明只适用于该定位');
  assert.ok(tool.description.includes('负责代码审查与测试'), '要带上 specialist 的职责');
  assert.ok(tool.description.includes('差距大'), '要给出错配判断口径');
  assert.ok(tool.description.includes('不要硬派'));
  assert.ok(tool.description.includes('新开一个子智能体'), '要指出错配时的出路');
});

test('parameters 的 required 在顶层数组里', () => {
  // DSH 的 JSON Schema 子集要求 `required` 是顶层数组；写成属性里的
  // `required: true` 会被 `JsonSchemaError` 拒绝，工具注册失败（模块头注释记录了实测）。
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  assert.deepEqual(tool.parameters.required, ['task']);
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.task.type, 'string');
  assert.equal(tool.parameters.properties.description.type, 'string');
});

test('output schema 的 required 在顶层，四个字段齐全', () => {
  // 返回值要过运行时校验：缺任何一个字段都会得到 `tool returned invalid output`，
  // 指挥者拿不到子代理的答复，等于这条通道白建。
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  assert.deepEqual([...tool.output.schema.required].sort(), ['childId', 'stopReason', 'text', 'truncated']);
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.additionalProperties, false);
  for (const field of tool.output.schema.required) {
    assert.ok(tool.output.schema.properties[field], `schema 里缺少 ${field} 的定义`);
  }
});

test('output.render 把 id、结算原因与正文一起给模型', () => {
  // render 的结果就是模型实际读到的工具返回值。丢掉正文 = 指挥者以为子代理没产出；
  // 丢掉 stopReason = 出错与成功看起来一样。
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  const rendered = tool.output.render(
    { task: 't' },
    { childId: 'child-1', stopReason: 'completed', text: '改完了。', truncated: false },
  );
  assert.equal(Array.isArray(rendered), true);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('architect'));
  assert.ok(rendered[0].text.includes('completed'));
  assert.ok(rendered[0].text.includes('改完了。'));
});

test('工具声明并发安全（前台派发不共享可变状态）', () => {
  // false 会让 DSH 把整批工具调用串行化，浪费并行能力；而 specialist 工具本身
  // 除了「读配置、起一个子会话」之外不碰共享状态。
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  assert.equal(tool.isConcurrencySafe(), true);
});

// ---------------------------------------------------------------- 工具执行 ---

test('specialist 已不在名册时拒绝执行，且不启动子代理', () => {
  // 一个已打开会话可能持有旧的工具对象，而设置页已经把该 specialist 删了。
  // 继续执行会让它跑在一个「配置里不存在」的 preset 上，或者更糟：把旧模型
  // 当成新名册的一部分继续派活。
  const { calls, service } = fakeSubagents();
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => service, isEnabled: () => false });
  return assert.rejects(() => tool.execute({ task: 't' }, { agent: { id: 'lead' } }), /不在当前名册/u).then(() => {
    assert.equal(calls.activations.length, 0, '被拒绝的执行不应真的启动子代理');
  });
});

test('没有 subagents 服务的部署里给出替代路径', () => {
  // 精简部署（用户关掉相关行）里既不能执行也没法派活。错误信息必须指出
  // 替代通道（Team / workflow），否则模型只会反复重试这个工具。
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => undefined });
  return assert.rejects(
    () => tool.execute({ task: 't' }, { agent: { id: 'lead' } }),
    (error) => {
      assert.ok(error.message.includes('subagents 服务'));
      assert.ok(error.message.includes('workflow'), '要给出替代通道');
      return true;
    },
  );
});

test('exec.agent 缺失时拒绝执行并点名工具', async () => {
  // activation 必须有 parent；缺了它子会话会变成孤儿。错误信息点名工具名，
  // 模型才能理解是这次调用形状不对，而不是部署坏了。
  const { calls, service } = fakeSubagents();
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => service });
  for (const exec of [undefined, null, {}, { agent: null }]) {
    await assert.rejects(() => tool.execute({ task: 't' }, exec), /subagent_architect/u);
  }
  assert.equal(calls.activations.length, 0);
});

test('execute 的 activation 契约完整且正确', () => {
  // 这些字段是照着随附 `dsh-tool-subagent` 的 execute 抄的契约。错任何一个的后果：
  // - `delivery` 不是 'caller' → 结果变成后台 completion notice，前台工具永远等不到；
  // - `agentPreset` 错 → 子代理跑在错误的 preset 上（可能挂上指挥者协议）；
  // - `agentOptions` 错 → 用户配置的模型根本没生效；
  // - `maxDepth` 错 → 递归预算泄漏或子代理直接无法启动。
  const { calls, service } = fakeSubagents({ resolvedMaxDepth: 2 });
  const specialistEntry = specialist({ reasoningEffort: 'high', maxTokens: 4096 });
  const presetId = specialistPresetId(specialistEntry);
  const tool = buildSpecialistToolDefinition({ specialist: specialistEntry, presetId, getSubagents: () => service });
  const agent = { id: 'session-lead' };
  const signal = { aborted: false };

  return tool.execute({ task: '拆一下这个需求' }, { agent, signal }).then((value) => {
    assert.equal(calls.activations.length, 1);
    const activation = calls.activations[0];
    assert.equal(activation.provider, 'spawn');
    assert.equal(activation.delivery, 'caller');
    assert.equal(activation.signal, signal, '取消信号必须透传，否则 interrupt 打不断子代理');
    assert.equal(activation.request.parent, agent);
    assert.equal(activation.request.agentPreset, presetId);
    assert.deepEqual(activation.request.prompt, [{ type: 'text', text: '拆一下这个需求' }]);
    assert.deepEqual(activation.request.agentOptions, {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      maxTokens: 4096,
    });
    assert.equal(activation.request.maxDepth, 2);
    assert.deepEqual(calls.resolveMaxDepth, [1], '递归预算从 1 开始问');
    // label 是派活摘要；省略时用职责描述。
    assert.equal(activation.label, '负责系统架构与拆分');
    // 返回值必须覆盖 renderSettlement 的占位 childId，并与 output schema 的字段完全一致。
    assert.equal(value.childId, 'child-1');
    assert.equal(value.stopReason, 'completed');
    assert.equal(value.text, '子代理答复');
    assert.equal(value.truncated, false);
    assert.deepEqual(Object.keys(value).sort(), [...tool.output.schema.required].sort());
  });
});

test('args.description 优先做 label，且被 trim', () => {
  // label 显示在任务列表/日志里。用未 trim 的原始值会让界面出现前后空格；
  // 用错字段（例如把 task 全文当 label）会让列表变成一堵墙。
  const { calls, service } = fakeSubagents();
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => service });
  return tool
    .execute({ task: 't', description: '  审查改动  ' }, { agent: { id: 'lead' } })
    .then(() => {
      assert.equal(calls.activations[0].label, '审查改动');
    })
    .then(() => tool.execute({ task: 't', description: '   ' }, { agent: { id: 'lead' } }))
    .then(() => {
      assert.equal(calls.activations[1].label, '负责系统架构与拆分', '空白 description 应回退到职责描述');
    });
});

test('职责描述过长时 label 截到 60 字符', () => {
  // 界面里的 label 是有长度预期的；塞进 200 字会让任务列表错位。
  const longDescription = '负责'.repeat(80);
  const { calls, service } = fakeSubagents();
  const tool = buildSpecialistToolDefinition({ specialist: specialist({ description: longDescription }), presetId: 'preset-x', getSubagents: () => service });
  return tool.execute({ task: 't' }, { agent: { id: 'lead' } }).then(() => {
    assert.equal(calls.activations[0].label.length, 60);
  });
});

test('resolveMaxDepth 返回 undefined 时不带 maxDepth 键', () => {
  // 塞一个 `maxDepth: undefined` 进去，运行时校验/序列化可能把它当成非法值，
  // 而这个字段本来是可选的 —— 没有就该整键省略。
  const { calls, service } = fakeSubagents({ resolvedMaxDepth: undefined });
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => service });
  return tool.execute({ task: 't' }, { agent: { id: 'lead' } }).then(() => {
    assert.equal('maxDepth' in calls.activations[0].request, false);
  });
});

test('子代理结算文本原样带回，数字 childId 转成字符串', async () => {
  // output schema 声明 childId 是 string。适配器给数字时不转换，
  // 运行时校验会拒绝整个返回值（`tool returned invalid output`）。
  const numeric = {
    resolveMaxDepth: (depth) => depth,
    startActivation: async () => ({
      childId: 42,
      result: Promise.resolve({ output: [{ type: 'text', text: '审查意见：没问题' }], stopReason: 'completed' }),
    }),
  };
  const tool = buildSpecialistToolDefinition({ specialist: specialist(), presetId: 'preset-x', getSubagents: () => numeric });
  const value = await tool.execute({ task: 't' }, { agent: { id: 'lead' } });
  assert.equal(value.childId, '42');
  assert.equal(value.text, '审查意见：没问题');
});

// ---------------------------------------------------------------- 安装 ---

test('installSpecialist 先注册 preset、再注册工具，且工具绑定刚注册的 preset id', async () => {
  // 顺序反了的话工具可能在 preset 存在之前就被某个会话拿到。工具绑定的 preset id
  // 若不是"刚注册的这个"，子代理会跑在旧 revision 或完全不存在的 preset 上。
  const { calls, service } = fakeSubagents();
  const { ctx, record } = fakeInstallCtx();
  const specialistEntry = specialist();
  const dispose = await installSpecialist({ ctx, specialist: specialistEntry, getSubagents: () => service });
  const presetId = specialistPresetId(specialistEntry);

  assert.deepEqual(record.events, [`preset:register:${presetId}`, 'tool:register:subagent_architect']);
  assert.equal(record.presets.length, 1);
  assert.equal(record.presets[0].id, presetId);
  assert.equal(record.tools.length, 1);

  await record.tools[0].execute({ task: 't' }, { agent: { id: 'lead' } });
  assert.equal(calls.activations[0].request.agentPreset, presetId, '工具必须把活派到自己的 preset 里');
  await dispose();
});

test('disposer 同时释放工具与 preset，顺序是先工具后 preset', async () => {
  // 先释放工具是关键：窗口期内若工具还活着而 preset 已经没了，一次并发调用会在
  // `startActivation()` 里以一个难懂的 preset 不存在错误失败。
  const { ctx, record } = fakeInstallCtx();
  const dispose = await installSpecialist({ ctx, specialist: specialist(), getSubagents: () => fakeSubagents().service });
  const presetId = specialistPresetId(specialist());

  await dispose();
  assert.deepEqual(record.events, [
    `preset:register:${presetId}`,
    'tool:register:subagent_architect',
    'tool:dispose:subagent_architect',
    `preset:unregister:${presetId}`,
  ]);
  assert.deepEqual(record.presets, []);
  assert.deepEqual(record.tools, []);
});

test('工具注册失败时回滚已注册的 preset', async () => {
  // 不留半注册状态：一个只有 preset、没有工具的 specialist 会让协议里出现一个
  // 调不动的工具名；而且下次重试时同一个 preset id 可能撞上未释放的旧 revision。
  const { ctx, record } = fakeInstallCtx({ failToolRegister: true });
  const presetId = specialistPresetId(specialist());
  await assert.rejects(
    () => installSpecialist({ ctx, specialist: specialist(), getSubagents: () => fakeSubagents().service }),
    /tools\.register 失败/u,
  );
  assert.deepEqual(record.events, [`preset:register:${presetId}`, 'tool:register-failed', `preset:unregister:${presetId}`]);
  assert.deepEqual(record.presets, []);
});

test('工具释放在作用域销毁后失败，不影响 preset 释放', async () => {
  // 作用域销毁时工具可能已经被 Cordis 先一步释放，此时 disposer 抛错很正常。
  // 若它阻断后续 unregister，preset 会泄漏，下一次重建就撞 id。
  const events = [];
  const ctx = {
    agentPresets: {
      async register() {
        return async () => events.push('preset:unregister');
      },
    },
    tools: {
      register() {
        return () => {
          events.push('tool:dispose');
          throw new Error('tool 已随作用域销毁');
        };
      },
    },
  };
  const dispose = await installSpecialist({ ctx, specialist: specialist(), getSubagents: () => fakeSubagents().service });
  await dispose(); // 不应抛错
  assert.deepEqual(events, ['tool:dispose', 'preset:unregister']);
});
