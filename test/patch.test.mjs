/**
 * bundle patch 测试。
 *
 * 这些是对 `cordis.patch.yml` 的结构性断言 —— Loader 正是读这个文件来合成这两个模式。
 * 它们之所以存在，是因为一个随附 bug 没有任何单元测试能抓住：一个 preset 只声明了
 * 自己插件、没声明能力行，而 `@deepseek-ai/dsh-web-app` 把能力行全局禁用了，于是那个
 * 模式下的会话**没有文件系统、没有 shell、也没有 AGENTS.md**。
 *
 * 2.0.0 起 patch 里有两个 preset（指挥者 / 项目经理）。本文件除了各自的结构断言，还锁住
 * 一条硬约束：**项目经理模式的 CAPABILITIES 与指挥者模式逐字节一致**，只有
 * `skill-filesystem` 一行多出 `customSkillDirs`（加载本包 `skills/` 目录）——否则两个模式
 * 会慢慢漂移成"一个能用 shell、另一个没有文件系统"。
 *
 * 本文件用逐行分析而不是 YAML 库来解析：这个包是刻意零依赖的，而下面的断言是结构性的。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const PATCH = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const LINES = PATCH.split('\n');

/** 本包从 `@deepseek-ai/dsh-preset-standard`（DSH 0.2.2-rc.1）镜像的能力行。 */
const CAPABILITY_ROWS = [
  'agent-instructions',
  'time-context',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'tool-schedule',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'compaction',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
];

/** 两个 preset（顺序 = patch 里的声明顺序）。 */
const PRESETS = ['preset-commander', 'preset-project-manager'];

/** 文件里所有行 id，含嵌套 group 的子行。 */
function allRowIds() {
  return LINES.map((line) => /^\s*- id: (.+?)\s*$/u.exec(line)?.[1]).filter((id) => id !== undefined);
}

/**
 * 一个顶层 preset 块的原文（从 `    - id: <presetId>` 到下一个 4 空格缩进的顶层行）。
 *
 * @param {string} presetId - preset 行 id。
 * @returns {string} 块文本。
 */
function presetBlock(presetId) {
  const start = PATCH.indexOf(`    - id: ${presetId}\n`);
  assert.ok(start >= 0, `找不到 preset ${presetId}`);
  const next = PATCH.slice(start + 1).search(/\n {4}- id: /u);
  const end = next < 0 ? PATCH.length : start + 1 + next;
  return PATCH.slice(start, end);
}

/**
 * 一个 preset 块里 `plugins:` 那一层（10 空格）的行 id。
 *
 * @param {string} presetId - preset 行 id。
 * @returns {string[]} 行 id（保序，含 group 顶层行，不含 group 子行）。
 */
function presetPluginRowIds(presetId) {
  const block = presetBlock(presetId);
  return block
    .split('\n')
    .map((line) => /^ {10}- id: (.+?)\s*$/u.exec(line)?.[1])
    .filter((id) => id !== undefined);
}

/**
 * 一个 preset 块里 CAPABILITIES 注释标记之间的原文。
 *
 * @param {string} presetId - preset 行 id。
 * @returns {string} 能力块文本（含两端标记）。
 */
function capabilityBlockOf(presetId) {
  const block = presetBlock(presetId);
  const start = block.indexOf('          # ---- CAPABILITIES');
  const end = block.indexOf('          # ---- end CAPABILITIES');
  assert.ok(start >= 0, `${presetId} 缺 CAPABILITIES 起点标记`);
  assert.ok(end > start, `${presetId} 缺 CAPABILITIES 终点标记`);
  const endLine = block.indexOf('\n', end);
  return block.slice(start, endLine < 0 ? block.length : endLine + 1);
}

/**
 * 把一个能力块按行拆成独立 row 的原文（注释行跟着它下面的 row）。
 *
 * @param {string} block - 能力块文本。
 * @returns {{ id: string | undefined, text: string }[]} row 列表。
 */
