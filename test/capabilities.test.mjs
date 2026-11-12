/**
 * 能力行清单与两个 preset 组合的一致性测试。
 *
 * ## 3.7.0 起：能力行只有一份
 *
 * 3.6.0 及以前，同一份能力行存在**三处**：`lib/capabilities.js`（给 specialist 用）+
 * `cordis.patch.yml` 里两份逐字复制的 `CAPABILITIES` 块（给两个模式用），靠本文件逐行
 * 比对防漂移。3.7.0 起 `plugins` 由 `lib/preset-plugins.js` 在 JS 里拼装，
 * `cordis.patch.yml` 不再写 `plugins` —— 单一来源从"三份 + 测试"变成"一份"。
 *
 * 所以本文件现在钉的是：
 *
 * 1. **YAML 里不再有第二份**（没有 `plugins:`、没有 CAPABILITIES 块、没有能力行 id）；
 * 2. **两个 preset 共享同一份能力行**（逐字相同，唯一差异是 PM 的 `customSkillDirs`）；
 * 3. 模式行不串味（指挥者不带项目经理协议，反之亦然）；
 * 4. `toEntry` / `specialistPresetPlugins` 的既有契约不变（specialist 路径没被改坏）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  CAPABILITY_ROWS,
  allCapabilityRowIds,
  capabilityEntries,
  capabilityRowIds,
  specialistPresetPlugins,
  toEntry,
} from '../lib/capabilities.js';
import {
  COMMANDER_MODE_ROWS,
  PROJECT_MANAGER_MODE_ROWS,
  capabilityPartOf,
  commanderPresetPlugins,
  projectManagerPresetPlugins,
} from '../lib/preset-plugins.js';

const PATCH = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

/** 一个 preset 块（从 `    - id: <presetId>` 到下一个 4 空格缩进的顶层行）。 */
function presetBlock(presetId) {
  const start = PATCH.indexOf(`    - id: ${presetId}\n`);
  assert.ok(start >= 0, `找不到 preset ${presetId}`);
  const next = PATCH.slice(start + 1).search(/\n {4}- id: /u);
  return PATCH.slice(start, next < 0 ? PATCH.length : start + 1 + next);
}

/** JS 侧 group 子行的扁平列表（保持 CAPABILITY_ROWS 的顺序）。 */
function jsChildRows() {
  return CAPABILITY_ROWS.flatMap((row) => (Array.isArray(row.config) ? row.config : []));
}

// ------------------------------------------------ YAML 不再有第二份 ---

test('3.7.0：cordis.patch.yml 不再写 plugins（单一来源在 lib/capabilities.js）', () => {
  // 这是本次重构的核心断言：一旦有人把能力行块复制回 YAML，单一来源就又变成两份，
  // 而漂移的故障是静默的（某个模式少一项能力，另一个看起来完全正常）。
  assert.ok(!/^\s{6}plugins:/mu.test(PATCH), 'YAML 不应再声明 preset 的 plugins');
  assert.ok(!PATCH.includes('# ---- CAPABILITIES'), 'YAML 不应再有 CAPABILITIES 块标记');
  assert.ok(!PATCH.includes('mirrors @deepseek-ai/dsh-preset-standard'), 'YAML 不应再镜像能力行');
});

test('3.7.0：YAML 里不再出现任何能力行 id（能力行只在 lib/capabilities.js）', () => {
  const declared = PATCH.split('\n')
    .map((line) => /^\s*- id: (.+?)\s*$/u.exec(line)?.[1])
    .filter((id) => id !== undefined);
  // patch 只插入三行：配置行 + 两个模式声明行。
  assert.deepEqual(declared.sort(), ['commander-mode', 'preset-commander', 'preset-project-manager']);
  for (const id of allCapabilityRowIds()) {
    assert.ok(!declared.includes(id), `YAML 不应再声明能力行 ${id}`);
  }
});

test('3.7.0：两个模式声明行只留声明元数据（id / name / description / order）', () => {
  for (const [presetId, expected] of [
    ['preset-commander', { id: 'commander', order: '7' }],
    ['preset-project-manager', { id: 'project-manager', order: '8' }],
  ]) {
    const block = presetBlock(presetId);
    assert.match(block, new RegExp(`\\n {8}id: ${expected.id}\\n`, 'u'), `${presetId} 缺 config.id`);
    assert.match(block, new RegExp(`\\n {8}order: ${expected.order}\\n`, 'u'), `${presetId} 缺 order`);
    assert.match(block, /\n {8}name: .+\n/u, `${presetId} 缺显示名`);
    assert.match(block, /\n {8}description: .+\n/u, `${presetId} 缺描述`);
  }
});

