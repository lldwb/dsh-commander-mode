/**
 * 协议文本的测试。
 *
 * 用户对这个模式提了两条硬要求，它们必须**在每一次提示词组装里**都出现：
 *
 * 1. 指挥者自己不执行操作，全部安排给子代理；
 * 2. 规划/拆分完成后要用选择工具让用户确认；出现分歧或不确定也要交回用户。
 *
 * 这些断言把"要求"钉成"文本里真的有"，这样以后改协议时不会悄悄把某一条删掉。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDER_PROTOCOL,
  ESCALATION_TRIGGERS,
  FLOW_STEPS,
  SKILL_NAME,
  renderCommanderSection,
  renderModeOpening,
} from '../lib/protocol.js';

const SECTION = renderCommanderSection();
const OPENING = renderModeOpening();

test('紧凑版点明身份与绝对边界', () => {
  assert.ok(SECTION.includes('指挥者'));
  assert.ok(SECTION.includes('你不写文件、不改文件、不跑命令'));
  assert.ok(SECTION.includes('派给子代理'));
  // 只读侦察是被允许的，否则指挥者没法分析任务。
  assert.ok(SECTION.includes('只读侦察'));
  // 边界是强制的，模型不该浪费轮次去试。
  assert.ok(SECTION.includes('会被直接拒绝'));
});

test('紧凑版把两次"必须问用户"都写进去了', () => {
  assert.ok(SECTION.includes('ask_user_question'));
  assert.ok(SECTION.includes('什么时候必须问用户'));
  // 规划确认
  assert.ok(SECTION.includes('规划或拆分完成'));
  // 分歧上报
  assert.ok(SECTION.includes('子代理之间有分歧'));
});

test('紧凑版点名智能体团队的派发通道', () => {
  for (const tool of ['spawn_teammate', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'team_task_']) {
    assert.ok(SECTION.includes(tool), `紧凑版应当点名 ${tool}`);
  }
  // 没有 Team 工具时的降级路径也要写，否则残缺部署会卡死。
  assert.ok(SECTION.includes('workflow'));
});

test('紧凑版包含输出契约', () => {
  assert.ok(SECTION.includes('输出契约'));
  assert.ok(SECTION.includes('正文'));
});

test('六个上报触发条件都在长文里，且规划那条是硬门禁', () => {
  assert.equal(ESCALATION_TRIGGERS.length, 6);
  assert.equal(ESCALATION_TRIGGERS[0].id, 'plan');
  assert.ok(ESCALATION_TRIGGERS[0].detail.includes('必须'));
  for (const trigger of ESCALATION_TRIGGERS) {
    assert.ok(COMMANDER_PROTOCOL.includes(trigger.title), `长文缺少触发条件：${trigger.title}`);
  }
});

test('标准流程六步都在，且确认步排在派发步之前', () => {
  assert.equal(FLOW_STEPS.length, 6);
  const ids = FLOW_STEPS.map((step) => step.id);
  assert.deepEqual(ids, ['recon', 'plan', 'confirm', 'dispatch', 'monitor', 'report']);
  // 顺序是语义的一部分：确认必须在派发之前。
  assert.ok(ids.indexOf('confirm') < ids.indexOf('dispatch'));
  assert.ok(FLOW_STEPS[2].detail.includes('确认之前不许派活'));
});

test('confirmPlan: false 时去掉规划确认这条触发条件', () => {
  const relaxed = renderCommanderSection({ confirmPlan: false });
  assert.ok(!relaxed.includes('规划或拆分完成'));
  // 但分歧上报不受影响。
  assert.ok(relaxed.includes('子代理之间有分歧'));
});

test('escalateOnConflict: false 时去掉分歧上报这条触发条件', () => {
  const relaxed = renderCommanderSection({ escalateOnConflict: false });
  assert.ok(!relaxed.includes('子代理之间有分歧'));
  assert.ok(relaxed.includes('规划或拆分完成'));
});

test('maxTeammates 会写进协议', () => {
  assert.ok(renderCommanderSection({ maxTeammates: 7 }).includes('7 个'));
  // 非法值回退到 4。
  assert.ok(renderCommanderSection({ maxTeammates: Number.NaN }).includes('4 个'));
});

test('长文覆盖 Team 工具的语义细节', () => {
  for (const phrase of ['accepted', 'queued', '绝不能重发', 'inactive', 'blocked_by', '写作用域不重叠']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文应写清 ${phrase}`);
  }
});

test('长文给出降级路径，而不是假定工具一定在', () => {
  assert.ok(COMMANDER_PROTOCOL.includes('如果这个部署里没有这些工具'));
  assert.ok(COMMANDER_PROTOCOL.includes('workflow'));
});

test('开场文本在紧凑版之上加了"现在做什么"', () => {
  assert.ok(OPENING.startsWith(SECTION));
  assert.ok(OPENING.includes('现在做什么'));
  assert.ok(OPENING.includes('不要 spawn 子代理'));
});

test('skill 名是 kebab-case', () => {
  // DSH 的 skill 名有语法要求；中文名或大写都会在注册时炸。
  assert.match(SKILL_NAME, /^[a-z][a-z0-9-]*$/u);
  assert.equal(SKILL_NAME, 'commander-mode');
});

test('协议里不出现"你自己动手也行"这类松口话', () => {
  for (const text of [SECTION, COMMANDER_PROTOCOL]) {
    assert.ok(!text.includes('可以自己直接改'));
    assert.ok(!text.includes('如果任务简单就自己做'));
  }
});
