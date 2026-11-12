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
  ASYNC_RULES,
  COMMANDER_PROTOCOL,
  ESCALATION_TRIGGERS,
  FLOW_STEPS,
  SKILL_NAME,
  TASK_SHAPE_RULES,
  TICKET_RULES,
  TICKET_RULES_OPTIONAL,
  TEAM_BOARD_RULES,
  VERIFICATION_RULES,
  WORKER_RULES,
  renderCommanderSection,
  renderModeOpening,
  renderSpecialistRoster,
} from '../lib/protocol.js';
import { PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID } from '../lib/tickets.js';
import {
  HIERARCHY_LEVELS,
  TEAM_MODEL,
  TEAM_MODEL_BRIEF,
  TEAM_MODEL_RULES,
} from '../lib/team-model.js';
import { PIPELINE_SPECIALISTS, PIPELINE_STAGES, leaderNameForSpecialist } from '../lib/workflow.js';

/** `TEAM_MODEL` 拼进 H1 文档时降一级标题（与 lib/protocol.js 同一约定）。 */
const TEAM_MODEL_AS_SECTION = TEAM_MODEL.replace(/^# /u, '## ');

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
  // 3.1.0：`wait_agent` 只以"被禁用"的身份出现，不能被当成可用通道。
  assert.ok(SECTION.includes('`wait_agent` 硬禁用'), SECTION);
  // 没有 Team 工具时的降级路径也要写，否则残缺部署会卡死。
  assert.ok(SECTION.includes('workflow'));
});

test('紧凑版包含输出契约', () => {
  assert.ok(SECTION.includes('输出契约'));
  assert.ok(SECTION.includes('正文'));
});