// ------------------------------------------------ 单一来源拼装 ---

test('commanderPresetPlugins = 能力行 + 指挥者模式行', () => {
  const plugins = commanderPresetPlugins();
  assert.equal(plugins.length, CAPABILITY_ROWS.length + COMMANDER_MODE_ROWS.length);
  assert.deepEqual(plugins.slice(0, CAPABILITY_ROWS.length), CAPABILITY_ROWS.map((row) => toEntry(row)));
  assert.deepEqual(plugins.slice(CAPABILITY_ROWS.length), [{ id: 'commander-mode-agent', name: 'dsh-commander-mode/agent' }]);
  for (const entry of plugins) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '', '每个 entry 都要有 id');
    assert.ok(typeof entry.name === 'string' && entry.name !== '', '每个 entry 都要有 name');
  }
});

test('projectManagerPresetPlugins = 能力行 + 项目经理协议行 + 可选工作流行', () => {
  const plugins = projectManagerPresetPlugins();
  assert.equal(plugins.length, CAPABILITY_ROWS.length + PROJECT_MANAGER_MODE_ROWS.length);
  assert.deepEqual(
    plugins.slice(CAPABILITY_ROWS.length).map((entry) => entry.id),
    ['project-manager-agent', 'project-dev-workflow'],
  );
  assert.deepEqual(
    plugins.slice(CAPABILITY_ROWS.length).map((entry) => entry.name),
    ['dsh-commander-mode/project-manager', 'dsh-commander-mode/workflow'],
  );
});

test('两个 preset 的能力行逐字相同（唯一差异是 PM 的 customSkillDirs）', () => {
  // 这是 2.0.0 以来最关键的约束：能力行来自同一份清单，谁都不许私改。现在它由
  // "同一份 JS 常量"保证，测试钉住"确实没有第二份"。
  const commander = capabilityPartOf(commanderPresetPlugins(), COMMANDER_MODE_ROWS);
  const manager = capabilityPartOf(projectManagerPresetPlugins(), PROJECT_MANAGER_MODE_ROWS);
  assert.equal(commander.length, manager.length, '两个模式的能力行数量不一致');

  for (let index = 0; index < commander.length; index += 1) {
    const left = commander[index];
    const right = manager[index];
    assert.equal(left.id, right.id, `第 ${index + 1} 行 id 不一致`);
    assert.equal(left.name, right.name, `第 ${index + 1} 行 name 不一致`);
    assert.equal(left.group, right.group, `第 ${index + 1} 行 group 不一致`);
    assert.deepEqual(left.isolate, right.isolate, `第 ${index + 1} 行 isolate 不一致`);
    assert.equal(left.disabled, right.disabled, `第 ${index + 1} 行 disabled 不一致`);
    if (left.id === 'skill-filesystem') continue; // 唯一允许的差异，下面单独断言
    assert.deepEqual(left.config, right.config, `第 ${index + 1} 行 config 不一致`);
  }
});

test('只有项目经理模式的 skill-filesystem 带 customSkillDirs（指挥者保持 1.x 行为）', () => {
  const commander = capabilityPartOf(commanderPresetPlugins(), COMMANDER_MODE_ROWS);
  const manager = capabilityPartOf(projectManagerPresetPlugins({ skillDirs: ['/pkg/skills'] }), PROJECT_MANAGER_MODE_ROWS);
  assert.equal(commander.find((entry) => entry.id === 'skill-filesystem').config, undefined, '指挥者不应加载本包 skills/');
  assert.deepEqual(manager.find((entry) => entry.id === 'skill-filesystem').config, { customSkillDirs: ['/pkg/skills'] });
  // 空数组 / 非字符串项等价于"不加载"（避免给 skill-filesystem 一个坏路径）。
  for (const skillDirs of [undefined, [], [''], [null], 'nope']) {
    const plugins = projectManagerPresetPlugins({ skillDirs });
    assert.equal(plugins.find((entry) => entry.id === 'skill-filesystem').config, undefined, `skillDirs=${JSON.stringify(skillDirs)} 不应注入`);
  }
});

