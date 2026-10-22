/**
 * 能力行清单与 bundle patch 的一致性测试（`lib/capabilities.js` × `cordis.patch.yml`）。
 *
 * 为什么同一份能力行要写两遍：`cordis.patch.yml` 是声明式的（Loader 读它，声明
 * commander preset），而 specialist preset 是**运行时**按名册生成的（条数不定），
 * 只能由 JS 常量展开。两份一旦漂移，故障是静默的：
 *
 * - JS 侧漏一行 → 所有 specialist 都少一项能力（漏 `tool-fs` = 子代理没有文件系统，
 *   漏 `tool-shell` = 跑不了测试），而指挥官本身看起来完全正常；
 * - YAML 侧漏一行 → 指挥者少了那项能力。历史事故正是 `tool-fs` 缺席，用户反馈
 *   "读取不到下载目录的文件"；
 * - name 漂移（包改名）→ id 断言看不出来，但 Loader 找不到模块，整个 preset 不激活。
 *
 * 本包刻意零依赖，所以这里用逐行正则解析 YAML（与 `test/patch.test.mjs` 同一套写法），
 * 不引入 YAML 库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  CAPABILITY_ROWS,
  allCapabilityRowIds,
  capabilityRowIds,
  specialistPresetPlugins,
  toEntry,
} from '../lib/capabilities.js';

// ---------------------------------------------------------------- YAML 解析 ---

const PATCH = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const LINES = PATCH.split('\n');

/** 定位 CAPABILITIES 块：起止注释之间的内容行。 */
function capabilityBlock() {
  const start = LINES.findIndex((line) => line.includes('# ---- CAPABILITIES'));
  const end = LINES.findIndex((line) => line.includes('# ---- end CAPABILITIES'));
  return { start, end, lines: start >= 0 && end > start ? LINES.slice(start + 1, end) : [] };
}
const { start: BLOCK_START, end: BLOCK_END, lines: BLOCK } = capabilityBlock();

/** 块内给定缩进层级的 `- id:` 行（保序）。顶层 10 空格，group 子行 14 空格。 */
function rowIds(indent) {
  const pattern = new RegExp(`^ {${indent}}- id: (.+?)\\s*$`, 'u');
  return BLOCK.map((line) => pattern.exec(line)?.[1]).filter((id) => id !== undefined);
}

/** 块内给定缩进层级的 `name:` 行（保序）。顶层 12 空格，group 子行 16 空格。 */
function rowNames(indent) {
  const pattern = new RegExp(`^ {${indent}}name: (.+?)\\s*$`, 'u');
  return BLOCK.map((line) => pattern.exec(line)?.[1]).filter((name) => name !== undefined);
}

/** 去掉 YAML 的单引号（`'@deepseek-ai/x'` → `@deepseek-ai/x`）。 */
function unquote(value) {
  return value.replace(/^'(.*)'$/u, '$1');
}

/** 从一个顶层行 id 到下一个顶层行之间的 YAML 文本（含子行）。 */
function rowBlock(id) {
  const start = BLOCK.findIndex((line) => new RegExp(`^ {10}- id: ${id}\\s*$`, 'u').test(line));
  assert.ok(start >= 0, `CAPABILITIES 块里找不到行 ${id}`);
  let end = start + 1;
  while (end < BLOCK.length && !/^ {10}- id: /u.test(BLOCK[end])) end += 1;
  return BLOCK.slice(start, end).join('\n');
}

/** 一个 group 子行到下一个 `- id:`（任意层级）之间的 YAML 文本。 */
function childRowBlock(id) {
  const start = BLOCK.findIndex((line) => new RegExp(`^ {14}- id: ${id}\\s*$`, 'u').test(line));
  assert.ok(start >= 0, `CAPABILITIES 块里找不到子行 ${id}`);
  let end = start + 1;
  while (end < BLOCK.length && !/^ {10,14}- id: /u.test(BLOCK[end])) end += 1;
  return BLOCK.slice(start, end).join('\n');
}

