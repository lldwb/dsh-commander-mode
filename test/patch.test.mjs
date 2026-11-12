/**
 * bundle patch 测试。
 *
 * 这些是对 `cordis.patch.yml` 的结构性断言 —— Loader 正是读这个文件来合成这两个模式。
 * 它们之所以存在，是因为一个随附 bug 没有任何单元测试能抓住：一个 preset 只声明了
 * 自己插件、没声明能力行，而 `@deepseek-ai/dsh-web-app` 把能力行全局禁用了，于是那个
 * 模式下的会话**没有文件系统、没有 shell、也没有 AGENTS.md**。
 *
 * ## 3.7.0 起：YAML 只保留声明元数据
 *
 * 能力行与模式行改由 `lib/preset-plugins.js` 从 `lib/capabilities.js` 拼装（单一来源），
 * `cordis.patch.yml` 不再写 `plugins`。所以本文件现在断言的是：
 *
 * 1. patch 只插入三行（配置行 + 两个模式声明行），能力行 / 模式行都不在 YAML；
 * 2. 两个模式声明行仍写全 `id / name / description / order`（Loader 与插件页读它们）；
 * 3. 能力行本身的关键契约（tool-fs config、两个 group 的 isolate、shell 互斥、
 *    不含旧 subagent 控件）—— 这些现在查 JS 清单，与 `capabilities.test.mjs` 互补；
 * 4. 配置行的位置与命名约束（必须是 profile 顶层、裸包名）。
 *
 * 本文件用逐行分析而不是 YAML 库来解析：这个包是刻意零依赖的，而下面的断言是结构性的。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { capabilityEntries, capabilityRowIds } from '../lib/capabilities.js';

const PATCH = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const LINES = PATCH.split('\n');

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

// ---------------------------------------------------------------- 能力行 ---

test('3.7.0：patch 只插入三行（配置行 + 两个模式声明行），能力行不在 YAML', () => {
  // 能力行改由 lib/preset-plugins.js 从 lib/capabilities.js 拼装（单一来源）。
  // 这条断言防止有人把能力行块复制回 YAML —— 那样单一来源就又变成两份。
  assert.deepEqual(allRowIds().sort(), ['commander-mode', 'preset-commander', 'preset-project-manager']);
});

test('3.7.0：两个模式声明行不再写 plugins，只留声明元数据', () => {
  for (const presetId of PRESETS) {
    const block = presetBlock(presetId);
    assert.ok(!/^\s{6}plugins:/mu.test(block), `${presetId} 不应再声明 plugins`);
    // 声明元数据必须齐（Loader 与插件页都读它们）。
    for (const key of ['id', 'name', 'description', 'order']) {
      assert.match(block, new RegExp(`\\n {8}${key}: .+\\n`, 'u'), `${presetId} 缺 ${key}`);
    }
  }
});

test('3.7.0：两个模式的能力行由同一份 JS 清单拼装（不再靠 YAML 逐字节比对）', () => {
  // 旧的"两份 CAPABILITIES 块逐字节一致"断言已随 YAML 块一起删除；现在由
  // lib/preset-plugins.js 的单一来源保证，测试在 capabilities.test.mjs 里钉住。
  assert.ok(!PATCH.includes('# ---- CAPABILITIES'), 'YAML 不应再有 CAPABILITIES 块');
  // 但 patch 仍要说明能力行从哪来（否则下一个人会以为是漏写了）。
  assert.match(PATCH, /lib\/preset-plugins\.js/u);
  assert.match(PATCH, /lib\/capabilities\.js/u);
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
  // tool-subagent / tool-subagent-fork。在 preset 里重新声明它们会把刚关掉的旧控件装回来，
  // 于是同时拿到两套 send_message / list_agents / interrupt_agent。
  // 3.7.0 起能力行在 JS 里，所以查 JS 清单（见 capabilities.test.mjs 的同类断言）。
  const ids = capabilityRowIds();
  for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
    assert.ok(!ids.includes(id), `能力清单不得包含 ${id} —— 它会与智能体团队冲突`);
  }
  // 也不许出现 subagent / subagent_fork 这两个工具名。
  assert.ok(!PATCH.includes('toolName: subagent'));
});

test('0.2.2：tool-fs 显式写 applyPatch: false（逐字镜像 standard）', () => {
  // standard 从 0.2.2 起显式写 applyPatch: false（默认也是 false），镜像做到逐字一致。
  const toolFs = capabilityEntries().find((entry) => entry.id === 'tool-fs');
  assert.deepEqual(toolFs, { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } });
});

test('delegation 组只保留 workflow 这条编排通道', () => {
  const delegation = capabilityEntries().find((entry) => entry.id === 'delegation');
  assert.equal(delegation.group, true);
  assert.deepEqual(delegation.isolate, { workflowEngine: true });
  assert.deepEqual(delegation.config.map((row) => row.id), ['workflow-ptc', 'tool-workflow']);
});

test('compaction 组带着它自己的 isolate', () => {
  // 少了 isolate，几个模式会共享压缩 / 工具结果裁剪状态。
  const compaction = capabilityEntries().find((entry) => entry.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
});

test('两个平台的 shell 行互斥（JS 侧落成布尔）', () => {
  const shell = capabilityEntries().filter((entry) => entry.id === 'tool-bash' || entry.id === 'tool-pwsh');
  assert.equal(shell.length, 2);
  assert.notEqual(shell[0].disabled, shell[1].disabled, '两个 shell 行必须一开一关');
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

test('preset-project-manager 声明正确（id / 显示名 / 描述 / order 8）', () => {
  assert.match(PATCH, /- id: preset-project-manager\n(?:\s+#.*\n)*\s+name: 'dsh-commander-mode\/preset-project-manager'/u);
  assert.match(PATCH, /config:\n\s+id: project-manager\n\s+name: 项目经理模式/u);
  assert.match(PATCH, /order: 8/u);
  // 3.6.0 起描述要写清"六位专家 + 按任务形状拆分 + 六段可选"，不能再写"带门禁流水线"。
  assert.match(PATCH, /description: 用六位开发流程专家/u);
  assert.match(PATCH, /按任务形状拆分与派单/u);
  assert.match(PATCH, /六段工作流可选/u);
  assert.ok(!/跑一条带门禁的项目流水线/u.test(PATCH), 'preset 描述不应再写强制流水线');
});

test('3.7.0：模式行由 JS 拼装，YAML 里不再有它们的 id', () => {
  // 模式行（commander-mode-agent / project-manager-agent / project-dev-workflow）
  // 改由 lib/preset-plugins.js 注入；YAML 里出现它们就意味着又回到"两份"。
  for (const id of ['commander-mode-agent', 'project-manager-agent', 'project-dev-workflow']) {
    assert.ok(!allRowIds().includes(id), `YAML 不应再声明模式行 ${id}`);
  }
  // 但 patch 注释要说明它们从哪来（否则下一个人会以为是漏写了）。
  assert.match(PATCH, /lib\/preset-plugins\.js/u);
});

test('配置行是 profile 顶层行（模式行不在 YAML，无法再按缩进断言）', () => {
  // 配置行必须是顶层行：preset 子行不进 Loader entry 树，设置页看不到它的 Config
  // （dsh 0.2.1-rc.2 实测：命名空间不可达 → 设置卡片静默消失）。
  // 而且 name 必须是**裸包名**：dsh-client-modules 对含 `/` 的说明符直接放弃，
  // 写成 'dsh-commander-mode/host' 会让 client 半永远进不了页面清单。
  assert.match(PATCH, /\n {4}- id: commander-mode\n(?: {6}#.*\n)* {6}name: 'dsh-commander-mode'\n/u);
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
    // 3.0.0：三层指挥链门禁开关（默认开）。漏写它，按 id 定向覆盖时会被整块替换回默认值。
    'delegationHierarchy',
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

test('3.1.0：patch 不含 maxWaitMs 配置键（禁止等待、不设开关）', () => {
  // 用户 2026-11-11 补充要求：禁止等待子智能体，且**不设开关**。
  // 2.0.0 的 `maxWaitMs: 120000`（0 = 关闭）已从 patch 删除；只要这里还能写，用户就会
  // 把它当成"关掉门禁"的开关。所以断言的是**配置键**不存在（注释里可以说明它已下线）。
  assert.ok(!/\n {8}maxWaitMs:/u.test(PATCH), 'patch 的 config 不应再写 maxWaitMs 键');
  // 注释要说明"禁止等待 + 没有开关"，否则用户不知道为什么配置里没有这个键。
  assert.match(PATCH, /禁止等待/u);
  assert.match(PATCH, /没有开关|不设开关/u);
  // 3.1.0 起 `wait_agent` 是硬禁用：配置块里不应再有 120000 这个旧默认值。
  assert.ok(!/maxWaitMs: 120000/u.test(PATCH), '旧默认值 120000 不应残留');
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
  // 3.0.0：8 → 16（规则 2，与运行时并行上限对齐）。
  assert.match(PATCH, /\n {8}maxAsyncTasks: 16/u);
  // 关掉后的语义要写清楚：回退 0.5.0 的前台阻塞行为。
  assert.match(PATCH, /回退 0\.5\.0 的前台阻塞行为/u);
});

test('3.0.0：patch 写全三层指挥链配置（maxTeammates 16 / delegationHierarchy 默认开）', () => {
  // 用户 2026-11-11 规则 2 与规则 4：并行上限 16，且「只有小组长改进度与排期」的门禁默认开启。
  // patch 里的 config 是**整块替换**语义：漏写一个键，用户抄这一行做覆盖时就会把它重置成
  // schema 默认值——所以加载期键都要显式写出来（既是文档也是覆盖模板）。
  assert.match(PATCH, /\n {8}maxTeammates: 16/u);
  assert.match(PATCH, /\n {8}delegationHierarchy: true/u);
  // 注释要说明它控制什么、关掉后的后果（回退 2.x 只靠协议）。
  assert.match(PATCH, /三层指挥链/u);
  assert.match(PATCH, /关掉退化为只靠协议约束/u);
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

test('3.6.0：所有 locale JSON 可解析，且中英键完全一致', () => {
  // 3.5.0 发布时踩过：改 `locale/en.json` 的描述时写进了未转义的双引号
  // （`... the bundled "Agent preset definition".)`），文件变成非法 JSON，而当时没有任何
  // 测试解析 locale —— 插件页读不到描述，但测试全绿。这条守卫把这类事故挡在提交前。
  const dirs = ['locale', 'preset-commander/locale', 'preset-project-manager/locale'];
  /** 递归收集一个对象的所有键路径（只用于比对中英是否同构）。 */
  const keyPaths = (value, prefix = '') => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  };
  for (const dir of dirs) {
    const zh = JSON.parse(fs.readFileSync(new URL(`../${dir}/zh.json`, import.meta.url), 'utf8'));
    const en = JSON.parse(fs.readFileSync(new URL(`../${dir}/en.json`, import.meta.url), 'utf8'));
    assert.deepEqual(keyPaths(zh).sort(), keyPaths(en).sort(), `${dir} 的中英键不一致`);
    // 描述类字段不能为空（空描述会让插件页显示成一片空白）。
    for (const locale of [zh, en]) {
      assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title.length > 0, `${dir} 缺 meta.title`);
      assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 0, `${dir} 缺 meta.description`);
    }
  }
});