test('七个上报触发条件都在长文里，且规划那条是硬门禁', () => {
  // 3.0.0 新增第 4 条「小组长上报歧义」：歧义的发现者是小组长（L1），但汇总与提问
  // 必须由指挥官做（team-model.js 的 ambiguity-chain 规则）——不加上报链路，小组长会
  // 各自去问用户，同一件事被问好几遍。
  assert.equal(ESCALATION_TRIGGERS.length, 7);
  assert.deepEqual(
    ESCALATION_TRIGGERS.map((trigger) => trigger.id),
    ['plan', 'conflict', 'ambiguity', 'leader-ambiguity', 'tradeoff', 'risk', 'blocker'],
  );
  assert.equal(ESCALATION_TRIGGERS[0].id, 'plan');
  assert.ok(ESCALATION_TRIGGERS[0].detail.includes('必须'));
  const leaderAmbiguity = ESCALATION_TRIGGERS.find((trigger) => trigger.id === 'leader-ambiguity');
  assert.ok(leaderAmbiguity, '缺少「小组长上报歧义」这条触发条件');
  // 歧义链路的三个要点：只报指挥官、指挥官汇总后一次性问、答复回给小组长。
  for (const phrase of ['只报给你', '一次性', '小组长']) {
    assert.ok(leaderAmbiguity.detail.includes(phrase), `歧义链路缺少：${phrase}`);
  }
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
  // 3.0.0：非法值回退 16（与 schema / 运行时并行上限一致），不再是 2.x 的 4。
  // ⚠️ 旧断言 `includes('4 个')` 在 3.0.0 里仍会**意外通过**——"给 2-4 个**具体**选项"
  // 这句问法要求里就含 "4 个" 子串。所以这里按整句钉死渲染结果，而不是松散的 includes。
  assert.ok(
    renderCommanderSection({ maxTeammates: Number.NaN }).includes('并行子代理建议不超过 16 个'),
    '非法 maxTeammates 应回退 16（与运行时并行上限一致）',
  );
  assert.ok(!renderCommanderSection({ maxTeammates: Number.NaN }).includes('并行子代理建议不超过 4 个'));
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
  // 3.1.0：`wait_agent` 只以"被禁用"的身份出现（不是可用通道）。
  assert.ok(ROSTER_SECTION.includes('`wait_agent` 硬禁用'), ROSTER_SECTION);
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

test('3.5.0：通道选择给出「小组长什么时候交下级」的判据（不是只有"可以"）', () => {
  // 用户 2026-11-12 指出：协议只写了"小组长可以自己执行，也可以交下级"，
  // 没有判据，于是它既可能把该自己干的活塞给一次性子智能体，也可能反过来什么都自己干。
  // 判据必须落在协议里（模型看不到 README）。
  for (const phrase of ['单点', '产出明确', '前台等一会就能拿到结果', 'workflow', '多阶段', '要持续对话', '要中途纠偏', '任务板进度']) {
    assert.ok(ROSTER_SECTION.includes(phrase), `通道判据缺少：${phrase}`);
  }
  // 判据的方向必须写死：单点 → 一次性子智能体；多阶段 / 要持续对话 → 自己执行。
  assert.match(ROSTER_SECTION, /单点[^。\n]*→[^。\n]*subagent_<id>/u, ROSTER_SECTION);
  assert.match(ROSTER_SECTION, /多阶段[^。\n]*→[^。\n]*自己执行/u, ROSTER_SECTION);
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

// ---------------------------------------------------------------- 结算同步 ---

test('紧凑版把「结算同步」写成每轮都在的硬要求', () => {
  // 2026-11-02 的事故：任务板一直在动，计划清单停在 +61 分钟，直到用户亲口问"同步更新任务"。
  // 所以"结算 → 三同步"必须是 section 的一部分，而不是 skill 里的一句建议。
  const section = renderCommanderSection({ syncBoard: true });
  assert.ok(section.includes('结算同步'), section);
  assert.ok(section.includes('三同步'), section);
});

test('结算同步的四条都在：三同步 / 看板权威 / 收尾三查 / 里程碑就同步', () => {
  const section = renderCommanderSection({ syncBoard: true });
  for (const phrase of ['每次结算都做三同步', '看板是权威', '收尾三查', '里程碑就同步']) {
    assert.ok(section.includes(phrase), `结算同步缺少：${phrase}`);
  }
  // 三同步必须点名三样：任务板、计划清单、团队状态。
  for (const phrase of ['team_task_update', 'todo_write', '团队状态']) {
    assert.ok(section.includes(phrase), `三同步缺少：${phrase}`);
  }
  // 收尾三查要给出可判定的三个条件。
  assert.ok(section.includes('pending'), '收尾三查要提到未结算状态');
});

test('没有看板的部署里，看板那条换成"看一次，不要轮询"', () => {
  const without = renderCommanderSection({ syncBoard: false });
  // 不点名"看板已给出状态"（这个部署里没有），但仍要求用一次 list_agents。
  assert.ok(without.includes('没有实时看板可用时'), without);
  assert.ok(without.includes('list_agents'), without);
  assert.ok(without.includes('不要轮询'), without);
  // 有看板时才写"看板是权威"。
  assert.ok(!without.includes('看板是权威'), '没有看板时不能声称看板是权威');
  assert.ok(renderCommanderSection({ syncBoard: true }).includes('看板是权威'));
});
test('a2a 效率的四条都写进紧凑版', () => {
  const section = renderCommanderSection();
  // 3.1.0：第 3 条从「超时不是事件」改成「禁止等待：不等、不挂起、不停摆」——
  // 用户 2026-11-11 补充要求「禁止等待子智能体、不设开关」，等待从"短等"变成"完全禁止"。
  for (const phrase of ['派活一次写全', '先约定回报协议', '禁止等待', '回执即成功']) {
    assert.ok(section.includes(phrase), `a2a 效率缺少：${phrase}`);
  }
  // 必须给出可执行的动作，而不是抽象要求。
  for (const phrase of ['连续跑到完成', 'list_agents', 'team_task_list', 'send_message']) {
    assert.ok(section.includes(phrase), `a2a 效率缺少事实：${phrase}`);
  }
  // 禁止等待的替代动作也要在场：读状态 + 完成通知 + 结束回合。
  for (const phrase of ['硬禁用', '无开关', '【派工完成】', '结束回合']) {
    assert.ok(section.includes(phrase), `禁止等待缺少替代动作：${phrase}`);
  }
  // 3.2.0：范围扩到整条链（用户追加「不要等」），section 里也要写明。
  assert.ok(section.includes('整条链生效'), section);
});

test('长文给出结算同步与 a2a 效率的完整说明（含事故与数字）', () => {
  // 3.1.0：a2a 第 3 条已从「超时不是事件」改成「禁止等待（硬禁用、无开关）」。
  for (const phrase of ['结算同步', '三同步', '看板是权威', '收尾三查', 'a2a 效率', '禁止等待', '回执即成功']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少：${phrase}`);
  }
  // 事故数字是这条纪律的依据，别在改文案时丢掉。
  assert.ok(COMMANDER_PROTOCOL.includes('1111'), '长文应写明事故规模');
  assert.ok(COMMANDER_PROTOCOL.includes('5 次'), '长文应写明 todo_write 只调了 5 次');
  // 3.1.0：长文里的等待纪律必须是"禁止 + 没有开关"，不能残留"短等待/上限"。
  assert.ok(COMMANDER_PROTOCOL.includes('没有开关'), '长文要说明没有开关');
  assert.ok(!COMMANDER_PROTOCOL.includes('短等待'), '长文不应再教"短等待"');
  assert.ok(!COMMANDER_PROTOCOL.includes('maxWaitMs'), '长文不应再提 maxWaitMs');
  // 3.2.0：用户追加「不要等」→ 长文要写明**整条链**都不许等，并要求派活时转达给小组长。
  for (const phrase of ['整条链生效', '整条指挥链', '小组长也一样', '不要等下级']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少整条链口径：${phrase}`);
  }
});

test('标准流程的监控/收尾步与同步语义一致，且不再教轮询', () => {
  assert.ok(FLOW_STEPS[4].detail.includes('同步看板'), FLOW_STEPS[4].detail);
  assert.ok(FLOW_STEPS[4].detail.includes('别轮询'), FLOW_STEPS[4].detail);
  assert.ok(FLOW_STEPS[5].detail.includes('三查'), FLOW_STEPS[5].detail);
});

// ---------------------------------------------------------------- Team 优先 ---

test('两条通道都在时，紧凑版给出「通道配比：Team 优先，specialist 只做单点」', () => {
  // 0.5.0 依据：session-7064696b 里 Team 通道在重启后被彻底放弃（后 300 个事件 0 次），
  // 任务板留下 6 项没收尾。所以通道选择必须是 section 的一部分，而不是只在 skill 长文里。
  assert.ok(ROSTER_SECTION.includes('通道配比：Team 优先'), ROSTER_SECTION);
  for (const phrase of ['按任务形状选通道', '建板必有主', '复用同一个 teammate', '重启后先看团队', '静默结束']) {
    assert.ok(ROSTER_SECTION.includes(phrase), `Team 优先缺少：${phrase}`);
  }
  // 必须点名"多阶段/长任务走 Team"，否则 specialist 还是会被当万能通道。
  assert.ok(ROSTER_SECTION.includes('多阶段'), ROSTER_SECTION);
  assert.ok(ROSTER_SECTION.includes('spawn_teammate'), ROSTER_SECTION);
});

test('没有专职子代理工具时不提「通道配比」（没有选择，就不制造选择）', () => {
  const teamOnly = renderCommanderSection({ specialists: [], hasSpecialistTools: false });
  assert.ok(!teamOnly.includes('通道配比'), teamOnly);
  // 但标准流程仍然要求"建板必须有主"。
  assert.ok(teamOnly.includes('建板必有主') || teamOnly.includes('建了板就必须有 owner'), teamOnly);
});

test('长文给出通道配比的完整论证（含会话数字与三种翻车点）', () => {
  for (const phrase of ['通道配比：Team 优先', '建板必有主', '重启后先看团队', '静默结束先查产物', 'session-7064696b']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少：${phrase}`);
  }
  // 事故规模：118 次 Team 调用 → 0 次。
  assert.ok(COMMANDER_PROTOCOL.includes('118'), '长文应写明前期的 Team 调用次数');
  assert.ok(COMMANDER_PROTOCOL.includes('task-3'), '长文应点名从未被认领的孤儿任务');
});

test('长文写明一次性 specialist 的三条硬约束（无任务板/无后台通知/每次新 child）', () => {
  for (const phrase of ['没有任务板', '没有后台通知', '每次调用都是新 child']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少：${phrase}`);
  }
});

// ------------------------------------------------ 3.0.0 三层指挥链协议 ---

test('3.0.0：section 含团队模型小节与三层指挥链的关键口径', () => {
  // 用户 2026-11-11 的五条规则落在 section 里的部分：三层、深度 2、并行 16、
  // 「只有小组长能改进展与排期」、一团队一任务。
  assert.ok(SECTION.includes('### 团队模型：指挥官 → 小组长 → 子智能体'), SECTION);
  for (const phrase of ['小组长', '子智能体', '深度 2', '16', '只有小组长', '一个团队一个任务']) {
    assert.ok(SECTION.includes(phrase), `section 缺少 3.0.0 口径：${phrase}`);
  }
  // 紧凑版逐条来自 TEAM_MODEL_BRIEF（唯一正文来源），不是各写一份。
  for (const line of TEAM_MODEL_BRIEF) {
    assert.ok(SECTION.includes(line), `section 缺少 TEAM_MODEL_BRIEF 行：${line.slice(0, 40)}`);
  }
  // 空名册时只有 Team 一条通道，且它建的是**小组长**（不是 2.x 的"子代理"）。
  assert.ok(SECTION.includes('派活只用**智能体团队**'), SECTION);
  assert.ok(SECTION.includes('`spawn_teammate` 建**小组长**'), SECTION);
  // 一次性子智能体通道的"只有小组长用"标注在名册非空时出现（见下一条用例）；
  // 空名册时 section 连 `subagent_` 都不能出现（0.2 起的硬约束）。
  assert.ok(!SECTION.includes('subagent_'), '空名册 section 不应出现 subagent_ 工具名');
});

test('3.0.0：指挥官协议长文含 TEAM_MODEL 正文（唯一正文来源，不另抄一份）', () => {
  // 团队模型的正文只有 lib/team-model.js 一份；协议只拼接（H1 降 H2）。
  // 这条钉住"两份抄写必然漂移"那个约束：如果哪天有人把正文改成手写副本，这里会失败。
  assert.ok(COMMANDER_PROTOCOL.includes(TEAM_MODEL_AS_SECTION), '长文必须原样拼接 TEAM_MODEL（只降标题层级）');
  for (const rule of TEAM_MODEL_RULES) {
    assert.ok(COMMANDER_PROTOCOL.includes(rule.title), `长文缺少团队模型规则：${rule.title}`);
  }
  for (const level of HIERARCHY_LEVELS) {
    assert.ok(COMMANDER_PROTOCOL.includes(`L${level.level} ${level.name}`), `长文缺少层级 L${level.level}`);
  }
});

test('3.0.0：指挥官协议含持续接单、歧义链路与「只有小组长」的写入权', () => {
  // 规则 1（持续接单）与规则 4（只有小组长改进度/排期）必须都在长文里：
  // 它们是用户明确提出的行为要求，只写在门禁错误信息里不够——模型得先知道该做什么。
  for (const phrase of [
    '持续接单',
    '不要推翻已有排期',
    '排期变化',
    '小组长发现需求描述不清',
    '一次性',
    '只有小组长能改任务进展与排期',
    '`claim` / `release` / `complete` / `reopen` / `set_dependencies`',
  ]) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少 3.0.0 语义：${phrase}`);
  }
  // 结算同步的"任务板"一项改成「核对 / 催 owner 结算」，不再教指挥官自己 complete。
  assert.ok(COMMANDER_PROTOCOL.includes('不要自己 `team_task_update`'), COMMANDER_PROTOCOL.slice(0, 100));
  assert.ok(COMMANDER_PROTOCOL.includes('让 owner（小组长）结算') || COMMANDER_PROTOCOL.includes('让 owner 结算'));
});

test('3.0.0：协议不再给指挥官"直接前台调用 subagent_<id>"的指令', () => {
  // 这是 3.0.0 的破坏性变更：`subagent_<id>` / `subagent` / `subagent_fork` 是**小组长**
  // 的通道，指挥官调用会被 `evaluateSpecialistDispatch()` 拒绝。协议里若还留着直调指令，
  // 模型会照着做，然后每一轮都被门禁打回。
  //
  // 注意：不能笼统断言"不出现 subagent_"——协议需要提到这些工具来说明"它们属于小组长、
  // 你不调用"。所以这里只钉**直调指令**的具体措辞（2.x 里的原话）。
  const forbidden = [
    '直接**前台调用** `subagent_<id>`',
    '直接用对应的 `subagent_<id>`',
    '通道 A（专职子代理）',
    '把这一步派给对应的 specialist',
    '前台调用 `subagent_<id>`，结果直接返回',
  ];
  for (const phrase of forbidden) {
    assert.ok(!COMMANDER_PROTOCOL.includes(phrase), `长文仍含直调指令：${phrase}`);
    assert.ok(!SECTION.includes(phrase), `section 仍含直调指令：${phrase}`);
  }
  // 正面的替代口径必须在场：一次性子智能体工具属于小组长、指挥官不直接调用。
  assert.ok(COMMANDER_PROTOCOL.includes('你**不直接调用**') || COMMANDER_PROTOCOL.includes('你不直接调用'));
  assert.ok(COMMANDER_PROTOCOL.includes('属于小组长'));
});

test('3.5.0：长文「通道 A」定义里写明小组长交下级的判据', () => {
  // 与 section 里的判据同一口径，长文补细节：什么算"单点任务"、什么情况它应当自己执行。
  for (const phrase of ['单点任务', '产出明确', '前台等一会就能拿到', '不需要持续对话', '不需要中途纠偏', '任务板进度', '自己执行']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文通道 A 判据缺少：${phrase}`);
  }
  // 一次性子智能体的三个硬约束必须在判据旁边出现（否则"交下级"看起来没有代价）。
  for (const phrase of ['没有任务板', '没有后台通知', '新 child']) {
    assert.ok(COMMANDER_PROTOCOL.includes(phrase), `长文缺少一次性子智能体约束：${phrase}`);
  }
});