/** 某一行的 `disabled:` 值原文（没有 disabled 行时返回 undefined）。 */
function rowDisabled(id) {
  const line = rowBlock(id).split('\n').find((entry) => /^ {12}disabled: /u.test(entry));
  return line?.replace(/^ {12}disabled: /u, '').trim();
}

/** JS 侧 group 子行的扁平列表（保持 CAPABILITY_ROWS 的顺序）。 */
function jsChildRows() {
  return CAPABILITY_ROWS.flatMap((row) => (Array.isArray(row.config) ? row.config : []));
}

// ---------------------------------------------------------------- 逐行比对 ---

test('CAPABILITIES 块存在，两端标记把能力行围起来', () => {
  // 下面所有比对都靠这两个标记定位。标记被改名或删除时，不能静默通过 ——
  // 否则"一致性测试"会在什么都没比对的情况下全绿。
  assert.ok(BLOCK_START >= 0, 'patch 里找不到 CAPABILITIES 起点标记');
  assert.ok(BLOCK_END > BLOCK_START, '找不到或找不到正确的 CAPABILITIES 终点标记');
  assert.ok(BLOCK.length > 0);
  assert.equal(rowIds(10)[0], 'agent-instructions');
  assert.equal(rowIds(10).at(-1), 'present');
});

test('顶层行 id 与 capabilityRowIds() 逐行一致', () => {
  // 两侧必须声明同一套能力行、同一顺序。任一方向增删或改名，对应 preset 的那个
  // agent 就少一项能力：`dsh-web-app` 把能力行全局禁用了，preset 里没重新声明的
  // 行**不存在**。
  assert.deepEqual(rowIds(10), capabilityRowIds());
});

test('group 子行 id 与 JS 的 group 内配置逐行一致', () => {
  // compaction / delegation 组的内部构成可以不同（有意为之），但两边必须一致：
  // 一边多一个压缩插件，两个模式的上下文压缩行为就不一样了。
  assert.deepEqual(rowIds(14), jsChildRows().map((child) => child.id));
});

test('块内所有 id 的合并序列与 allCapabilityRowIds() 逐行一致', () => {
  // 只比顶层会漏掉"YAML 多一个子行 / JS 少一个子行"这种漂移。
  const merged = BLOCK.map((line) => /^ {10,14}- id: (.+?)\s*$/u.exec(line)?.[1]).filter((id) => id !== undefined);
  assert.deepEqual(merged, allCapabilityRowIds());
});

test('顶层行的 name 与 JS 常量逐行一致', () => {
  // id 相同但包名漂移（改名、加 scope、拼错）时，id 断言看不出来，Loader 却会
  // 因为找不到模块而让整个 preset 不激活。
  assert.deepEqual(rowNames(12).map(unquote), CAPABILITY_ROWS.map((row) => row.name));
});

test('group 子行的 name 与 JS 常量逐行一致', () => {
  assert.deepEqual(rowNames(16).map(unquote), jsChildRows().map((child) => child.name));
});

test('能力清单不含模式专属行与旧 subagent 控件', () => {
  // 这份清单是"指挥者与 specialist 共用"的能力集合，不是模式组合：
  // - `commander-mode` 混进来 → specialist preset 也会挂上指挥者协议，子代理拒绝动手；
  // - `tool-subagent*` 混进来 → 与「智能体团队」的九个工具冲突（两套 send_message）。
  const ids = allCapabilityRowIds();
  for (const forbidden of ['commander-mode', 'persona', 'plan-mode', 'tool-plugin-manager']) {
    assert.ok(!ids.includes(forbidden), `能力清单不得包含 ${forbidden}`);
  }
  for (const forbidden of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']) {
    assert.ok(!ids.includes(forbidden), `能力清单不得包含旧控件 ${forbidden}`);
  }
});

// ---------------------------------------------------------------- group ---

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

