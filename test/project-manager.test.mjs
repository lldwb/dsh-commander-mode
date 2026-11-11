/**
 * 「项目经理模式」的测试：协议文本 + 模式行接线（section / skill / 六位专家 / 门禁）。
 *
 * 这一组要证明三件事：
 *
 * 1. **协议真的把六段流水线与五条纪律写进去了** —— 用户 2026-11-09 提的四条要求
 *    （六位专家、禁止等待、不要人日、git 分类提交 + 经验教训）都能在文本里逐条查到。
 * 2. **模式行真的挂上了** —— section 名字与 order、六位专家工具、skill 注册。
 * 3. **门禁是确定性的** —— 项目经理本人写文件被拒（子代理必须放行），`wait_agent`
 *    被**硬禁用**（3.1.0，无开关）；没有这些，模式退化成"只会写协议"。
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
  leaderNameForSpecialist,
} from '../lib/project-manager.js';
import { TEAM_MODEL } from '../lib/team-model.js';
import { DEFAULT_BLOCKED_TOOLS } from '../lib/guard.js';
import { DEFAULT_SPECIALISTS } from '../lib/presets.js';
import { normalizeRoster, specialistPresetId, specialistToolName } from '../lib/specialists.js';
import { LEAD, SUBAGENT, TEAMMATE, defaultRoster, deferred, flush, listenerOf, makeCtx, makeSettings, spyNext } from './helpers.mjs';

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

test('协议写明禁止等待：硬禁用 + 无开关 + 依赖派工完成通知', () => {
  // 3.1.0（用户 2026-11-11 补充要求）：**禁止等待子智能体，且不设开关**。
  // 2.0.0 的「短等待 + maxWaitMs 上限」措辞已全部下线，协议改成硬禁用口径。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('wait_agent'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('禁止等待'), '要写明「禁止等待」');
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('硬禁用'), '要写明是硬禁用');
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('无开关') || PROJECT_MANAGER_PROTOCOL.includes('没有开关'), '要写明没有开关');
  // 3.2.0：整条链生效（用户追加「不要等」）——协议要写明范围与"派活时要求小组长也不许等"。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('整条链生效'), '要写明整条链生效');
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('整条链都不等'), '要写明整条链都不等');
  assert.ok(
    PROJECT_MANAGER_PROTOCOL.includes('派活时明确要求小组长也不许等'),
    '要要求派活时把"不许等"写进小组长 prompt',
  );
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('【派工完成】'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('list_agents'), '要给出读状态这条替代动作');
  // 旧的"短等待 / 上限可配"措辞不得残留（否则模型会以为还能调）。
  assert.ok(!PROJECT_MANAGER_PROTOCOL.includes('maxWaitMs'), '协议不应再提 maxWaitMs');
  assert.ok(!PROJECT_MANAGER_PROTOCOL.includes('短等待'), '协议不应再教"短等待"');
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

// ------------------------------------------------ 3.0.0 三层指挥链 ---

test('3.0.0：协议原样拼接 TEAM_MODEL 正文（团队模型唯一正文来源）', () => {
  // 规则 5：项目经理模式 = 指挥官模式特化版。团队模型的正文**只有一份**
  // （lib/team-model.js 的 TEAM_MODEL），项目经理协议只拼接它（H1 降 H2），
  // 不再自己抄一份——两份抄写必然漂移，而漂移的后果是同一套门禁在不同模式下
  // 给出互相矛盾的指令。
  const asSection = TEAM_MODEL.replace(/^# /u, '## ');
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes(asSection), '项目经理协议必须原样拼接 TEAM_MODEL（只降标题层级）');
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('## 团队模型：指挥官 → 小组长 → 子智能体'));
  // 用户 2026-11-11 的关键口径都要在场：三层、深度 2、并行 16、只有小组长改写入权。
  for (const phrase of ['小组长', '子智能体', '深度 2', '16', '只有小组长', '一个团队一个任务', '持续接单']) {
    assert.ok(PROJECT_MANAGER_PROTOCOL.includes(phrase), `项目经理协议缺少团队模型口径：${phrase}`);
  }
  // 六段流水线仍在（特化版 = 团队模型 + 六段流水线）。
  for (const stage of PIPELINE_STAGES) {
    assert.ok(PROJECT_MANAGER_PROTOCOL.includes(stage), `协议缺流水线阶段：${stage}`);
  }
});

test('3.0.0：六位专家是「专家小组长」，名字逐个点名', () => {
  // 规则 5：六位专家（架构/实现/审查/测试/安全/文档）改成**专家小组长**（团队模型 L1）。
  // 名字写进协议是有用的：模型 `spawn_teammate` 时用它当 name，任务板与通知里才认得出是谁。
  assert.equal(PIPELINE_SPECIALISTS.length, 6);
  for (const specialist of PIPELINE_SPECIALISTS) {
    const lead = leaderNameForSpecialist(specialist.id);
    assert.equal(lead, specialist.lead, `${specialist.id} 的小组长名字应稳定为 ${specialist.lead}`);
    assert.ok(PROJECT_MANAGER_PROTOCOL.includes(lead), `协议缺点名专家小组长 ${lead}`);
  }
  assert.deepEqual(
    PIPELINE_SPECIALISTS.map((entry) => leaderNameForSpecialist(entry.id)),
    ['architect-lead', 'implementer-lead', 'reviewer-lead', 'tester-lead', 'security-lead', 'doc-writer-lead'],
  );
  // 不在六位预置专家里的自定义名册项，按 `<id>-lead` 生成可读名字。
  assert.equal(leaderNameForSpecialist('data-engineer'), 'data-engineer-lead');
  // 派单通道是 spawn_teammate + send_message（规则 3：任务下发给小组长）。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('`spawn_teammate` 建一位**专家小组长**'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('`send_message` 把该段任务发给它'));
});

test('3.0.0：协议不再指示项目经理直接调 subagent_<id>（工具仍安装，给小组长用）', () => {
  // 这是 3.0.0 的破坏性变更：项目经理（Lead）直接调 `subagent_<id>` 会被
  // `evaluateSpecialistDispatch()` 确定性拒绝。协议里若还留着直调指令，模型会照着做，
  // 然后每一轮都被门禁打回。
  //
  // 不能笼统断言"不出现 subagent_"——协议需要点名这些工具来说明"它们属于小组长"。
  // 所以钉的是 2.x 里**直调指令**的具体形态：
  // ① 段标题的括号里直接是 `subagent_<id>`（2.x 的执行者身份）；
  // ② "一次性前台工具 … 通知唤醒你"（把项目经理当调用者）；
  // ③ "打回 `subagent_<id>`"（把项目经理当派单人）。
  assert.ok(
    !/^### 第 \d+ 段：.*（`subagent_/mu.test(PROJECT_MANAGER_PROTOCOL),
    '段标题不应再直接把 subagent_<id> 写成执行者',
  );
  for (const phrase of ['一次性前台工具 `subagent_', '通知唤醒你', '打回 `subagent_']) {
    assert.ok(!PROJECT_MANAGER_PROTOCOL.includes(phrase), `协议仍含直调指令：${phrase}`);
  }
  // 正面的替代口径必须在场：这些工具给小组长用、项目经理不直接调用。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('这些工具是给小组长用的'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('你不直接调用'));
  // 异步结算通知的收件人是**小组长**（不是项目经理）：它是小组长派下级子智能体的回执。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('唤醒的是**小组长**'));
  // 任务板写入权：项目经理只 reassign / 读板，claim/complete 由小组长做。
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('`reassign`'));
  assert.ok(PROJECT_MANAGER_PROTOCOL.includes('进度与排期写入由小组长做'));
});

// ---------------------------------------------------------------- 接线 ---

test('导出名与 section 契约正确（不与指挥者模式的 commander:mode 撞名）', () => {
  assert.equal(pluginName, 'project-manager-agent');
  assert.equal(SECTION_NAME, 'project-manager:mode');
  assert.notEqual(SECTION_NAME, 'commander:mode');
  assert.equal(SECTION_ORDER, 650);
  // 3.1.0：等待上限配置已删除（禁止等待、不设开关），默认选项里不应再有 maxWaitMs。
  assert.equal('maxWaitMs' in FALLBACK_OPTIONS, false, '默认选项不应再有 maxWaitMs');
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

test('3.4.0 降级：没有智能体团队时给 PM 协议追加覆盖段（改用一次性子智能体）', () => {
  // 交叉审计发现：PM 协议里"派单只有一条通道：spawn_teammate"在没有 Agent Teams 的
  // 部署里指向不存在的工具；而门禁已按"没有 Team 通道"降级放行一次性子智能体。
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const section = record.sections[0];
  /** 一个带工具视图的 agent（`schemas()` 返回给定工具名）。 */
  const agentWith = (names) => ({
    id: 'session-lead',
    session: { id: 'session-lead', header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => names.map((name) => ({ name })) } },
  });

  const noTeam = section.text({ agent: agentWith(['read', 'write', 'subagent_architect', 'subagent_implementer']) });
  assert.ok(noTeam.includes('本部署没有智能体团队'), noTeam.slice(-600));
  assert.ok(noTeam.includes('改用一次性子智能体派每段任务'), noTeam.slice(-600));
  assert.ok(noTeam.includes('subagent_architect'), '覆盖段要点名一次性专家工具');
  assert.ok(noTeam.includes('不要自己写业务代码'), '降级后仍要守住"不自己写代码"');
  // 原协议正文仍完整保留（覆盖段是追加，不是替换）。
  assert.ok(noTeam.includes(PROJECT_MANAGER_PROTOCOL), '原协议正文必须原样保留');

  // 有 Team 工具（或读不到视图）→ 不追加覆盖段，行为与 3.3.x 一致。
  const withTeam = section.text({ agent: agentWith(['read', 'spawn_teammate', 'send_message']) });
  assert.equal(withTeam, PROJECT_MANAGER_PROTOCOL);
  assert.equal(section.text({ agent: LEAD }), PROJECT_MANAGER_PROTOCOL, 'LEAD 没有工具视图 → 按"有 Team"处理');
});