test('3.0.0：名册启用时通道 A 明确标注「只有小组长用」且不属于指挥官', () => {
  // 名册非空时 section 会出现 `subagent_<id>`，所以必须同时写清"这条通道不属于你"，
  // 否则模型会把它当成自己的通道（2.x 就是这样，3.0.0 用门禁兜住但文本也要对齐）。
  assert.ok(ROSTER_SECTION.includes('只有小组长用'), ROSTER_SECTION);
  assert.ok(ROSTER_SECTION.includes('这条通道**不属于你**'), ROSTER_SECTION);
  assert.ok(ROSTER_SECTION.includes('你调用会被门禁拒绝'), ROSTER_SECTION);
  // 通道 B 是"你的唯一通道"。
  assert.ok(ROSTER_SECTION.includes('你的唯一通道'), ROSTER_SECTION);
});

// ------------------------------------- 3.4.0 无智能体团队的协议降级 ---
//
// 交叉审计发现的同类死锁：`evaluateSpecialistDispatch()` 假设"指挥官总能用 Team 通道"，
// 而协议固定规则里也一直写 `spawn_teammate`。在没有 Agent Teams 的部署里，一次性子智能体
// 是唯一出路（门禁已同步降级放行），协议必须改口，否则模型会去找不存在的工具。

