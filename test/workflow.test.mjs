/**
 * 「项目开发工作流」组件的测试：可选执行手册的正文 + 按需 skill 接线。
 *
 * 3.6.0 起这个组件**只注册 skill**（不再注入常驻 prompt section），因为 3.5.0 及以前
 * 的"常驻 section + 六段必须走完"把发版打包、交接这类任务也逼成六段串行
 * （真实会话 session-137678b5）。测试要钉住四件事：
 *
 * 1. 六段齐全、顺序固定（作为**推荐顺序**），每段都写清目的 / 必做动作 / 落盘产物 /
 *    验收判据 / 失败返工 / 对应专家与团队用法；
 * 2. 本包 `skills/` 目录里 20 个方法 skill 全部出现在"该在哪个阶段用"的索引里；
 * 3. 「可选、按需、可只取一段」与「skill 是工作方法，不替代验收证据」这两条边界在场；
 * 4. 不出现人日 / 人天 / 人月 / 工期这类被用户明确否掉的表述。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SKILL_NAME, apply, name as pluginName } from '../workflow.js';
import { WORKFLOW_PROTOCOL, WORKFLOW_SKILLS, WORKFLOW_STAGES } from '../lib/workflow.js';
import { leaderNameForSpecialist } from '../lib/workflow.js';
import { makeCtx, makeSettings, defaultRoster } from './helpers.mjs';

/** 19 个已吸纳 skill 的期望清单（与任务书一致；改名/增删都要同步改这里与协议正文）。 */
const EXPECTED_SKILLS = [
  'file-location-alignment',
  'feature-dev',
  'bug-fix',
  'refactor',
  'code-review',
  'unit-test',
  'doc-sync',
  'code-optimize',
  'comment-supplement',
  'repo-init',
  'spec-route',
  'project-explain',
  'session-summary',
  'task-commander',
  'app-packaging',
  'i18n-transform',
  'skill-router',
  'check-rule-extract',
  'module-batch',
  'opencode-batch',
];

// ---------------------------------------------------------------- 协议文本 ---

test('协议定位：可选执行手册（不是强制流程），供指挥者与专家小组长按需加载', () => {
  assert.ok(WORKFLOW_PROTOCOL.startsWith('# 项目开发工作流'), WORKFLOW_PROTOCOL.slice(0, 120));
  // 5.0.0：不再有「项目经理模式」，手册由指挥者模式按需加载。
  assert.ok(WORKFLOW_PROTOCOL.includes('指挥者模式'));
  assert.ok(!WORKFLOW_PROTOCOL.includes('项目经理模式'), '手册不应再提已并入的项目经理模式');
  assert.match(WORKFLOW_PROTOCOL, /架构 → 实现 → 审查 → 测试 → 安全 → 文档/u);
  // 3.6.0：必须是"可选"，不能再写成硬门禁 / 必须走完。
  for (const phrase of ['可选执行手册', '不是强制流程', '不是门禁', '推荐顺序', '按需加载', '只读对应那一段']) {
    assert.ok(WORKFLOW_PROTOCOL.includes(phrase), `工作流正文缺少可选性说明：${phrase}`);
  }
  // 只禁**肯定式**的强制措辞；"不是必须走完的流水线"这类否定句是我们要的。
  for (const forbidden of ['每一段都是硬门禁', '不允许进入下一段', '必须按顺序走完', '六段必须走完']) {
    assert.ok(!WORKFLOW_PROTOCOL.includes(forbidden), `工作流正文不应再写强制措辞：${forbidden}`);
  }
  // 必须给出"什么时候不用它"，否则模型仍可能硬套。
  for (const phrase of ['什么时候值得用', '不用硬套', '发版', '交接']) {
    assert.ok(WORKFLOW_PROTOCOL.includes(phrase), `工作流正文缺少使用边界：${phrase}`);
  }
  // 不要为了顺序制造依赖（这是 session-137678b5 的直接病根）。
  assert.ok(WORKFLOW_PROTOCOL.includes('不要为了"顺序"给任务加 blocked_by 依赖'));
});