test('YAML 的 group 行带 isolate，内容与 JS 一致', () => {
  const groups = CAPABILITY_ROWS.filter((row) => row.group === true);
  // group: true 与 isolate: 的行数都等于 group 数（没有"忘了写 isolate 的 group"）。
  assert.equal(BLOCK.filter((line) => /^ {12}group: true\s*$/u.test(line)).length, groups.length);
  assert.equal(BLOCK.filter((line) => /^ {12}isolate:\s*$/u.test(line)).length, groups.length);
  // 两个 group 的 isolate 键必须与 JS 的常量逐字一致。
  assert.match(
    PATCH,
    /- id: compaction\n\s+name: cordis:group\n\s+group: true\n\s+isolate:\n\s+compaction: true\n\s+toolResultPruner: true/u,
  );
  assert.match(PATCH, /- id: delegation\n\s+name: cordis:group\n\s+group: true\n\s+isolate:\n\s+workflowEngine: true/u);
});

// ---------------------------------------------------------------- shell ---

test('两个 shell 行的平台条件互斥，当前平台恰好保留一个', () => {
  // 同时启用 → 两行注册同名工具（`bash` 与 `pwsh` 本身不重名，但两个 shell 通道
  // 会被同时暴露，行为不确定）；同时禁用 → 子代理没有任何 shell，跑不了测试。
  const bash = CAPABILITY_ROWS.find((row) => row.id === 'tool-bash');
  const pwsh = CAPABILITY_ROWS.find((row) => row.id === 'tool-pwsh');
  assert.deepEqual(bash.disabled, { platform: 'not-win32' });
  assert.deepEqual(pwsh.disabled, { platform: 'win32' });

  const win32 = process.platform === 'win32';
  const bashEntry = toEntry(bash);
  const pwshEntry = toEntry(pwsh);
  assert.equal(bashEntry.disabled, win32, 'Windows 上禁用 bash');
  assert.equal(pwshEntry.disabled, !win32, '非 Windows 上禁用 pwsh');
  assert.notEqual(bashEntry.disabled, pwshEntry.disabled, '两个 shell 行必须一开一关');
});

test('YAML 的 shell 条件与 JS 语义一致', () => {
  // YAML 用 `!!js` 表达式，JS 用 `{platform}` 抽象条件；两边写反的后果是
  // Windows 上装了 bash、Linux 上装了 pwsh，两条通道都失效。
  assert.equal(rowDisabled('tool-bash'), "!!js process.platform === 'win32'", 'bash 只在非 win32 启用（等价于 not-win32 条件）');
  assert.equal(rowDisabled('tool-pwsh'), "!!js process.platform !== 'win32'", 'pwsh 只在 win32 启用（等价于 win32 条件）');
});

// ---------------------------------------------------------------- config ---

