/**
 * 「团队模型」的测试（`lib/team-model.js`，3.0.0 新增）。
 *
 * 这个模块是三层指挥链（指挥官 → 小组长 → 子智能体）的**唯一正文来源**：指挥官协议与
 * 项目经理协议都拼接它。所以它出错的后果不是"少一段文案"，而是两个模式同时按错的模型
 * 行动 —— 而门禁会按正确的规则拒绝它们，于是模型每一轮都在撞墙。
 *
 * 这里钉四类东西：
 *
 * 1. **七条规则的 id 固定**（其它模块与测试按 id 引用，改名等于破坏契约）；
 * 2. **三层层级定义**（level 0/1/2 与各自的职责边界）；
 * 3. **数字口径与运行时一致**（本 preset 的 `maxDepth: 2` / 宿主 `subagent.maxActiveSubagents`
 *    默认 8）—— 模型没法自己读运行时配置，
 *    文本里的数字一旦与配置不一致，它就会按错的容量做规划；
 * 4. **紧凑版非空且短**（它每轮注入 system prompt，空间有限）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HIERARCHY_LEVELS,
  TEAM_MODEL,
  TEAM_MODEL_BRIEF,
  TEAM_MODEL_RULES,
} from '../lib/team-model.js';

// ---------------------------------------------------------------- 七条规则 ---

test('TEAM_MODEL_RULES 恰好七条，id 固定且顺序稳定', () => {
  // id 是契约：`lib/protocol.js` / `lib/project-manager.js` / 测试都按 id 引用。
  // 顺序不是契约的一部分（正文渲染会编号），但固定顺序能让 diff 可读。
  assert.equal(TEAM_MODEL_RULES.length, 7);
  assert.deepEqual(
    TEAM_MODEL_RULES.map((rule) => rule.id),
    [
      'hierarchy',
      'runtime-limits',
      'one-team-one-task',
      'continuous-intake',
      'ambiguity-chain',
      'leader-owns-board',
      'leader-may-execute',
    ],
  );
});

test('每条规则都是 {id,title,detail,why}，且 detail / why 都非空', () => {
  // `why` 只进长文（section 每轮注入，只留可执行规则本身），但它是"改文案时别删掉依据"
  // 的锚点；`detail` 是模型真正照着做的部分，空字符串等于这条规则没写。
  for (const rule of TEAM_MODEL_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(rule.title.length > 0, `${rule.id} 缺 title`);
    assert.ok(rule.detail.length > 0, `${rule.id} 缺 detail`);
    assert.ok(rule.why.length > 0, `${rule.id} 缺 why`);
    // 第二人称 / 无 Markdown 表格（与其它 section 的排版约定一致）。
    assert.ok(!rule.detail.includes('|'), `${rule.id} 的 detail 不应含表格分隔符`);
  }
});

test('七条规则各自覆盖用户 2026-11-11 的一条要求', () => {
  const byId = new Map(TEAM_MODEL_RULES.map((rule) => [rule.id, rule]));

  // 规则 3：三层与职责；最大递归深度 2（小组长 L1、子智能体 L2、L2 不再向下派）。
  // 6.0.0：口径从「深度 2」改成运行时真实键值「本 preset 的 delegation 行设 maxDepth: 2」。
  assert.match(byId.get('hierarchy').detail, /maxDepth: 2|深度 2/u);
  assert.match(byId.get('hierarchy').detail, /L2/u);

  // 规则 2：并行上限由宿主决定（rc.2 默认 8），插件不自己压低；撞上限才排队。
  // 6.0.0：旧 Team 的 `maxMembers` 概念已移除，数字从 16 改为宿主默认 8。
  assert.match(byId.get('runtime-limits').detail, /默认 8/u);
  assert.match(byId.get('runtime-limits').detail, /maxActiveSubagents/u);
  assert.match(byId.get('runtime-limits').detail, /不自己压低/u);

  // 规则 1/3：一个团队一个小任务，大任务拆成多个团队。
  assert.match(byId.get('one-team-one-task').detail, /一个团队/u);

  // 规则 1：持续接单，不推翻已有排期，并入后一句话说明排期变化。
  assert.match(byId.get('continuous-intake').detail, /不要推翻已有排期/u);
  assert.match(byId.get('continuous-intake').detail, /排期变化/u);

  // 规则 1：歧义链路——小组长报指挥官、指挥官汇总后一次性问用户。
  assert.match(byId.get('ambiguity-chain').detail, /只报给你/u);
  assert.match(byId.get('ambiguity-chain').detail, /一次性/u);

  // 规则 4：只有小组长能改进度与排期，指挥官只建任务 / reassign / 读板。
  for (const action of ['claim', 'release', 'complete', 'reopen', 'set_dependencies']) {
    assert.ok(byId.get('leader-owns-board').detail.includes(action), `leader-owns-board 缺 ${action}`);
  }
  // "只有小组长"这个绝对口径写在 title 上，detail 写"由小组长做"与"你会被门禁拒绝"。
  assert.match(byId.get('leader-owns-board').title, /只有小组长/u);
  assert.match(byId.get('leader-owns-board').detail, /由小组长做/u);
  assert.match(byId.get('leader-owns-board').detail, /门禁确定性拒绝/u);

  // 规则 3：小组长可以自己执行，也可以交下级子智能体；指挥官不直接调用。
  assert.match(byId.get('leader-may-execute').detail, /自己执行/u);
  assert.match(byId.get('leader-may-execute').detail, /不直接调用/u);
  // 3.5.0（用户 2026-11-12）：光说"可以交下级"没有判据，模型要么把该自己干的活塞给
  // 一次性子智能体，要么什么都自己干。判据必须写在规则正文里。
  for (const phrase of ['什么时候该交下级', '单点', '产出明确', '前台等一会就能拿到结果', 'workflow', '多阶段', '要持续对话', '要中途纠偏', '任务板进度', '新 child']) {
    assert.ok(byId.get('leader-may-execute').detail.includes(phrase), `leader-may-execute 缺判据：${phrase}`);
  }
  // 方向不能写反：单点 → 一次性子智能体；多阶段 / 要持续对话 → 自己执行。
  assert.match(byId.get('leader-may-execute').detail, /单点[^。]*→[^。]*subagent_<id>/u);
  assert.match(byId.get('leader-may-execute').detail, /多阶段[^。]*→[^。]*自己执行/u);
  // 「为什么」也要说清代价：一次性子智能体每次调用都是新 child，上下文要重新交代。
  assert.match(byId.get('leader-may-execute').why, /新 child|上下文/u);
});

// ---------------------------------------------------------------- 三层 ---

test('HIERARCHY_LEVELS 三层，level 0/1/2 各自职责清晰', () => {
  assert.equal(HIERARCHY_LEVELS.length, 3);
  assert.deepEqual(HIERARCHY_LEVELS.map((entry) => entry.level), [0, 1, 2]);
  assert.deepEqual(HIERARCHY_LEVELS.map((entry) => entry.name), ['指挥官', '小组长', '子智能体']);

  const [commander, leader, specialist] = HIERARCHY_LEVELS;

  // L0：主会话（Lead）—— 目标、拆分、派单、验收、与用户沟通；**不执行**。
  assert.equal(commander.who, '主会话（Lead）');
  for (const owns of ['目标', '拆分', '派单', '验收', '与用户沟通']) {
    assert.ok(commander.owns.includes(owns), `L0 的 owns 缺 ${owns}`);
  }

  // L1：subagent 建出的具名队友 —— 一个团队任务；自己执行或交下级；进展与排期。
  assert.match(leader.who, /subagent/u);
  assert.match(leader.owns, /一个团队任务/u);
  assert.match(leader.owns, /自己执行或交下级/u);
  assert.match(leader.owns, /进展与排期/u);

  // L2：小组长派出的子代理 —— 只执行，不再向下派。
  assert.match(specialist.who, /subagent_<id>/u);
  assert.match(specialist.who, /subagent/u);
  assert.match(specialist.who, /workflow/u);
  assert.match(specialist.owns, /不再向下派/u);
});

test('HIERARCHY_LEVELS 是冻结常量（防运行时被改写）', () => {
  // 它被多个模块 import 并渲染进 prompt；被意外改写会让文本与门禁对不上。
  assert.equal(Object.isFrozen(HIERARCHY_LEVELS), true);
  assert.equal(Object.isFrozen(HIERARCHY_LEVELS[0]), true);
  assert.throws(() => {
    HIERARCHY_LEVELS[0].name = '被改过';
  }, TypeError);
});

// ---------------------------------------------------------------- 正文 ---

test('TEAM_MODEL 含三层标题、关键数字与「小组长」口径', () => {
  // 第一行是 H1 标题（拼进别的 H1 文档时由调用方降级）。
  assert.ok(TEAM_MODEL.startsWith('# 团队模型：指挥官 → 小组长 → 子智能体'), TEAM_MODEL.slice(0, 120));
  // 6.0.0：数字口径改为「本 preset 的 maxDepth: 2」+「宿主 maxActiveSubagents 默认 8」。
  for (const phrase of ['maxDepth: 2', '默认 8', '小组长', '子智能体', 'maxDepth', 'maxActiveSubagents']) {
    assert.ok(TEAM_MODEL.includes(phrase), `TEAM_MODEL 缺少：${phrase}`);
  }
  // 三层逐层渲染（L0/L1/L2 + 名字）。
  for (const level of HIERARCHY_LEVELS) {
    assert.ok(TEAM_MODEL.includes(`L${level.level} ${level.name}`), `TEAM_MODEL 缺层级 L${level.level}`);
  }
});

test('TEAM_MODEL 由 TEAM_MODEL_RULES 渲染：七条规则的标题与「为什么」都在正文里', () => {
  // 渲染而不是手抄，是为了避免"规则改了、正文没改"这种漂移。
  for (const rule of TEAM_MODEL_RULES) {
    assert.ok(TEAM_MODEL.includes(rule.title), `TEAM_MODEL 缺规则标题：${rule.title}`);
    assert.ok(TEAM_MODEL.includes(rule.why), `TEAM_MODEL 缺规则依据（why）：${rule.id}`);
  }
  // 七条规则按顺序编号成 `### 1. …` … `### 7. …`。
  for (let index = 1; index <= 7; index += 1) {
    assert.ok(TEAM_MODEL.includes(`### ${index}. `), `TEAM_MODEL 缺第 ${index} 条规则编号`);
  }
  // 无 Markdown 表格（与其它 section 的排版约定一致）。
  assert.ok(!/\|\s*:?-{3,}/u.test(TEAM_MODEL));
});

test('TEAM_MODEL 不复述 lib/discipline.js 的五条工作纪律', () => {
  // 工作纪律由 `lib/discipline.js` 提供唯一一份正文，协议末尾原样拼接。
  // 团队模型再写一份就会漂移（两份措辞不同的"团队优先"会让模型不知道听哪份）。
  assert.ok(!TEAM_MODEL.includes('工作纪律（用户 2026-11-09'), '团队模型不应复述工作纪律');
  assert.ok(!TEAM_MODEL.includes('不估人日'), '团队模型不应复述工作纪律');
});

// ---------------------------------------------------------------- 紧凑版 ---

test('TEAM_MODEL_BRIEF 非空、是短行数组，且每条都是可执行的规则', () => {
  // 它每轮注入 system prompt（section），所以必须是 3–5 行短句，而不是整篇正文。
  assert.ok(Array.isArray(TEAM_MODEL_BRIEF));
  assert.ok(TEAM_MODEL_BRIEF.length >= 3 && TEAM_MODEL_BRIEF.length <= 5, `紧凑版应有 3–5 行，实际 ${TEAM_MODEL_BRIEF.length}`);
  for (const line of TEAM_MODEL_BRIEF) {
    assert.equal(typeof line, 'string');
    assert.ok(line.startsWith('- '), `紧凑版每行应以 "- " 开头：${line}`);
    // "短"：单行不超过 200 字符（实测 5 行合计约 700 字符，是 section 的主要增量）。
    assert.ok(line.length <= 200, `紧凑版单行过长（${line.length} 字符）：${line.slice(0, 40)}`);
  }
  const joined = TEAM_MODEL_BRIEF.join('\n');
  assert.ok(joined.length <= 1000, `紧凑版合计 ${joined.length} 字符，超过 1000`);
});

test('TEAM_MODEL_BRIEF 覆盖 3.0.0 的五个动作级口径', () => {
  const joined = TEAM_MODEL_BRIEF.join('\n');
  // 6.0.0：紧凑版口径同步为「本 preset 设 maxDepth: 2」「宿主默认 8」。
  for (const phrase of ['三层指挥链', 'maxDepth: 2', '默认 8', '只有小组长', '一个团队一个任务', 'subagent']) {
    assert.ok(joined.includes(phrase), `紧凑版缺少：${phrase}`);
  }
  // 紧凑版会被拼进**默认 section**（名册可能为空），所以不能出现名册生成的
  // `subagent_<id>` 一次性专家工具名或 "specialist" —— 那会提示模型去调用一个
  // 可能不存在的工具。
  // 6.0.0：标准工具 `subagent` / `subagent_fork`（建小组长的通道）允许出现，
  // 所以不能再笼统地禁 `subagent_` 子串（`subagent_fork` 里就有）。
  assert.ok(!joined.includes('subagent_<id>'), '紧凑版不应出现 subagent_<id> 工具名');
  const rosterToolRefs = joined.match(/`subagent_(?!fork\b)[a-z][a-z0-9_-]*`/gu);
  assert.equal(rosterToolRefs, null, `紧凑版不应出现名册工具名：${rosterToolRefs}`);
  assert.ok(!/specialist/iu.test(joined), '紧凑版不应出现 specialist');
});