function capabilityRows(block) {
  const chunks = block.split(/\n(?= {10}- id: )/u).map((text) => text.replace(/\n+$/u, ''));
  return chunks.map((text) => ({ id: /^ {10}- id: (.+?)\s*$/mu.exec(text)?.[1], text }));
}

// ---------------------------------------------------------------- 能力行 ---

test('两个模式所需的每一行能力都声明了', () => {
  // 下面每一个都曾在真实会话里被观察到**缺失**。`tool-fs` 就是用户报的那个
  // （"读取不到下载目录的文件"）；`agent-instructions` 缺席时模式看不见工作区约定。
  for (const presetId of PRESETS) {
    const declared = presetPluginRowIds(presetId);
    for (const id of CAPABILITY_ROWS) {
      assert.ok(declared.includes(id), `${presetId} 缺少 ${id} 这一行`);
    }
  }
});

test('每个 preset 的插件行集合恰好是能力行加它自己的模式行', () => {
  assert.deepEqual([...presetPluginRowIds('preset-commander')].sort(), [...CAPABILITY_ROWS, 'commander-mode-agent'].sort());
  assert.deepEqual(
    [...presetPluginRowIds('preset-project-manager')].sort(),
    [...CAPABILITY_ROWS, 'project-manager-agent', 'project-dev-workflow'].sort(),
  );
});

test('项目经理模式的 CAPABILITIES 与指挥者模式逐字节一致（只允许 skill-filesystem 多 customSkillDirs）', () => {
  // 这是 2.0.0 最关键的结构约束：两份能力块必须来自同一份复制，谁改了一边没改另一边，
  // 对应的模式就会少一项能力，而故障是静默的。
  const commander = capabilityBlockOf('preset-commander');
  const manager = capabilityBlockOf('preset-project-manager');
  // 注释允许不同，所以逐 row 比对而不是逐字节比整块。row 文本里注释会跟着 row 走，
  // 但本包的两个块使用同一份注释；差异只应出现在 skill-filesystem 这一行。
  const left = capabilityRows(commander);
  const right = capabilityRows(manager);
  assert.equal(left.length, right.length, '两个能力块的行数不一致');
  for (let index = 0; index < left.length; index += 1) {
    assert.equal(left[index].id, right[index].id, `第 ${index + 1} 行的 id 不一致`);
    if (left[index].id === 'skill-filesystem') {
      assert.ok(
        right[index].text.startsWith(left[index].text),
        '项目经理模式的 skill-filesystem 行应当在指挥者模式的同一行之后追加 config',
      );
      assert.ok(right[index].text.includes('customSkillDirs'), 'skill-filesystem 行缺 customSkillDirs');
      continue;
    }
    assert.equal(right[index].text, left[index].text, `能力行 ${left[index].id} 两侧不一致`);
  }
});

test('只有项目经理模式的 skill-filesystem 带 customSkillDirs（指向本包 skills/）', () => {
  const commander = capabilityBlockOf('preset-commander');
  const manager = capabilityBlockOf('preset-project-manager');
  assert.ok(!commander.includes('customSkillDirs'), '指挥者模式不应加载本包 skills/ 目录（保持 1.x 行为）');
  // 用包名定位包目录、join 'skills'，不写死任何绝对路径。
  assert.match(manager, /customSkillDirs:\n\s+- !!js >-\n\s+process\.getBuiltinModule\('node:path'\)\.join\(/u);
  assert.match(manager, /createRequire\(baseUrl\)\.resolve\('dsh-commander-mode\/package\.json'\)\), 'skills'\)/u);
});

test('两个 CAPABILITIES 块的标记各出现两次（防止只复制了块内容、没复制标记）', () => {
  assert.equal(PATCH.split('# ---- CAPABILITIES (mirrors @deepseek-ai/dsh-preset-standard)').length - 1, 2);
  assert.equal(PATCH.split('# ---- end CAPABILITIES').length - 1, 2);
});