test('注册 project-manager skill', () => {  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
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

test('禁止等待：项目经理调 wait_agent 一律被拒；读状态工具放行', async () => {
  // 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**。
  // 2.0.0 的"超长才拒 + 短等待放行"已整体下线：现在缺省参数、60 秒、30 分钟都一样拒。
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);

  for (const args of [undefined, {}, { timeout_ms: 60_000 }, { timeout_ms: 600_000 }, { timeout_ms: 1_800_000 }]) {
    const denied = await listener({ name: 'wait_agent', agent: LEAD, arguments: args }, spyNext().next);
    assert.equal(denied?.kind, 'deny', `args=${JSON.stringify(args)} 时 wait_agent 应被拒绝`);
    assert.ok(denied.reason.includes('硬禁用'), denied.reason);
    // 3.2.0：拒因要写明整条链都不许等（用户追加的「不要等」）。
    assert.ok(denied.reason.includes('整条链都不许等'), denied.reason);
    assert.ok(denied.reason.includes('完成通知'), denied.reason);
  }

  // 只拦 wait_agent：被拒之后该用的正是这些工具。
  for (const toolName of ['list_agents', 'team_task_list', 'send_message', 'interrupt_agent']) {
    const decision = await listener({ name: toolName, agent: LEAD, arguments: { timeout_ms: 1_800_000 } }, spyNext().next);
    assert.deepEqual(decision, { kind: 'allow' }, `${toolName} 不该被禁止等待门禁拦`);
  }
});

test('3.1.0 禁止等待：没有开关（配置服务里塞旧 maxWaitMs / 关掉层级门禁都不改变判定）', async () => {
  // 旧用例「maxWaitMs = 0 时等待门禁关闭」的**反向**断言：现在不存在能关掉它的配置。
  const { ctx, record, settings } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  // 模拟旧 profile patch 仍写着这些键（包括旧的 maxWaitMs:0）——门禁不读配置，照样拒。
  settings.setOptions({ maxWaitMs: 0, delegationHierarchy: false, blockedTools: [] });
  const decision = await listener({ name: 'wait_agent', agent: LEAD, arguments: { timeout_ms: 1_800_000 } }, spyNext().next);
  assert.equal(decision?.kind, 'deny', '没有任何配置能放开 wait_agent');
  assert.ok(decision.reason.includes('没有开关'), decision.reason);
});

test('3.2.0 整条链：专家小组长 / 子智能体调 wait_agent 也被拒（不再只拦项目经理）', async () => {
  // 3.1.0 曾放行 teammate（专家小组长等它派出的 L2）；用户明确「不要等」后，
  // 3.2.0 删掉了 `isDelegatedAgent` 放行 —— 整条链都不许等。语义反转是刻意的，
  // **不要**因为"子代理干不了活"就恢复放行（等待不是完成工作所必需的动作）。
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  const listener = preExecute(record);
  for (const [label, agent] of [['teammate（专家小组长）', TEAMMATE], ['subagent（L2）', SUBAGENT], ['身份读不到', undefined]]) {
    for (const args of [undefined, { timeout_ms: 1_800_000 }]) {
      const decision = await listener({ name: 'wait_agent', agent, arguments: args }, spyNext().next);
      assert.equal(decision?.kind, 'deny', `${label} 的 wait_agent 也必须被拒（整条链生效）`);
      assert.ok(decision.reason.includes('整条链都不许等'), decision.reason);
    }
  }
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