/** 3.4.0：没有 Team 工具时的名册。 */
const NO_TEAM_SPECIALISTS = Object.freeze([
  Object.freeze({ id: 'architect', provider: 'deepseek', model: 'deepseek-reasoner', description: '系统架构与取舍' }),
  Object.freeze({ id: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-4', description: '独立审查与回归验证' }),
]);

test('3.4.0 降级：hasTeamTools:false + 名册 → 通道段改口为「一次性子智能体是唯一通道」', () => {
  const text = renderCommanderSection({ hasTeamTools: false, specialists: NO_TEAM_SPECIALISTS, hasSpecialistTools: true });
  // 明确告诉模型这个部署没有 Team，且小组长这一层建不起来。
  assert.ok(text.includes('本部署**没有**智能体团队'), text.slice(0, 400));
  assert.ok(text.includes('小组长这一层无法建立'), text);
  assert.ok(text.includes('**唯一**的派活通道'), text);
  // 名册里的具体工具必须点名（那是它真正能用的通道）。
  for (const specialist of NO_TEAM_SPECIALISTS) {
    assert.ok(text.includes(`subagent_${specialist.id}`), `降级段应点名 subagent_${specialist.id}`);
  }
  // 不能再出现 Team 前提的通道标题（否则模型会以为通道 A 属于它）。
  assert.ok(!text.includes('通道 A：一次性子智能体工具'), '不应出现 Team 前提的通道 A 标题');
  assert.ok(!text.includes('只有小组长用'), '不应说"只有小组长用"（本部署没有小组长）');
  // 也不应给"没有通道"的逃生段（有一次性子智能体，不算没路）。
  assert.ok(!text.includes('没有可用的派活通道'), text);
});

test('3.4.0 降级：hasTeamTools:false + 无名册 → 逃生段「没有可用的派活通道」', () => {
  const text = renderCommanderSection({ hasTeamTools: false, specialists: [], hasSpecialistTools: false });
  assert.ok(text.includes('本部署没有可用的派活通道'), text);
  assert.ok(text.includes('请用户决定'), text);
  // 逃生段可以泛指 `subagent_<id>`（提醒"连它也没有"），但绝不能点名具体工具名。
  assert.ok(!text.includes('subagent_architect'), text);
  assert.ok(!text.includes('subagent_reviewer'), text);
});

test('3.4.0 降级：section 顶部有显式覆盖段（Team 工具都不存在）', () => {
  for (const text of [
    renderCommanderSection({ hasTeamTools: false, specialists: NO_TEAM_SPECIALISTS, hasSpecialistTools: true }),
    renderCommanderSection({ hasTeamTools: false, specialists: [], hasSpecialistTools: false }),
  ]) {
    assert.ok(text.includes('本部署没有智能体团队'), text.slice(0, 600));
    assert.ok(text.includes('都不存在'), '覆盖段要明确那些工具不存在');
    assert.ok(text.includes('降级说明'), '要指向「派发通道」的降级说明');
    // 覆盖段必须出现在固定规则之前（先说明前提，再让模型读下文）。
    assert.ok(
      text.indexOf('本部署没有智能体团队') < text.indexOf('### 绝对边界'),
      '覆盖段应在「绝对边界」之前',
    );
  }
});

test('3.4.0 降级：renderModeOpening 的「现在做什么」不再教 spawn_teammate', () => {
  const opening = renderModeOpening({ hasTeamTools: false, specialists: NO_TEAM_SPECIALISTS, hasSpecialistTools: true });
  const tail = opening.slice(opening.indexOf('### 现在做什么'));
  assert.ok(tail.includes('一次性子智能体'), tail);
  assert.ok(tail.includes('小组长这一层建不起来'), tail);
  assert.ok(!tail.includes('spawn_teammate'), `「现在做什么」不应再教 spawn_teammate：${tail}`);
  // 连一次性子智能体都没有时，收尾句干脆不提通道（只要求先规划 + 让用户确认）。
  const bare = renderModeOpening({ hasTeamTools: false, specialists: [], hasSpecialistTools: false });
  const bareTail = bare.slice(bare.indexOf('### 现在做什么'));
  assert.ok(!bareTail.includes('spawn_teammate'), bareTail);
  assert.ok(!bareTail.includes('subagent_<id>'), bareTail);
});

test('3.4.0 默认回归：不传 hasTeamTools 与 hasTeamTools:true 等价，且无覆盖段', () => {
  assert.equal(renderCommanderSection(), renderCommanderSection({ hasTeamTools: true }));
  assert.equal(renderModeOpening(), renderModeOpening({ hasTeamTools: true }));
  // 默认形态（有 Team）里不应出现降级覆盖段。
  assert.ok(!SECTION.includes('本部署没有智能体团队'), SECTION.slice(0, 400));
  assert.ok(!SECTION.includes('本部署**没有**智能体团队'));
  // 名册启用时默认仍走"两条通道、你只走通道 B"的正常形态。
  assert.ok(ROSTER_SECTION.includes('只有小组长用'));
  assert.ok(ROSTER_SECTION.includes('你的唯一通道'));
});

// ---------------------------------------------------------------- 长度与兼容 ---

test('紧凑版长度受控：每轮注入，必须短于长文', () => {
  // 预算随纪律增长调整过两次：
  // - 2.3.0 新增第 6 条「先对齐位置与能力边界」，它是"用缺失否定用户"那类事故的唯一防线；
  // - 3.1.0 把 a2a 第 3 条从「超时不是事件」改成「禁止等待（硬禁用、无开关）」，并给全三条
  //   替代动作（读状态 / 追问 / 汇报后结束回合）——这是用户 2026-11-11 的硬要求，属于
  //   "不做就会当场跑偏"的动作级规则，必须留在 section 里，不能只搬进长文。
  //   实测：默认 8313 字符 / 124 行，启用名册 9554 字符 / 152 行，开场 8467 / 130。
  // 上限的作用是防"把细节都塞进 section"，不是精确配额：超了就说明该搬到长文了。
  // 5.0.0：合并「项目经理模式」后新增两节（按任务形状拆 + 验收与收口），
  // 实测默认 9983 / 名册 11308 / 开场 10137 字符 —— 预算提到 12000。
  const CHAR_BUDGET = 12_000;
  for (const [label, text] of [
    ['默认 section', SECTION],
    ['启用名册 section', ROSTER_SECTION],
    ['开场', OPENING],
  ]) {
    const lines = text.split('\n').length;
    assert.ok(lines <= 180, `${label} 有 ${lines} 行，超过 180 行上限`);
    assert.ok(text.length <= CHAR_BUDGET, `${label} 有 ${text.length} 字符，超过 ${CHAR_BUDGET} 字符上限`);
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

// ---------------------------------------------------------------- 0.6.0 工单 ---

test('0.6.0 / 5.0.0：默认 section 带「按需工单」契约（不再强制每次派活建单）', () => {
  assert.ok(SECTION.includes('### 工单与计划授权（0.6.0，确定性门禁）'), SECTION);
  // 默认（requireMandate / requireTicket 都关）→ 渲染 TICKET_RULES_OPTIONAL。
  for (const rule of TICKET_RULES_OPTIONAL) {
    assert.ok(SECTION.includes(rule.title), `section 缺少按需工单规则：${rule.title}`);
  }
  assert.ok(SECTION.includes('工单账本是可选工具'), '要写明工单是按需的');
  assert.ok(SECTION.includes('commander_ticket_create'), '工具名仍要在场（它存在，只是不强制）');
  // 默认不该出现"每次派发都带工单"的强制口径。
  assert.ok(!SECTION.includes('每次派发都带工单'), '默认不应强制每单工单');
  assert.ok(!SECTION.includes('先建工单再派活'), '默认不应强制先建工单');
});

test('0.6.0：严格流程（requireMandate / requireTicket 打开）→ 渲染强制工单规则', () => {
  // 5.0.0：合并后默认按需；显式打开严格流程时协议必须回到旧口径，否则门禁与文本打架。
  for (const options of [{ requireMandate: true }, { requireTicket: true }, { requireMandate: true, requireTicket: true }]) {
    const text = renderCommanderSection(options);
    for (const rule of TICKET_RULES) {
      assert.ok(text.includes(rule.title), `${JSON.stringify(options)} 缺少强制规则：${rule.title}`);
    }
    for (const phrase of [PLAN_QUESTION_ID, PLAN_CONFIRM_LABEL, '[ticket:t-N]']) {
      assert.ok(text.includes(phrase), `${JSON.stringify(options)} 缺少：${phrase}`);
    }
    assert.ok(!text.includes('工单账本是可选工具'), `${JSON.stringify(options)} 不应再写"可选"`);
  }
});

test('0.6.0：ledger:false 时不出现工单契约或工单工具名', () => {
  const text = renderCommanderSection({ ledger: false });
  assert.ok(!text.includes('工单与计划授权'), '关闭账本后不应出现工单契约');
  assert.ok(!text.includes('commander_ticket_'), '关闭账本后不应点名工单工具');
  // 其余协议保持不变。
  assert.ok(text.includes('绝对边界'));
});

test('0.6.0：工单规则不提到具体 specialist 工具名（空名册也安全）', () => {
  // 与 0.2 的教训一致：协议里点名一个当前不存在的工具，模型会当场卡住。
  for (const rules of [TICKET_RULES, TICKET_RULES_OPTIONAL]) {
    const joined = rules.map((rule) => `${rule.title}${rule.detail}`).join('');
    assert.ok(!/subagent_/u.test(joined), '工单规则不应出现 subagent_ 工具名');
    assert.ok(!/specialist/iu.test(joined), '工单规则不应出现 specialist');
  }
});

// ------------------------------------------------ 5.0.0 合并：按形状拆 / 验收 ---

test('5.0.0：section 说明「项目经理模式」已并入，专家团与工作流按需', () => {
  assert.ok(SECTION.includes('「项目经理模式」已并入本模式'), '要写明合并');
  assert.ok(SECTION.includes('project-dev-workflow'), '要给出按需加载工作流的 skill 名');
  assert.ok(SECTION.includes('按需'), '要写明专家团与工作流是按需的');
});

test('5.0.0：section 带「按任务形状拆工作」（六段是可选项，不套模板）', () => {
  assert.ok(SECTION.includes('### 按任务形状拆工作'), SECTION);
  for (const rule of TASK_SHAPE_RULES) {
    assert.ok(SECTION.includes(rule.title), `section 缺少拆解规则：${rule.title}`);
  }
  for (const phrase of ['不要按"六段"套模板', '不为了走流程制造依赖', '推荐顺序，不是门禁']) {
    assert.ok(SECTION.includes(phrase), `section 缺少：${phrase}`);
  }
  // 典型形状要举例，否则模型仍会套模板。
  for (const phrase of ['打安装包', '交接', '单点缺陷', '排障', '从零开发']) {
    assert.ok(SECTION.includes(phrase), `section 缺少任务形状示例：${phrase}`);
  }
  // 硬要求仍在。
  for (const phrase of ['可观察的验收判据', '落盘证据', '独立于实现者']) {
    assert.ok(SECTION.includes(phrase), `section 缺少硬要求：${phrase}`);
  }
});

test('5.0.0：section 带「验收与收口」（每任务三件事 + 验收门禁）', () => {
  assert.ok(SECTION.includes('### 验收与收口'), SECTION);
  for (const rule of VERIFICATION_RULES) {
    assert.ok(SECTION.includes(rule.title), `section 缺少验收规则：${rule.title}`);
  }
  for (const phrase of ['未提交视为该任务未完成', '任务板结算由 owner 小组长做', '验收门禁', '亲自核对证据', '经验教训']) {
    assert.ok(SECTION.includes(phrase), `section 缺少：${phrase}`);
  }
});

test('5.0.0：六位专家与六段工作流仍然在场（可选，但名册要对得上）', () => {
  for (const specialist of PIPELINE_SPECIALISTS) {
    assert.ok(SECTION.includes(specialist.id), `section 缺专家 id：${specialist.id}`);
    assert.ok(SECTION.includes(leaderNameForSpecialist(specialist.id)), `section 缺小组长建议名：${specialist.lead}`);
  }
  for (const stage of PIPELINE_STAGES) {
    assert.ok(SECTION.includes(stage), `section 缺六段阶段名：${stage}`);
  }
});

test('0.7.0：默认 section 带异步派工契约（完成通知唤醒、不要轮询）', () => {
  assert.ok(SECTION.includes('### 异步派工（0.7.0：完成通知会唤醒你）'), SECTION);
  // 3.1.0：原来的「不要 `wait_agent`」措辞升级成「不要等（wait_agent 硬禁用、无开关）」——
  // 等待从"不推荐"变成"确定性拒绝"。
  for (const phrase of ['派活即返回', '完成通知会自己回来', '【指挥者·派工完成】', '不要等**（`wait_agent` 硬禁用、无开关）', '在飞任务不重派']) {
    assert.ok(SECTION.includes(phrase), `section 缺少：${phrase}`);
  }
});

test('0.7.0：asyncDelegation:false 时不出现异步契约', () => {
  const text = renderCommanderSection({ asyncDelegation: false });
  assert.ok(!text.includes('异步派工'));
  assert.ok(!text.includes('【指挥者·派工完成】'));
  // 同步语义仍在（specialist 是前台阻塞）。
  assert.ok(text.includes('绝对边界'));
});

test('0.7.0：异步规则不提到具体 specialist 工具名（空名册也安全）', () => {
  const joined = ASYNC_RULES.map((rule) => `${rule.title}${rule.detail}`).join('');
  assert.ok(!/subagent_/u.test(joined), '异步规则不应出现 subagent_ 工具名');
  assert.ok(!/specialist/iu.test(joined), '异步规则不应出现 specialist（配置键也不行）');
});

test('0.8.0：Worker Session 规则不传 options 时不出现，workerSessions:true 才出现', () => {
  assert.ok(!SECTION.includes('Worker Session（0.8.0'), '未传 options 时不应出现 Worker 契约');
  const text = renderCommanderSection({ workerSessions: true });
  assert.ok(text.includes('### Worker Session（0.8.0：每工单独立 Session + 目录）'), text);
  for (const phrase of ['长任务用 Worker Session', '一工单一 Worker', 'Worker 汇报仍要验收', 'commander_worker_spawn']) {
    assert.ok(text.includes(phrase), `Worker 契约缺少：${phrase}`);
  }
  for (const rule of WORKER_RULES) assert.ok(text.includes(rule.title), rule.title);
  const joined = WORKER_RULES.map((rule) => `${rule.title}${rule.detail}`).join('');
  assert.ok(!/specialist/iu.test(joined), 'Worker 规则不应出现 specialist');
});

// ------------------------------------------------ 共享任务板投影（1.2.0） ---

test('1.2.0：teamBoard 缺省不渲染投影小节（1.1.x 文本不变）', () => {
  assert.ok(!SECTION.includes('共享任务板是工单的投影'), '缺省不应出现投影小节');
  assert.ok(!OPENING.includes('[task:task-N]'), '缺省不应点名 [task:task-N]');
});

test('1.2.0：teamBoard:true 时给出投影小节与 Team 通道写法', () => {
  const text = renderCommanderSection({ teamBoard: true });
  assert.ok(text.includes('### 共享任务板是工单的投影（1.2.0）'), text);
  for (const phrase of [
    '不要重复创建',
    '投影',
    '[task:task-N]',
    'team_task_update',
    'commander_ticket_update',
    '真实工单状态',
  ]) {
    assert.ok(text.includes(phrase), `投影小节缺少：${phrase}`);
  }
  // 三条规则都要在（标题逐条出现）。
  for (const rule of TEAM_BOARD_RULES) assert.ok(text.includes(rule.title), rule.title);
});

test('1.2.0：renderModeOpening 透传 teamBoard', () => {
  const opening = renderModeOpening({ teamBoard: true });
  assert.ok(opening.includes('### 共享任务板是工单的投影（1.2.0）'), opening);
});
