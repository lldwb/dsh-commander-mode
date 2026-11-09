/**
 * 「项目经理模式」的测试：协议文本 + 模式行接线（section / skill / 六位专家 / 门禁）。
 *
 * 这一组要证明三件事：
 *
 * 1. **协议真的把六段流水线与五条纪律写进去了** —— 用户 2026-11-09 提的四条要求
 *    （六位专家、不要长等、不要人日、git 分类提交 + 经验教训）都能在文本里逐条查到。
 * 2. **模式行真的挂上了** —— section 名字与 order、六位专家工具、skill 注册。
 * 3. **门禁是确定性的** —— 项目经理本人写文件被拒（子代理必须放行），超长 `wait_agent`
 *    被拒；没有这些，模式退化成"只会写协议"。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  FALLBACK_OPTIONS,
  SECTION_NAME,
  SECTION_ORDER,
  SKILL_NAME,
  apply,
  name as pluginName,
} from '../project-manager.js';
import { WORK_DISCIPLINE } from '../lib/discipline.js';
import {
  PIPELINE_SPECIALISTS,
  PIPELINE_STAGES,
  PROJECT_MANAGER_PROTOCOL,
} from '../lib/project-manager.js';
import { DEFAULT_BLOCKED_TOOLS } from '../lib/guard.js';
import { DEFAULT_SPECIALISTS } from '../lib/presets.js';
import { normalizeRoster, specialistPresetId, specialistToolName } from '../lib/specialists.js';
import { LEAD, TEAMMATE, defaultRoster, deferred, flush, listenerOf, makeCtx, makeSettings, spyNext } from './helpers.mjs';

/** 取 `tools/pre-execute` 监听器。 */
function preExecute(record) {
  return listenerOf(record, 'tools/pre-execute');
}

// ---------------------------------------------------------------- 协议文本 ---

test('协议第一句就声明「本模式调用六位开发流程专家」', () => {
  assert.ok(
    PROJECT_MANAGER_PROTOCOL.startsWith('# 项目经理模式\n\n本模式调用六位开发流程专家'),
    PROJECT_MANAGER_PROTOCOL.slice(0, 200),
  );
});

test('协议点名六位专家 id 与工具名', () => {
  assert.equal(PIPELINE_SPECIALISTS.length, 6);
  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.ok(PROJECT_MANAGER_PROTOCOL.includes(`\`${specialist.id}\``), `协议缺专家 id ${specialist.id}`);
    assert.ok(
      PROJECT_MANAGER_PROTOCOL.includes(`\`subagent_${specialist.id}\``),
      `协议缺点名工具 subagent_${specialist.id}`,
    );
  }
});

test('协议按顺序写出六段流水线，每段都有输入 / 产出 / 验收判据 / 不通过怎么办', () => {
  assert.deepEqual(PIPELINE_STAGES, ['架构', '实现', '审查', '测试', '安全', '文档']);
  let previous = -1;
  for (let index = 1; index <= 6; index += 1) {
    const marker = `第 ${index} 段`;
    const found = PROJECT_MANAGER_PROTOCOL.indexOf(marker);
    assert.ok(found >= 0, `缺 ${marker}`);
    assert.ok(found > previous, `${marker} 的顺序不对`);
    previous = found;
  }
  for (const keyword of ['输入：', '产出：', '验收判据：', '不通过怎么办：']) {
    const count = PROJECT_MANAGER_PROTOCOL.split(keyword).length - 1;
    assert.ok(count >= 6, `「${keyword}」只出现 ${count} 次（六段都应写明）`);
  }
  // 实现之后必须有独立审查与独立测试（不能由实现者兼）。
  assert.match(PROJECT_MANAGER_PROTOCOL, /独立于实现者/u);
  // 安全审计与文档不得省略。
  assert.match(PROJECT_MANAGER_PROTOCOL, /安全审计与文档\*\*不得省略\*\*/u);
});

test('协议禁止人日 / 人天 / 工期估算', () => {
  assert.match(PROJECT_MANAGER_PROTOCOL, /不做人日/u);
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('人天'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('工期'));
  // 用步骤 + 验收判据 + 依赖代替。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('验收判据'));
});