test('与 preset-standard 的四处省略是有意为之', () => {
  // 已核对到 DSH 0.2.2-rc.1：preset-standard（packages/bundle/web-app/presets/
  // standard.patch.yml）顶层 22 行，本块镜像其中 18 行。
  // persona：不声明也已经生效，再声明有重复 section 的风险。
  // plan-mode：60 行随附文案，与本模式自带的"规划 + 让用户确认"冲突。
  // tool-plugin-manager：装插件属于"执行操作"，本模式下要派给子代理。
  // tool-plugin-market：同上（随附时也是 disabled: true）。
  const declared = allRowIds();
  for (const id of ['persona', 'planning', 'plan-mode', 'tool-plugin-manager', 'tool-plugin-market']) {
    assert.ok(!declared.includes(id), `不得声明 ${id}`);
  }
});

test('不声明旧的 subagent 控件，把派发通道让给智能体团队', () => {
  // `@deepseek-ai/dsh-experimental-agent-team-profile` 会禁用 tool-subagent-control /
  // tool-subagent / tool-subagent-fork（0.2.2 起 `list-agents` 子路径导出已移除，
  // list_agents 并进主入口，不再有第四行）。在 preset 里重新声明它们会把刚关掉的
  // 旧控件装回来，于是同时拿到两套 send_message / list_agents / interrupt_agent。
  const declared = allRowIds();
  for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
    assert.ok(!declared.includes(id), `不得声明 ${id} —— 它会与智能体团队冲突`);
  }
  // 也不许出现 subagent / subagent_fork 这两个工具名。
  assert.ok(!PATCH.includes('toolName: subagent'));
});