test('模式行不串味：两个 preset 各只带自己的模式行', () => {
  const commander = commanderPresetPlugins().map((entry) => entry.id);
  const manager = projectManagerPresetPlugins().map((entry) => entry.id);
  assert.ok(commander.includes('commander-mode-agent'));
  assert.ok(!commander.includes('project-manager-agent'), '指挥者模式不得挂项目经理协议');
  assert.ok(!commander.includes('project-dev-workflow'), '指挥者模式不得挂工作流手册');
  assert.ok(manager.includes('project-manager-agent'));
  assert.ok(manager.includes('project-dev-workflow'));
  assert.ok(!manager.includes('commander-mode-agent'), '项目经理模式不得挂指挥者协议');
});

test('两个 builder 每次返回独立的数组与对象（注册之间不串改）', () => {
  const first = commanderPresetPlugins();
  first[0].config.maxBytes = 1;
  first.push({ id: 'junk', name: 'junk' });

  const second = commanderPresetPlugins();
  assert.equal(second.length, CAPABILITY_ROWS.length + 1);
  assert.equal(second[0].config.maxBytes, 65536);

  const managerFirst = projectManagerPresetPlugins({ skillDirs: ['/a'] });
  managerFirst[0].config = { mutated: true };
  const managerSecond = projectManagerPresetPlugins({ skillDirs: ['/a'] });
  assert.deepEqual(managerSecond[0].config, { maxBytes: 65536 });
});

// ------------------------------------------------ 能力清单本身 ---

test('能力清单不含模式专属行与旧 subagent 控件', () => {
  // 这份清单是"两个模式与 specialist 共用"的能力集合，不是模式组合：
  // - `commander-mode-agent` 混进来 → specialist preset 也会挂上指挥者协议，子代理拒绝动手；
  // - `tool-subagent*` 混进来 → 与「智能体团队」的九个工具冲突（两套 send_message）；
  // - `tool-plugin-manager` / `tool-plugin-market` 混进来 → 装插件属于"执行操作"。
  const ids = allCapabilityRowIds();
  for (const forbidden of ['commander-mode', 'commander-mode-agent', 'persona', 'plan-mode', 'tool-plugin-manager', 'tool-plugin-market']) {
    assert.ok(!ids.includes(forbidden), `能力清单不得包含 ${forbidden}`);
  }
  for (const forbidden of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']) {
    assert.ok(!ids.includes(forbidden), `能力清单不得包含旧控件 ${forbidden}`);
  }
});

test('顶层行 id 与 capabilityRowIds() 一致，顺序稳定', () => {
  assert.deepEqual(capabilityRowIds(), CAPABILITY_ROWS.map((row) => row.id));
  assert.equal(capabilityRowIds()[0], 'agent-instructions');
  assert.equal(capabilityRowIds().at(-1), 'present');
});

test('group 子行 id 与 JS 常量一致', () => {
  assert.deepEqual(
    jsChildRows().map((child) => child.id),
    ['compaction-basic', 'command-compact', 'tool-result-pruner', 'workflow-ptc', 'tool-workflow'],
  );
});

test('每个 group 行在 JS 侧都带非空 isolate，非 group 行不带', () => {
  // 少了 isolate，compaction / workflowEngine 的状态会在模式之间共享 ——
  // 一个会话的压缩结果影响另一个模式。反过来，普通行带 isolate 是无效配置。
  const groups = CAPABILITY_ROWS.filter((row) => row.group === true);
  assert.deepEqual(groups.map((row) => row.id), ['compaction', 'delegation']);
  for (const row of groups) {
    assert.ok(Array.isArray(row.config), `${row.id} 的 config 应是子行数组`);
    assert.equal(typeof row.isolate, 'object');
    assert.ok(Object.keys(row.isolate).length > 0, `${row.id} 的 isolate 不能为空`);
  }
  for (const row of CAPABILITY_ROWS.filter((entry) => entry.group !== true)) {
    assert.equal(row.isolate, undefined, `${row.id} 不是 group，不应带 isolate`);
    assert.equal(row.group, undefined, `${row.id} 不是 group，不应带 group`);
  }
});