test('协议要求 git 分类提交与经验教训（含模式本身）', () => {
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('分类提交'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('短哈希'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('经验教训'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('项目经理模式本身'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('未提交视为该段未完成'));
});

test('协议写明等待纪律：短等待 + 门禁 + 依赖派工完成通知', () => {
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('wait_agent'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('60000'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('maxWaitMs'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('确定性拒绝'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('【派工完成】'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('list_agents'));
});

test('协议末尾原样拼接 lib/discipline.js 的 WORK_DISCIPLINE（不是另写一份）', () => {
  // 五条纪律只有一份真源。协议里若复述改写，迟早与门禁/README 漂移。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes(WORK_DISCIPLINE), '协议必须包含 WORK_DISCIPLINE 原文');
  assert.ok(PROJECT_MANAGER_PROTOCOL.trimEnd().endsWith(WORK_DISCIPLINE.trimEnd()), 'WORK_DISCIPLINE 应在协议末尾');
  assert.equal(PROJECT_MANAGER_PROTOCOL.split('# 工作纪律（用户 2026-11-09 复盘四会话后定下的硬规则）').length - 1, 1, '纪律正文只能出现一次');
});

test('协议不使用 Markdown 表格（会与其它 section 的排版打架）', () => {
  assert.ok(!/\|\s*:?-{3,}/u.test(PROJECT_MANAGER_PROTOCOL), '协议里不应出现 Markdown 表格分隔行');
});

// ---------------------------------------------------------------- 接线 ---

test('导出名与 section 契约正确（不与指挥者模式的 commander:mode 撞名）', () => {
  assert.equal(pluginName, 'project-manager-agent');
  assert.equal(SECTION_NAME, 'project-manager:mode');
  assert.notEqual(SECTION_NAME, 'commander:mode');
  assert.equal(SECTION_ORDER, 650);
  assert.equal(FALLBACK_OPTIONS.maxWaitMs, 120_000, '默认选项要带上等待门禁的上限');
});

test('注册项目经理 prompt section；teammate 拿不到（避免与执行者人设打架）', () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  assert.equal(record.sections.length, 1);
  const section = record.sections[0];
  assert.equal(section.name, SECTION_NAME);
  assert.equal(section.order, SECTION_ORDER);
  assert.equal(typeof section.text, 'function');
  assert.ok(section.text({ agent: LEAD }).includes('项目经理模式'));
  assert.equal(section.text({ agent: TEAMMATE }), '');
  // 拿不到身份时仍按项目经理渲染（旧调用方/单测直接调用不能整段消失）。
  assert.ok(section.text().includes('六位开发流程专家'));
});

test('注册 project-manager skill', () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  assert.equal(record.skills.length, 1);
  assert.equal(record.skills[0].name, SKILL_NAME);
  assert.equal(record.skills[0].name, 'project-manager');
  assert.equal(record.skills[0].source, 'runtime');
  assert.ok(record.skills[0].content.includes('六段流水线') || record.skills[0].content.includes('第 1 段'));
  assert.deepEqual(record.skills[0].invocation, { modelInvocable: true, userInvocable: true });
});

test('安装六位开发流程专家：六个 preset + 六个 subagent_<id> 工具，默认异步', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  await flush();

  assert.equal(record.presets.length, 6);
  assert.deepEqual(
    record.tools.map((tool) => tool.name).sort(),
    [
      'subagent_architect',
      'subagent_doc-writer',
      'subagent_implementer',
      'subagent_reviewer',
      'subagent_security-auditor',
      'subagent_tester',
    ],
  );
  // 专家 preset 不能挂上项目经理协议（否则专家会以为自己是经理）。
  for (const preset of record.presets) {
    assert.ok(preset.plugins.some((row) => row.name === 'dsh-commander-mode/specialist'));
    assert.ok(!preset.plugins.some((row) => row.id === 'project-manager-agent'));
  }
  // 默认异步：工具描述里应写明"异步 / 立即返回 / 完成通知"。
  const architect = record.tools.find((tool) => tool.name === 'subagent_architect');
  assert.match(architect.description, /异步/u);
  assert.match(architect.description, /【指挥者·派工完成】|完成.*通知/u);
});

test('异步派发完成后用「【项目经理·派工完成】」通知唤醒项目经理', async () => {
  const settlement = deferred();
  const { ctx, record } = makeCtx({
    settings: makeSettings({ specialists: defaultRoster() }),
    settlement: settlement.promise,
  });
  apply(ctx);
  await flush();

  const tool = record.tools.find((entry) => entry.name === 'subagent_architect');
  const agent = {
    id: 'session-lead',
    session: { id: 'session-lead', header: { id: 'session-lead' } },
    steers: [],
    steer(message) {
      this.steers.push(message);
    },
  };
  const started = await tool.execute({ task: '给出架构方案' }, { agent, signal: new AbortController().signal });
  assert.equal(started.async, true);
  assert.equal(started.stopReason, 'started');
  assert.equal(record.activations.length, 1);
  assert.equal(agent.steers.length, 0, '工具返回时不应已有通知');

  settlement.resolve({ output: [{ type: 'text', text: '方案见 docs/design.md\nSTATUS: ready' }], stopReason: 'completed' });
  await flush();

  assert.equal(agent.steers.length, 1);
  const notice = agent.steers[0].content[0].text;
  assert.match(notice, /【项目经理·派工完成】/u);
  assert.ok(notice.includes('subagent_architect'));
  assert.ok(notice.includes('STATUS: ready') || notice.includes('docs/design.md'));
  assert.ok(notice.includes('验收判据'), '通知要提醒按验收判据核对');
  assert.equal(agent.steers[0].source.kind, 'dsh-commander-mode');
});

test('配置行缺失 commanderSettings 时用出厂预置名册降级（模式仍能派活）', async () => {
  // 与指挥者模式行不同：PM 把 commanderSettings 当**可选**服务。缺它时不能只剩协议，
  // 否则这个模式在精简部署里派不了任何活。
  const { ctx, record } = makeCtx({ withCommanderSettings: false });
  apply(ctx);
  await flush();
  assert.equal(record.sections.length, 1);
  assert.equal(record.presets.length, 6);
  assert.equal(record.tools.filter((tool) => tool.name.startsWith('subagent_')).length, 6);
  assert.equal(record.warnings.length, 0, `不该刷 warning：${record.warnings.join(' | ')}`);
});

test('专家 preset 已被其它模式注册时，只补工具而不是丢掉整条专家通道', async () => {
  // 真实场景：`preset-commander` 与 `preset-project-manager` 两个 preset 都会被急切挂载，
  // 且共用同一份名册 → agentPresets.register() 的全局唯一 id 会撞车。撞车只说明
  // "preset 已由另一行建好"，本模式必须仍持有自己的 subagent_<id> 工具。
  const roster = normalizeRoster(defaultRoster());
  const preRegistered = roster.map((specialist) => specialistPresetId(specialist));
  const { ctx, record } = makeCtx({
    settings: makeSettings({ specialists: defaultRoster() }),
    preRegisteredPresets: preRegistered,
  });
  apply(ctx);
  await flush();

  assert.deepEqual(record.presets, [], '不应重复注册 preset');
  assert.deepEqual(
    record.tools.map((tool) => tool.name).sort(),
    roster.map((specialist) => specialistToolName(specialist.id)).sort(),
  );
});

test('名册变化时重建专家工具', async () => {
  const { ctx, record, settings } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  await flush();
  assert.equal(record.tools.length, 6);

  settings.update([{ id: 'tester', provider: '', model: '', description: '负责测试' }]);
  await flush();
  assert.deepEqual(record.tools.map((tool) => tool.name), ['subagent_tester']);
  assert.equal(record.presets.length, 1);
});

// ---------------------------------------------------------------- 门禁 ---

test('项目经理自己调用执行类工具被拒绝（复用 lib/guard.js）', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);

  for (const toolName of DEFAULT_BLOCKED_TOOLS) {
    const { next, calls } = spyNext();
    const decision = await listener({ name: toolName, agent: LEAD }, next);
    assert.equal(decision?.kind, 'deny', `${toolName} 应被拒绝`);
    assert.ok(decision.reason.includes(toolName), `拒因要点名 ${toolName}`);
    assert.ok(decision.reason.includes('专家') || decision.reason.includes('派'), '拒因要给出派工指引');
    assert.equal(calls.count, 0, '拒绝时不该调用 next');
  }
});

test('子代理写文件必须放行（否则专家干不了活）', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  for (const toolName of DEFAULT_BLOCKED_TOOLS) {
    const { next, calls } = spyNext();
    const decision = await listener({ name: toolName, agent: TEAMMATE }, next);
    assert.deepEqual(decision, { kind: 'allow' });
    assert.equal(calls.count, 1);
  }
});

test('放行只读工具与派发工具（门禁不能拦死管理工作）', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  for (const toolName of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question', 'spawn_teammate', 'send_message', 'team_task_list', 'list_agents']) {
    const { next, calls } = spyNext();
    const decision = await listener({ name: toolName, agent: LEAD }, next);
    assert.deepEqual(decision, { kind: 'allow' }, `${toolName} 应当放行`);
    assert.equal(calls.count, 1);
  }
});

