/**
 * 协议文本的测试。
 *
 * 用户对这个模式提了两条硬要求，它们必须**在每一次提示词组装里**都出现：
 *
 * 1. 指挥者自己不执行操作，全部安排给子代理；
 * 2. 规划/拆分完成后要用选择工具让用户确认；出现分歧或不确定也要交回用户。
 *
 * 0.2 又加了第三条：「多模型 specialist 名册」——名册里每一项是一个独立的
 * `subagent_<id>` 工具（前台调用、绑定自己的 provider/model/职责），Team 工具继续保留。
 * 于是协议要同时覆盖两条通道，还要把可靠性纪律（什么才算"返回"）写死在每轮注入的
 * section 里。
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
  renderSpecialistRoster,
} from '../lib/protocol.js';

const SECTION = renderCommanderSection();
const OPENING = renderModeOpening();

/** 一个两人民册：不同 provider/model，覆盖"每个工具绑定自己的模型"。 */
const SPECIALISTS = Object.freeze([
  Object.freeze({ id: 'architect', provider: 'deepseek', model: 'deepseek-reasoner', description: '系统架构与取舍' }),
  Object.freeze({ id: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-4', description: '独立审查与回归验证' }),
]);

const ROSTER = renderSpecialistRoster({ specialists: SPECIALISTS });
const ROSTER_SECTION = renderCommanderSection({ specialists: SPECIALISTS, hasSpecialistTools: true });

// ---------------------------------------------------------------- 原有硬要求 ---

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

// ---------------------------------------------------------------- 名册为空 ---

test('名册为空时，紧凑版绝不提到专职子代理通道', () => {
  // 名册为空却在 section 里出现 `subagent_<id>` 或 specialist，模型就会去调用
  // 不存在的工具，连试几次把轮次烧光。
  const variants = [
    SECTION,
    renderCommanderSection({}),
    renderCommanderSection({ specialists: [], hasSpecialistTools: false }),
    renderCommanderSection({ specialists: [], hasSpecialistTools: true }),
    renderCommanderSection({ specialists: undefined }),
    renderCommanderSection({ specialists: 'not-an-array' }),
  ];
  for (const text of variants) {
    assert.ok(!text.includes('subagent_'), '空名册不应出现 subagent_ 工具名');
    assert.ok(!/specialist/i.test(text), '空名册不应出现 specialist');
  }
  // 仍然完整地走 Team 通道。
  assert.ok(SECTION.includes('spawn_teammate'));
  assert.ok(SECTION.includes('派活只用**智能体团队**'));
});

test('renderSpecialistRoster 空名册与非数组输入返回空串', () => {
  assert.equal(renderSpecialistRoster(), '');
  assert.equal(renderSpecialistRoster(null), '');
  assert.equal(renderSpecialistRoster({}), '');
  assert.equal(renderSpecialistRoster({ specialists: [] }), '');
  assert.equal(renderSpecialistRoster({ specialists: null }), '');
  assert.equal(renderSpecialistRoster({ specialists: 'nope' }), '');
  assert.equal(renderSpecialistRoster({ specialists: [null, 'x', {}, { id: '' }] }), '');
});

// ---------------------------------------------------------------- 名册渲染 ---

test('renderSpecialistRoster 逐个列出工具名、职责、模型', () => {
  for (const specialist of SPECIALISTS) {
    assert.ok(ROSTER.includes(`subagent_${specialist.id}`), `缺少工具名 subagent_${specialist.id}`);
    assert.ok(ROSTER.includes(specialist.description), `缺少职责：${specialist.description}`);
    assert.ok(
      ROSTER.includes(`${specialist.provider}/${specialist.model}`),
      `缺少模型：${specialist.provider}/${specialist.model}`,
    );
  }
  // 一行一个，工具名带反引号（可直接复制成调用名）。
  assert.ok(ROSTER.includes('- `subagent_architect`'));
});

test('renderSpecialistRoster 对异常名册宽容：跳过空 id 与重复 id', () => {
  const roster = renderSpecialistRoster({
    specialists: [
      { id: '' },
      { id: '   ' },
      { id: 'dup', description: '第一次出现' },
      { id: 'dup', description: '重复项' },
    ],
  });
  assert.ok(roster.includes('- `subagent_dup`'));
  assert.ok(roster.includes('第一次出现'));
  // 重复 id 会渲染出两个同名工具，只保留第一次。
  assert.ok(!roster.includes('重复项'));
  assert.equal((roster.match(/subagent_dup/g) ?? []).length, 1);
});

test('renderSpecialistRoster 在缺模型/缺职责时给出可读回退', () => {
  const roster = renderSpecialistRoster({ specialists: [{ id: 'solo' }] });
  assert.ok(roster.includes('`subagent_solo`'));
  assert.ok(roster.includes('默认模型'));
  assert.ok(roster.includes('未写职责'));
});

// ---------------------------------------------------------------- 名册启用 ---

test('名册非空时 section 列出每个工具、职责与模型', () => {
  for (const specialist of SPECIALISTS) {
    assert.ok(ROSTER_SECTION.includes(`subagent_${specialist.id}`));
    assert.ok(ROSTER_SECTION.includes(specialist.description));
    assert.ok(ROSTER_SECTION.includes(`${specialist.provider}/${specialist.model}`));
  }
  // 旧语义一条都不能少：边界、规划确认、分歧上报、输出契约。
  assert.ok(ROSTER_SECTION.includes('你不写文件、不改文件、不跑命令'));
  assert.ok(ROSTER_SECTION.includes('规划或拆分完成'));
  assert.ok(ROSTER_SECTION.includes('子代理之间有分歧'));
  assert.ok(ROSTER_SECTION.includes('输出契约'));
  // Team 通道同时保留。
  for (const tool of ['spawn_teammate', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'team_task_']) {
    assert.ok(ROSTER_SECTION.includes(tool), `启用名册后仍要保留 ${tool}`);
  }
});

test('双通道选择规则一眼可懂：独立模型走 A，长驻队友走 B，可混用', () => {
  assert.ok(ROSTER_SECTION.includes('通道 A'));
  assert.ok(ROSTER_SECTION.includes('通道 B'));
  assert.ok(ROSTER_SECTION.includes('独立模型'));
  assert.ok(ROSTER_SECTION.includes('前台调用'));
  assert.ok(ROSTER_SECTION.includes('结果直接返回'));
  assert.ok(ROSTER_SECTION.includes('长期存在的具名队友'));
  assert.ok(ROSTER_SECTION.includes('共享任务板'));
  assert.ok(ROSTER_SECTION.includes('后台并行'));
  assert.ok(ROSTER_SECTION.includes('混用'));
  // 写作用域重叠的硬要求不能因为多一条通道就松掉。
  assert.ok(ROSTER_SECTION.includes('同一批文件不要同时交给两条通道'));
});

test('名册是可复用工具，不是任务数上限，也不许造活', () => {
  for (const phrase of ['不是任务数上限', 'runtime 容量', '一个新的 child', '造活', '空着']) {
    assert.ok(ROSTER_SECTION.includes(phrase), `名册语义缺少：${phrase}`);
  }
});

test('派活前必须做定位匹配，差距大就开新的子智能体（而不是硬派）', () => {
  // 用户明确要求：分发任务要考虑子智能体的定位；任务与定位差距大就开新子智能体。
  // 这条规则落在三处：紧凑版 section（每轮注入）、skill 长文（细节 + 例子）、
  // 以及 specialist 工具描述 / 人设（执行者自己也会拒绝错配任务）。
  for (const phrase of ['定位匹配', '固定定位', '差距大', '不要硬派', '开一个新的子智能体']) {
    assert.ok(ROSTER_SECTION.includes(phrase), `紧凑版缺少定位匹配规则：${phrase}`);
  }
  // 新开的子智能体要把定位写进它的 description 与 prompt —— 否则它仍用默认人设。
  assert.ok(ROSTER_SECTION.includes('写进它的 description 与 prompt'));
  // 判断口径必须给出，否则"差距大"没有可执行标准。
  assert.ok(ROSTER_SECTION.includes('顺带多做一点同领域的小事'));
  assert.ok(ROSTER_SECTION.includes('这是另一类工作'));

  // 同一任务里混着两种定位的工作 → 拆开派，而不是塞给一个人。
  assert.ok(ROSTER_SECTION.includes('拆成两个任务分别派'));
});

test('长文给出定位匹配的判断步骤、开新子智能体的做法与常见错配', () => {
  for (const phrase of [
    '派活前必须做定位匹配',
    '开一个新的子智能体',
    'spawn_teammate',
    '依赖漏洞扫描',
    '常见的错配',
    '自查',
    '它的定位',
  ]) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少定位匹配细节：${phrase}`);
  }
  // 长文要明确"通道 A 不能改名册"——所以开新子智能体走通道 B，或建议用户加进名册。
  assert.ok(COMMANDER_PROTOCOL.includes('不能改名册'));
  assert.ok(COMMANDER_PROTOCOL.includes('建议用户把它加进名册'));
});

test('空名册时也要求派活前做定位匹配（Team 通道同样适用）', () => {
  // 名册为空时没有 specialist，但 teammate 也有定位（description / prompt），
  // 所以"任务与定位差距大就开新的 teammate"这条在默认形态下也必须出现。
  const empty = renderCommanderSection();
  assert.ok(empty.includes('定位匹配'));
  assert.ok(empty.includes('开一个新的 teammate'));
  assert.ok(empty.includes('不要把任务硬塞给定位不符的旧成员'));
});

test('未声明 hasSpecialistTools 时按名册非空推断（容错，供旧调用方）', () => {
  // index.js 会显式传 hasSpecialistTools；漏传时按"名册非空即启用"处理，
  // 这样协议不会因为一个可选字段而丢掉整条通道。
  const inferred = renderCommanderSection({ specialists: SPECIALISTS });
  assert.ok(inferred.includes('subagent_architect'));
  assert.equal(inferred, ROSTER_SECTION);
});

test('名册非空但工具没挂载时降级，不点名不存在的具体工具', () => {
  const degraded = renderCommanderSection({ specialists: SPECIALISTS, hasSpecialistTools: false });
  assert.ok(degraded.includes('没有挂载'));
  assert.ok(degraded.includes('不要调用不存在的工具'));
  // 泛指的 `subagent_<id>` 可以出现（提醒别去调），但具体工具名不能给。
  assert.ok(!degraded.includes('subagent_architect'));
  assert.ok(degraded.includes('spawn_teammate'));
});

test('开场在名册启用时补一句选通道，默认开场不提专职通道', () => {
  const rosterOpening = renderModeOpening({ specialists: SPECIALISTS, hasSpecialistTools: true });
  assert.ok(rosterOpening.startsWith(ROSTER_SECTION));
  assert.ok(rosterOpening.includes('subagent_'));
  assert.ok(!OPENING.includes('subagent_'));
  assert.ok(!/specialist/i.test(OPENING));
});

// ---------------------------------------------------------------- 角色与可靠性 ---

test('角色分工：主 agent 拥有结果，执行者拥有实现', () => {
  for (const phrase of ['产品负责人', '验收标准', '集成', '最终验收', '非简单工作先定验收标准', '过度微拆', '最合适']) {
    assert.ok(SECTION.includes(phrase), `角色分工缺少：${phrase}`);
  }
  // 长文也要有同一套角色口径。
  for (const phrase of ['产品负责人', '项目经理', '拥有结果', '开发执行']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文角色分工缺少：${phrase}`);
  }
});