test('0.2.2：tool-fs 显式写 applyPatch: false（逐字镜像 standard）', () => {
  // standard 从 0.2.2 起显式写 applyPatch: false（默认也是 false），镜像做到逐字一致。
  assert.match(
    PATCH,
    /- id: tool-fs\n\s+name: '@deepseek-ai\/dsh-tool-fs'\n\s+config:\n(?:\s+#.*\n)*\s+applyPatch: false/u,
  );
});

test('delegation 组只保留 workflow 这条编排通道', () => {
  assert.ok(allRowIds().includes('workflow-ptc'));
  assert.ok(allRowIds().includes('tool-workflow'));
  assert.match(PATCH, /isolate:\n\s+workflowEngine: true/u);
});

test('compaction 组带着它自己的 isolate', () => {
  // 少了 isolate，几个模式会共享压缩 / 工具结果裁剪状态。
  assert.match(PATCH, /isolate:\n\s+compaction: true\n\s+toolResultPruner: true/u);
});

test('两个平台的 shell 行互斥', () => {
  assert.match(PATCH, /- id: tool-bash\n\s+name: '@deepseek-ai\/dsh-tool-bash'\n\s+disabled: !!js process\.platform === 'win32'/u);
  assert.match(PATCH, /- id: tool-pwsh\n\s+name: '@deepseek-ai\/dsh-tool-pwsh'\n\s+disabled: !!js process\.platform !== 'win32'/u);
});

// ---------------------------------------------------------------- preset ---

test('preset-commander 声明正确', () => {
  // 声明行的 id 是 Loader 编辑地址，config.id 才是 preset 标识符。
  // 2.1.0 起声明模块是本包自带的等效声明器：插件页组件行标题按「模块名」解析 locale，
  // 两个 preset 若共用随附的 @deepseek-ai/dsh-agent-preset，两行标题会一模一样。
  assert.match(PATCH, /- id: preset-commander\n(?:\s+#.*\n)*\s+name: 'dsh-commander-mode\/preset-commander'/u);
  assert.match(PATCH, /config:\n\s+id: commander\n\s+name: 指挥者模式/u);
  assert.match(PATCH, /order: 7/u);
  // 显示名与描述是自命名的，不会进翻译表，所以必须直接写中文。
  assert.match(PATCH, /description: .*子代理/u);
});

test('preset-project-manager 声明正确（id / 显示名 / 描述 / order 8 / 两行组件）', () => {
  assert.match(PATCH, /- id: preset-project-manager\n(?:\s+#.*\n)*\s+name: 'dsh-commander-mode\/preset-project-manager'/u);
  assert.match(PATCH, /config:\n\s+id: project-manager\n\s+name: 项目经理模式/u);
  assert.match(PATCH, /order: 8/u);
  // 描述要写清"六位专家 + 带门禁流水线 + 只编排与验收"。
  assert.match(PATCH, /description: 用六位开发流程专家/u);
  assert.match(PATCH, /只编排与验收、不自己写代码/u);
  // 两行组件：项目经理协议 + 流水线执行手册。
  assert.match(PATCH, /\n {10}- id: project-manager-agent\n {12}name: 'dsh-commander-mode\/project-manager'/u);
  assert.match(PATCH, /\n {10}- id: project-dev-workflow\n {12}name: 'dsh-commander-mode\/workflow'/u);
});

test('配置行是 profile 顶层行，模式行挂在 preset 里', () => {
  // 配置行必须是顶层行：preset 子行不进 Loader entry 树，设置页看不到它的 Config
  // （dsh 0.2.1-rc.2 实测：命名空间不可达 → 设置卡片静默消失）。
  // 而且 name 必须是**裸包名**：dsh-client-modules 对含 `/` 的说明符直接放弃，
  // 写成 'dsh-commander-mode/host' 会让 client 半永远进不了页面清单。
  assert.match(PATCH, /\n {4}- id: commander-mode\n(?: {6}#.*\n)* {6}name: 'dsh-commander-mode'\n/u);

  // 每个 preset 的模式行在它自己的 plugins 列表里（10 空格缩进），且是该块最后一行。
  for (const [presetId, lastRow] of [
    ['preset-commander', 'commander-mode-agent'],
    ['preset-project-manager', 'project-dev-workflow'],
  ]) {
    const rows = presetPluginRowIds(presetId);
    assert.equal(rows[rows.length - 1], lastRow, `${presetId} 的最后一行应是 ${lastRow}`);
  }
});

test('配置行不注册任何工具（避免能力泄漏到别的模式）', () => {
  // 顶层行会被每个模式看见。它只能装配置与服务；一旦挂工具/能力行，别的模式也会拿到。
  const block = PATCH.slice(
    PATCH.indexOf('    - id: commander-mode\n'),
    PATCH.indexOf('    - id: preset-commander\n'),
  );
  assert.ok(block.length > 0, '找不到配置行');
  assert.ok(!/name: '@deepseek-ai\/dsh-tool-/u.test(block), '配置行不得挂工具包');
  assert.ok(!/name: '@deepseek-ai\/dsh-agent-preset'/u.test(block));
  assert.ok(!/name: 'dsh-commander-mode\/preset-/u.test(block), '配置行不得声明 preset');
  assert.ok(block.includes("name: 'dsh-commander-mode'"));
});

test('配置行的 config 写全了加载期配置键（specialists 故意不写）', () => {
  // 声明 Config 之后，patch 里的 config 会整块通过 schema 校验；而按 id 定向的覆盖会
  // **整块替换** config —— 用户抄这一行做覆盖时，少写一个键就等于把它重置成默认值。
  // 所以加载期键都显式写出来，既是文档也是覆盖模板。
  //
  // `specialists` 是**故意不写**的：它的默认值是出厂预置名册（lib/presets.js），
  // 写 `specialists: []` 会把开箱专家抹掉；写一份数组又会在代码里多一份要维护的副本。
  for (const key of [
    'confirmPlan',
    'escalateOnConflict',
    'maxTeammates',
    'syncGuard',
    'blockedTools',
    'registerSkill',
    'maxSpecialists',
    'ledger',
    'stateDir',
    'requireMandate',
    'requireTicket',
    'asyncDelegation',
    'maxAsyncTasks',
    'workerSessions',
    'workRoot',
    'maxWorkers',
    'prepareCommand',
    'workerPermission',
    'ticketStallMs',
    'maxTickets',
    'eventInbox',
    'eventPollMs',
    'maxWaitMs',
  ]) {
    assert.match(PATCH, new RegExp(`\\n {8}${key}:`, 'u'), `config 里缺 ${key}`);
  }
  assert.ok(!/\n {8}specialists:/u.test(PATCH), 'specialists 不应写进 patch（默认即预置名册）');
  // 但必须留一行说明"默认即预置、想清空怎么写"，否则用户不知道从哪改。
  assert.match(PATCH, /默认值就是出厂预置名册/u);
  assert.match(PATCH, /specialists: \[\]/u, '注释里要给出清空写法');
});

test('名册开箱即预置：默认来自 lib/presets.js，不是空数组', () => {
  assert.match(PATCH, /maxSpecialists: 20/u);
  // patch 不覆盖 specialists → schema 默认值（出厂预置名册）生效。
  assert.ok(!/\n {8}specialists:/u.test(PATCH));
});

test('等待门禁配置写在 patch 里：默认 120000，0 = 关闭', () => {
  // 用户 2026-11-09 要求"等子代理不要一直等"（2.0.1 短暂关闭，2.0.2 改回开启）。
  assert.match(PATCH, /\n {8}maxWaitMs: 120000/u);
  assert.match(PATCH, /maxWaitMs: 120000/u);
  assert.match(PATCH, /0 = 关闭门禁|0 = 关闭/u);
  assert.match(PATCH, /wait_agent/u);
});

test('1.0.0：patch 写全 Worker Session 配置（默认开启）', () => {
  assert.match(PATCH, /\n {8}workerSessions: true/u);
  assert.match(PATCH, /\n {8}workRoot: ''/u);
  assert.match(PATCH, /\n {8}maxWorkers: 6/u);
  assert.match(PATCH, /\n {8}prepareCommand: ''/u);
  assert.match(PATCH, /\n {8}workerPermission: danger-full-access/u);
  // 默认开启的依据与"怎么关"要写在注释里（1.0.0 的行为变化）。
  assert.match(PATCH, /1\.0\.0 起默认开启/u);
  assert.match(PATCH, /显式写 false/u);
});

test('1.1.0：patch 写全外部事件配置（默认开启 + 轮询间隔）', () => {
  assert.match(PATCH, /\n {8}eventInbox: true/u);
  assert.match(PATCH, /\n {8}eventPollMs: 15000/u);
  // 注释里要说明事件从哪来、投递到哪，否则用户不知道 inbox 目录是什么。
  assert.match(PATCH, /events\/inbox\//u);
  assert.match(PATCH, /steer/u);
});

test('0.7.0：patch 写全异步派工配置（默认开）', () => {
  assert.match(PATCH, /\n {8}asyncDelegation: true/u);
  assert.match(PATCH, /\n {8}maxAsyncTasks: 8/u);
  // 关掉后的语义要写清楚：回退 0.5.0 的前台阻塞行为。
  assert.match(PATCH, /回退 0\.5\.0 的前台阻塞行为/u);
});

test('0.6.0：patch 写全账本与计划授权配置（默认开）', () => {
  assert.match(PATCH, /\n {8}ledger: true/u);
  assert.match(PATCH, /\n {8}requireMandate: true/u);
  assert.match(PATCH, /\n {8}requireTicket: true/u);
  assert.match(PATCH, /\n {8}stateDir: ''/u);
  assert.match(PATCH, /\n {8}ticketStallMs: 600000/u);
  assert.match(PATCH, /\n {8}maxTickets: 100/u);
  // 为什么默认开：注释要能让用户知道关掉后的后果（回退 0.5 行为）。
  assert.match(PATCH, /关掉后退化为 0\.5\.0/u);
});
