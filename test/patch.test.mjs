/**
 * bundle patch 测试。
 *
 * 这些是对 `cordis.patch.yml` 的结构性断言 —— Loader 正是读这个文件来合成这个模式。
 * 它们之所以存在，是因为一个随附 bug 没有任何单元测试能抓住：一个 preset 只声明了
 * 自己插件、没声明能力行，而 `@deepseek-ai/dsh-web-app` 把能力行全局禁用了，于是那个
 * 模式下的会话**没有文件系统、没有 shell、也没有 AGENTS.md**。
 *
 * 本文件用逐行分析而不是 YAML 库来解析：这个包是刻意零依赖的，而下面的断言是结构性的。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const PATCH = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const LINES = PATCH.split('\n');

/** 顶层（`plugins:` 那一层，10 个空格）的行 id。 */
function topRowIds() {
  return LINES.map((line) => /^ {10}- id: (.+?)\s*$/u.exec(line)?.[1]).filter((id) => id !== undefined);
}

/** 文件里所有行 id，含嵌套 group 的子行。 */
function allRowIds() {
  return LINES.map((line) => /^\s*- id: (.+?)\s*$/u.exec(line)?.[1]).filter((id) => id !== undefined);
}

/** 本包从 `@deepseek-ai/dsh-preset-standard` 镜像的能力行。 */
const CAPABILITY_ROWS = [
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
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

test('一个模式所需的每一行能力都声明了', () => {
  // 下面每一个都曾在真实会话里被观察到**缺失**。`tool-fs` 就是用户报的那个
  // （"读取不到下载目录的文件"）；`agent-instructions` 缺席时模式看不见工作区约定。
  const declared = allRowIds();
  for (const id of CAPABILITY_ROWS) {
    assert.ok(declared.includes(id), `缺少 ${id} 这一行`);
  }
});

test('顶层行集合恰好是能力行加本插件', () => {
  const declared = topRowIds();
  assert.deepEqual([...declared].sort(), [...CAPABILITY_ROWS, 'commander-mode'].sort());
});

test('与 preset-standard 的三处省略是有意为之', () => {
  // 已用 preset_audit 核对：preset-standard 顶层 19 行，本块镜像其中 16 行。
  // persona：不声明也已经生效，再声明有重复 section 的风险。
  // plan-mode：60 行随附文案，与本模式自带的"规划 + 让用户确认"冲突。
  // tool-plugin-manager：装插件属于"执行操作"，本模式下要派给子代理。
  for (const id of ['persona', 'planning', 'plan-mode', 'tool-plugin-manager']) {
    assert.ok(!topRowIds().includes(id), `不得声明 ${id}`);
  }
});

test('不声明旧的 subagent 控件，把派发通道让给智能体团队', () => {
  // `@deepseek-ai/dsh-experimental-agent-team-profile` 会禁用 tool-subagent-control /
  // tool-subagent-list-agents / tool-subagent / tool-subagent-fork。在 preset 里重新声明
  // 它们会把刚关掉的旧控件装回来，于是指挥者同时拿到两套 send_message / list_agents /
  // interrupt_agent，行为变得不确定。
  const declared = allRowIds();
  for (const id of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork']) {
    assert.ok(!declared.includes(id), `不得声明 ${id} —— 它会与智能体团队冲突`);
  }
  // 也不许出现 subagent / subagent_fork 这两个工具名。
  assert.ok(!PATCH.includes('toolName: subagent'));
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

test('preset 声明本身正确', () => {
  // 声明行的 id 是 Loader 编辑地址，config.id 才是 preset 标识符。
  assert.match(PATCH, /- id: preset-commander\n\s+name: '@deepseek-ai\/dsh-agent-preset'/u);
  assert.match(PATCH, /config:\n\s+id: commander\n\s+name: 指挥者模式/u);
  assert.match(PATCH, /order: 7/u);
  // 显示名与描述是自命名的，不会进翻译表，所以必须直接写中文。
  assert.match(PATCH, /description: .*子代理/u);
});

test('本插件挂成 preset 子行，且排在能力行之后', () => {
  const declared = topRowIds();
  assert.equal(declared[declared.length - 1], 'commander-mode', '插件行应在最后');
  assert.match(PATCH, /- id: commander-mode\n\s+name: 'dsh-commander-mode'/u);
  // 门禁清单必须写在这里，而不是只靠默认值 —— 用户改这一行就能调整边界。
  assert.match(PATCH, /confirmPlan: true/u);
  assert.match(PATCH, /escalateOnConflict: true/u);
  assert.match(PATCH, /blockedTools:/u);
});

test('这份 patch 从不插入顶层行', () => {
  // 全局行会把模式的工具泄漏到其它每一个模式里。本 patch 里的一切都必须活在 preset 的
  // `plugins` 列表之下。
  const topLevelIds = LINES.filter((line) => /^- id: /u.test(line));
  assert.deepEqual(topLevelIds, []);
  assert.equal(LINES.filter((line) => line.trim() === '- insert:').length, 1);
});

test('只声明一个 preset', () => {
  assert.equal(LINES.filter((line) => /^ {4}- id: preset-/u.test(line)).length, 1);
});