test('六段齐全、顺序固定，每段都有六件套（目的/动作/产物/判据/返工/专家用法）', () => {
  assert.deepEqual(WORKFLOW_STAGES.map((stage) => stage.stage), ['架构', '实现', '审查', '测试', '安全', '文档']);

  let previous = -1;
  for (let index = 1; index <= 6; index += 1) {
    const found = WORKFLOW_PROTOCOL.indexOf(`## 第 ${index} 段`);
    assert.ok(found >= 0, `缺第 ${index} 段`);
    assert.ok(found > previous, `第 ${index} 段的顺序不对`);
    previous = found;
  }

  for (const keyword of ['**目的**', '**必做动作**', '**必须落盘的产物**', '**验收判据**', '**失败返工规则**', '**团队用法**']) {
    const count = WORKFLOW_PROTOCOL.split(keyword).length - 1;
    assert.ok(count >= 6, `「${keyword}」只出现 ${count} 次（六段都应写明）`);
  }
});

test('每段点名专家小组长（architect-lead 等），subagent_<id> 只作为可交下级的工具出现', () => {
  // 3.0.0（规则 3 + 规则 5）：六段流水线的执行者是**专家小组长**（团队模型 L1），
  // 项目经理用 `subagent` 建它、`send_message` 派活；`subagent_<id>` 是**小组长**
  // 用来把子任务交给下级子智能体（L2）的工具，不是项目经理的直调通道。
  //
  // 2.x 的断言只检查 `subagent_<id>` 出现在该段（那在 3.0.0 里依然成立，所以旧断言会
  // 静默通过），但它**验证不到**"执行者已经变成小组长"这个破坏性变更——所以这里改成
  // 同时钉住小组长名字与"交下级"语义。
  for (const stage of WORKFLOW_STAGES) {
    const lead = leaderNameForSpecialist(stage.specialist);
    assert.ok(
      WORKFLOW_PROTOCOL.includes(lead),
      `第 ${stage.index} 段（${stage.stage}）缺点名专家小组长 ${lead}`,
    );
    // `subagent_<id>` 仍然出现在该段，但必须是"可交下级"的形态。
    assert.ok(
      WORKFLOW_PROTOCOL.includes(`subagent_${stage.specialist}`),
      `第 ${stage.index} 段（${stage.stage}）缺点名 subagent_${stage.specialist}`,
    );
    assert.ok(
      WORKFLOW_PROTOCOL.includes(`可用 \`subagent_${stage.specialist}\` 交下级`)
        || WORKFLOW_PROTOCOL.includes(`交给下级子智能体（\`subagent_${stage.specialist}\``),
      `第 ${stage.index} 段的 subagent_${stage.specialist} 必须写成"小组长交下级"的工具，而不是项目经理直调`,
    );
  }
  // 每段的标题就写明"专家小组长 <lead>"，让模型第一眼看到的是执行者身份。
  // 注意阶段名与标题里的段名不一定逐字相同（第 5 段标题写「安全审计」、WORKFLOW_STAGES
  // 里是「安全」），所以只按段号 + 小组长名字钉。
  for (const stage of WORKFLOW_STAGES) {
    assert.match(
      WORKFLOW_PROTOCOL,
      new RegExp(`^## 第 ${stage.index} 段：.*专家小组长 \`${leaderNameForSpecialist(stage.specialist)}\``, 'mu'),
      `第 ${stage.index} 段的标题应点名专家小组长`,
    );
  }
  // 小组长可以自己执行，也可以交下级——这条口径必须写在开工前那一节。
  assert.ok(WORKFLOW_PROTOCOL.includes('专家小组长可以自己执行'), WORKFLOW_PROTOCOL.slice(0, 800));
  assert.ok(WORKFLOW_PROTOCOL.includes('`subagent` 建'), '要写清专家小组长由 subagent 建');
});