test('超长 wait_agent 被等待门禁确定性拒绝；短等待与读状态工具放行', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);

  const denied = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 600_000 } }, spyNext().next);
  assert.equal(denied?.kind, 'deny');
  assert.ok(denied.reason.includes('120000'), denied.reason);
  assert.ok(denied.reason.includes('短等待'), denied.reason);

  const allowed = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 60_000 } }, spyNext().next);
  assert.deepEqual(allowed, { kind: 'allow' });

  for (const toolName of ['list_agents', 'team_task_list', 'send_message']) {
    const decision = await listener({ name: toolName, agent: LEAD, arguments: { timeout_ms: 1_800_000 } }, spyNext().next);
    assert.deepEqual(decision, { kind: 'allow' }, `${toolName} 不该被等待门禁拦`);
  }
});

test('maxWaitMs = 0 时等待门禁关闭（读取配置服务实时生效）', async () => {
  const { ctx, record, settings } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  settings.setOptions({ maxWaitMs: 0 });
  const decision = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 1_800_000 } }, spyNext().next);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('门禁自己出错时放行，而不是让工具调用失败', async () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  const hostile = {
    get session() {
      throw new Error('boom');
    },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: hostile }, next);
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(calls.count, 1);
});

// ---------------------------------------------------------------- 打包 ---

test('package.json 暴露两个新出口并把新文件打进 files', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./project-manager'], './project-manager.js');
  assert.equal(pkg.exports['./workflow'], './workflow.js');
  for (const file of ['project-manager.js', 'workflow.js']) {
    assert.ok(pkg.files.includes(file), `files 缺 ${file}`);
  }
  // 版本号由发布流程统一升，测试不硬编码它 —— 只确认它是个版本字符串。
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
});