test('关键行的 config 在 YAML 与 JS 两侧一致', () => {
  // id/name 一致只保证"装了哪些行"，config 决定"那些行怎么工作"。
  // 这里的每一行都有可见行为：glob 超限采样、并行 todo、web 抓取、上下文裁剪。
  const cases = [
    { id: 'agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  ];
  for (const { id, config } of cases) {
    const row = CAPABILITY_ROWS.find((entry) => entry.id === id);
    assert.ok(row, `JS 侧缺少 ${id}`);
    assert.deepEqual(toEntry(row).config, config, `JS 侧 ${id} 的 config 不符`);
    const block = rowBlock(id);
    for (const [key, value] of Object.entries(config)) {
      assert.match(block, new RegExp(`^ {14}${key}: ${value}\\s*$`, 'mu'), `YAML 侧 ${id} 缺少 ${key}: ${value}`);
    }
  }
});

test('group 子行的 config 在两侧一致', () => {
  // 裁剪阈值与 workflow provider 决定 specialist / 指挥者的上下文与编排行为。
  const pruner = jsChildRows().find((row) => row.id === 'tool-result-pruner');
  assert.deepEqual(toEntry(pruner).config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  for (const [key, value] of Object.entries({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })) {
    assert.match(childRowBlock('tool-result-pruner'), new RegExp(`^ {18}${key}: ${value}\\s*$`, 'mu'));
  }

  const workflow = jsChildRows().find((row) => row.id === 'workflow-ptc');
  assert.deepEqual(toEntry(workflow).config, { provider: 'spawn' });
  assert.match(childRowBlock('workflow-ptc'), /^ {18}provider: spawn\s*$/mu);
});

// ---------------------------------------------------------------- toEntry ---

test('toEntry 展开 disabled 的三种写法', () => {
  // specialist preset 是运行时构造的普通对象，写不了 YAML 的 `!!js`，所以平台条件
  // 在 JS 里落成布尔。这里求值错的后果与 YAML 表达式写反一样：平台行永远开/关。
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
  // 没有 disabled 时塞一个 `disabled: false` 会让 Loader entry 多一个无意义字段；
  // 未知平台条件静默 fallback 会让平台行在错误平台上启用 —— 两种都要防。
  const entry = toEntry({ id: 'x', name: 'y' });
  assert.equal('disabled' in entry, false);
  assert.throws(() => toEntry({ id: 'x', name: 'y', disabled: { platform: 'linux' } }), /未知的平台条件/u);
  assert.throws(() => toEntry({ id: 'x', name: 'y', disabled: {} }), /未知的平台条件/u);
});

test('toEntry 只产出 Loader 认识的字段', () => {
  // 把内部元数据（未来可能给 CAPABILITY_ROWS 加字段）带进 Loader entry，
  // 轻则 warning，重则被当成未知配置拒绝。
  const entry = toEntry(CAPABILITY_ROWS.find((row) => row.id === 'compaction'));
  assert.deepEqual(Object.keys(entry).sort(), ['config', 'group', 'id', 'isolate', 'name']);
  assert.equal(entry.group, true);
  // 子行也被展开成 entry，而不是原始描述对象。
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

// ---------------------------------------------------------------- id 工具 ---

test('capabilityRowIds 返回新数组，调用方改不动常量', () => {
  // 调用方（协议渲染、审计工具）可能 map/filter，但也可能不小心 push。
  // 返回内部数组会让一次误操作永久改掉"能力清单"。
  const ids = capabilityRowIds();
  assert.notEqual(ids, capabilityRowIds());
  ids.push('junk');
  assert.equal(capabilityRowIds().length, CAPABILITY_ROWS.length);
  assert.ok(!capabilityRowIds().includes('junk'));
});

test('allCapabilityRowIds 按文件顺序展开顶层行与子行', () => {
  // 这个顺序就是与 YAML 逐行比对的基准。顺序错了（例如把子行统一排到最后），
  // deepEqual 会漏报真实的漂移，或者对正确配置误报。
  const expected = [];
  for (const row of CAPABILITY_ROWS) {
    expected.push(row.id);
    if (Array.isArray(row.config)) for (const child of row.config) expected.push(child.id);
  }
  assert.deepEqual(allCapabilityRowIds(), expected);
  // 子行确实被包含进来了。
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
  // 每个 entry 都有 Loader 必需的 id 与 name。
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
  // 每装一个 specialist 就调用一次。共享数组会让第二次注册带上第一次的改动
  // （例如上一次下游改过的 config），故障只在"有两个以上 specialist"时出现。
  const first = specialistPresetPlugins({ personaSectionName: 'x', persona: 'a' });
  first[0].config.maxBytes = 1;
  first.push({ id: 'junk', name: 'junk' });

  const second = specialistPresetPlugins({ personaSectionName: 'x', persona: 'a' });
  assert.equal(second.length, CAPABILITY_ROWS.length + 1);
  assert.equal(second[0].config.maxBytes, 65536);
  assert.equal(second.at(-1).config.persona, 'a');
});