test('20 个方法 skill 全部出现在阶段索引里', () => {
  assert.equal(EXPECTED_SKILLS.length, 20);
  assert.deepEqual([...WORKFLOW_SKILLS].sort(), [...EXPECTED_SKILLS].sort(), 'WORKFLOW_SKILLS 与任务书清单不一致');
  for (const skill of EXPECTED_SKILLS) {
    assert.ok(WORKFLOW_PROTOCOL.includes(`\`${skill}\``), `协议缺 skill ${skill}`);
  }
  // 索引要按阶段归位，而不是一份平铺清单。
  assert.ok(WORKFLOW_PROTOCOL.includes('19 个已吸纳 skill 的阶段索引'));
  assert.ok(WORKFLOW_PROTOCOL.includes('开工前 / 跨阶段'));
  assert.ok(WORKFLOW_PROTOCOL.includes('实现段'));
  assert.ok(WORKFLOW_PROTOCOL.includes('审查段'));
  assert.ok(WORKFLOW_PROTOCOL.includes('测试段'));
  assert.ok(WORKFLOW_PROTOCOL.includes('文档段 / 收尾'));
});

test('明确「skill 是工作方法，不替代验收证据」', () => {
  assert.ok(WORKFLOW_PROTOCOL.includes('skill 是工作方法，不替代验收证据'));
  assert.ok(WORKFLOW_PROTOCOL.includes('先 skill 后动手'));
  assert.ok(WORKFLOW_PROTOCOL.includes('skills/'));
});

test('git 分类提交与经验教训按工作纪律第 4/5 条', () => {
  assert.ok(WORKFLOW_PROTOCOL.includes('分类提交'));
  assert.ok(WORKFLOW_PROTOCOL.includes('第 4 条'));
  assert.ok(WORKFLOW_PROTOCOL.includes('第 5 条'));
  assert.ok(WORKFLOW_PROTOCOL.includes('未提交视为该段未完成'));
  assert.ok(WORKFLOW_PROTOCOL.includes('经验教训'));
});

test('不以人日 / 人天 / 人月 / 工期表述工作量', () => {
  for (const forbidden of ['人日', '人天', '人月', '工期']) {
    assert.ok(!WORKFLOW_PROTOCOL.includes(forbidden), `工作流协议不应出现「${forbidden}」`);
  }
});

// ---------------------------------------------------------------- 接线 ---

test('3.6.0：不再注册常驻 prompt section（这是"拆成按需组件"的关键）', () => {
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  assert.equal(record.sections.length, 0, '工作流组件不应再注入常驻 section');
});

test('注册 project-dev-workflow skill，且模型与用户都能调用（小组长按需加载）', () => {
  assert.equal(pluginName, 'project-dev-workflow');
  const { ctx, record } = makeCtx({ settings: makeSettings({ specialists: defaultRoster() }) });
  apply(ctx);
  assert.equal(record.skills.length, 1);
  const skill = record.skills[0];
  assert.equal(skill.name, SKILL_NAME);
  assert.equal(skill.name, 'project-dev-workflow');
  assert.equal(skill.source, 'runtime');
  assert.ok(skill.content.includes('第 6 段'));
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  // 描述与 whenToUse 必须自己说清"可选 / 按需 / 什么时候不用"。
  for (const phrase of ['可选', '按需']) {
    assert.ok(skill.description.includes(phrase), `skill 描述缺少：${phrase}`);
  }
  assert.ok(skill.whenToUse.includes('发版打包') && skill.whenToUse.includes('不需要加载它'));
});

test('没有 skills 服务的部署里不炸（只损失 skill 加载入口）', () => {
  const { ctx, record } = makeCtx({ withSkills: false });
  apply(ctx);
  assert.equal(record.skills.length, 0);
  assert.equal(record.sections.length, 0);
  assert.equal(record.warnings.length, 0, `不该刷 warning：${record.warnings.join(' | ')}`);
});