test('两个 shell 行的平台条件互斥，当前平台恰好保留一个', () => {
  // 同时启用 → 两个 shell 通道同时暴露，行为不确定；同时禁用 → 子代理没有任何 shell。
  const bash = CAPABILITY_ROWS.find((row) => row.id === 'tool-bash');
  const pwsh = CAPABILITY_ROWS.find((row) => row.id === 'tool-pwsh');
  assert.deepEqual(bash.disabled, { platform: 'not-win32' });
  assert.deepEqual(pwsh.disabled, { platform: 'win32' });

  const win32 = process.platform === 'win32';
  assert.equal(toEntry(bash).disabled, win32, 'Windows 上禁用 bash');
  assert.equal(toEntry(pwsh).disabled, !win32, '非 Windows 上禁用 pwsh');
  assert.notEqual(toEntry(bash).disabled, toEntry(pwsh).disabled, '两个 shell 行必须一开一关');
});

test('关键行的 config 与行为一致', () => {
  // id/name 一致只保证"装了哪些行"，config 决定"那些行怎么工作"。
  const cases = [
    { id: 'agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-fs', config: { applyPatch: false } },
    { id: 'tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  ];
  for (const { id, config } of cases) {
    const row = CAPABILITY_ROWS.find((entry) => entry.id === id);
    assert.ok(row, `JS 侧缺少 ${id}`);
    assert.deepEqual(toEntry(row).config, config, `JS 侧 ${id} 的 config 不符`);
  }
  // group 子行的 config 同样要在。
  const pruner = jsChildRows().find((row) => row.id === 'tool-result-pruner');
  assert.deepEqual(toEntry(pruner).config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  const workflow = jsChildRows().find((row) => row.id === 'workflow-ptc');
  assert.deepEqual(toEntry(workflow).config, { provider: 'spawn' });
});

// ------------------------------------------------ toEntry ---

test('toEntry 展开 disabled 的三种写法', () => {
  assert.equal(toEntry({ id: 'x', name: 'y', disabled: true }).disabled, true);
  assert.equal(toEntry({ id: 'x', name: 'y', disabled: false }).disabled, false);
  assert.equal(
    toEntry({ id: 'x', name: 'y', disabled: { platform: 'win32' } }).disabled,
    process.platform !== 'win32',
    'platform: win32 表示「只在 win32 可用」',
  );
  assert.equal(
    toEntry({ id: 'x', name: 'y', disabled: { platform: 'not-win32' } }).disabled,
    process.platform === 'win32',
    'platform: not-win32 表示「只在非 win32 可用」',
  );
});

test('toEntry 不写多余的 disabled 键，未知平台条件直接报错', () => {
  const entry = toEntry({ id: 'x', name: 'y' });
  assert.equal('disabled' in entry, false);
  assert.throws(() => toEntry({ id: 'x', name: 'y', disabled: { platform: 'linux' } }), /未知的平台条件/u);
  assert.throws(() => toEntry({ id: 'x', name: 'y', disabled: {} }), /未知的平台条件/u);
});

test('toEntry 只产出 Loader 认识的字段', () => {
  const entry = toEntry(CAPABILITY_ROWS.find((row) => row.id === 'compaction'));
  assert.deepEqual(Object.keys(entry).sort(), ['config', 'group', 'id', 'isolate', 'name']);
  assert.equal(entry.group, true);
  assert.equal(entry.config.length, 3);
  assert.deepEqual(Object.keys(entry.config[0]).sort(), ['id', 'name']);
});

test('toEntry 复制 config 与 isolate，修改结果不污染进程级常量', () => {
  // CAPABILITY_ROWS 是进程级常量（Object.freeze 只保护顶层）。若 entry 与常量共享
  // 嵌套对象，一个 preset 注册时被下游改写，后续每个 specialist preset 都会带上被污染的值。
  const instructions = toEntry(CAPABILITY_ROWS.find((row) => row.id === 'agent-instructions'));
  const compaction = toEntry(CAPABILITY_ROWS.find((row) => row.id === 'compaction'));
  instructions.config.maxBytes = 1;
  compaction.isolate.compaction = false;
  compaction.config[0].id = 'mutated';

  assert.equal(CAPABILITY_ROWS.find((row) => row.id === 'agent-instructions').config.maxBytes, 65536);
  assert.deepEqual(CAPABILITY_ROWS.find((row) => row.id === 'compaction').isolate, {
    compaction: true,
    toolResultPruner: true,
  });
  assert.equal(CAPABILITY_ROWS.find((row) => row.id === 'compaction').config[0].id, 'compaction-basic');
});

test('capabilityEntries 每次返回新对象，且默认等于 toEntry 展开', () => {
  const first = capabilityEntries();
  first[0].config.maxBytes = 1;
  assert.equal(capabilityEntries()[0].config.maxBytes, 65536);
  assert.deepEqual(capabilityEntries(), CAPABILITY_ROWS.map((row) => toEntry(row)));
});

// ------------------------------------------------ id 工具 ---

test('capabilityRowIds 返回新数组，调用方改不动常量', () => {
  const ids = capabilityRowIds();
  assert.notEqual(ids, capabilityRowIds());
  ids.push('junk');
  assert.equal(capabilityRowIds().length, CAPABILITY_ROWS.length);
  assert.ok(!capabilityRowIds().includes('junk'));
});

test('allCapabilityRowIds 按文件顺序展开顶层行与子行', () => {
  const expected = [];
  for (const row of CAPABILITY_ROWS) {
    expected.push(row.id);
    if (Array.isArray(row.config)) for (const child of row.config) expected.push(child.id);
  }
  assert.deepEqual(allCapabilityRowIds(), expected);
  assert.ok(allCapabilityRowIds().includes('compaction-basic'));
  assert.ok(allCapabilityRowIds().includes('workflow-ptc'));
});

// ---------------------------------------------- specialist preset 的 plugins ---

test('specialistPresetPlugins 是完整组合：能力行 + 末尾人设行', () => {
  // specialist preset 是完整组合，不是叠加层。漏一行 = 子代理少一项能力，
  // 而人设行必须在最后 —— 它是 `./specialist` 出口的 Loader 行，name 写错就 import 失败。
  const plugins = specialistPresetPlugins({ personaSectionName: 'dsh-commander-mode/specialist', persona: '你是审查者。' });
  assert.equal(plugins.length, CAPABILITY_ROWS.length + 1);
  assert.deepEqual(plugins.slice(0, -1), CAPABILITY_ROWS.map((row) => toEntry(row)));
  assert.deepEqual(plugins.at(-1), {
    id: 'specialist-persona',
    name: 'dsh-commander-mode/specialist',
    config: { persona: '你是审查者。' },
  });
  for (const entry of plugins) {
    assert.ok(typeof entry.id === 'string' && entry.id !== '');
    assert.ok(typeof entry.name === 'string' && entry.name !== '');
  }
  // shell 两行在 specialist preset 里同样互斥。
  const shellRows = plugins.filter((entry) => entry.id === 'tool-bash' || entry.id === 'tool-pwsh');
  assert.equal(shellRows.length, 2);
  assert.notEqual(shellRows[0].disabled, shellRows[1].disabled);
});

test('specialistPresetPlugins 绝不包含指挥者协议行', () => {
  // 最关键的否定断言：specialist 若挂上 `commander-mode`，它也会读到"指挥者不自己
  // 动手"，于是拒绝任何写文件/跑命令的派活。人设行的 name 是包出口
  // `dsh-commander-mode/specialist`，所以不能用"含 dsh-commander-mode 子串"来判。
  const plugins = specialistPresetPlugins({ personaSectionName: 'dsh-commander-mode/specialist', persona: '人设' });
  assert.ok(!plugins.some((entry) => entry.id === 'commander-mode'));
  assert.ok(!plugins.some((entry) => entry.name === 'dsh-commander-mode'));
  assert.ok(plugins.some((entry) => entry.name === 'dsh-commander-mode/specialist'));
});

test('specialistPresetPlugins 每次返回独立的数组与对象', () => {
  // 每装一个 specialist 就调用一次。共享数组会让第二次注册带上第一次的改动。
  const first = specialistPresetPlugins({ personaSectionName: 'x', persona: 'a' });
  first[0].config.maxBytes = 1;
  first.push({ id: 'junk', name: 'junk' });

  const second = specialistPresetPlugins({ personaSectionName: 'x', persona: 'a' });
  assert.equal(second.length, CAPABILITY_ROWS.length + 1);
  assert.equal(second[0].config.maxBytes, 65536);
  assert.equal(second.at(-1).config.persona, 'a');
});