test('可靠性纪律：状态、结算、证据、中断、改道、收尾门禁都在紧凑版里', () => {
  const phrases = [
    // 状态按字面读
    '`running`',
    '`inactive`',
    '都不表示完成',
    '前台调用返回',
    'settlement notice',
    // 不要空转轮询
    '不要为了消磨时间反复',
    // 卡死证据清单
    '卡死只认具体证据',
    '耗时、沉默',
    // interrupt 纪律
    'interrupt 纪律',
    '已接受',
    '被中断或失败的 child 的任务仍未完成',
    // 连续两次错误改道
    '连续两次',
    // 收尾门禁
    '不得在必需 child 仍在跑',
    // 一个 child 一个内聚任务
    '一个 child 只背一个内聚任务',
    '复用同一个 child',
  ];
  for (const phrase of phrases) {
    assert.ok(SECTION.includes(phrase), `可靠性语义缺少：${phrase}`);
  }
});

test('可靠性语义同样写进长文，并给出"为什么"', () => {
  for (const phrase of ['settlement notice', '耗时、沉默', '已接受', '连续两次', '收尾门禁', '为什么：']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文可靠性缺少：${phrase}`);
  }
});

test('标准流程的派发/监控/收尾步与新语义一致', () => {
  // 派发步指向"派发通道"这一节，而不是写死某一条通道。
  assert.ok(FLOW_STEPS[3].detail.includes('派发通道'));
  assert.ok(FLOW_STEPS[3].detail.includes('最合适'));
  // 监控步写明状态不等于结果。
  assert.ok(FLOW_STEPS[4].detail.includes('settlement notice'));
  assert.ok(FLOW_STEPS[4].detail.includes('状态不等于结果'));
  // 收尾步受收尾门禁约束。
  assert.ok(FLOW_STEPS[5].detail.includes('必需 child 未结算'));
});

// ---------------------------------------------------------------- 长度与兼容 ---

test('紧凑版长度受控：每轮注入，必须短于长文', () => {
  for (const [label, text] of [
    ['默认 section', SECTION],
    ['启用名册 section', ROSTER_SECTION],
    ['开场', OPENING],
  ]) {
    const lines = text.split('\n').length;
    assert.ok(lines <= 160, `${label} 有 ${lines} 行，超过 160 行上限`);
    assert.ok(text.length <= 9000, `${label} 有 ${text.length} 字符，超过 9000 字符上限`);
  }
  // 细节应该在 skill 长文里，而不是把 section 撑大。
  assert.ok(COMMANDER_PROTOCOL.length > SECTION.length);
});

test('renderCommanderSection 向后兼容：不传 options 与传空对象等价', () => {
  assert.equal(renderCommanderSection(), renderCommanderSection({}));
  // 旧选项的效果不变。
  assert.ok(!renderCommanderSection({ confirmPlan: false }).includes('规划或拆分完成'));
  assert.ok(renderCommanderSection({ confirmPlan: false }).includes('子代理之间有分歧'));
  assert.ok(!renderCommanderSection({ escalateOnConflict: false }).includes('子代理之间有分歧'));
  // 名册字段不传时，旧的 Team 通道与写作用域要求完整保留。
  assert.ok(SECTION.includes('workflow'));
  assert.ok(SECTION.includes('写作用域'));
});
