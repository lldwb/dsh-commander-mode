/**
 * 指挥者的执行边界。
 *
 * ## 为什么这条边界是代码，而不是提示词
 *
 * 「指挥者不执行操作」如果只写在协议里，就是概率性的：模型偶尔会顺手改一个文件，
 * 而用户要的恰恰是"别自己动手"。这里用 DSH 自己的工具门禁把它变成确定性的：
 *
 * ```
 * tools/pre-execute  ← waterfall，返回 { kind: 'deny', reason } 即拒绝
 * ```
 *
 * 拒绝后模型收到的是 `Error: <reason>`（`isError: true`），所以这条 reason 同时是
 * **错误信息**和**纠正指令**——它必须直接告诉模型"该派给谁、怎么派"。
 *
 * ## 作用域
 *
 * 监听器注册在本插件所在的 **preset scope**。DSH 用
 * `scopeTarget(tools, exec.agent)` 分发这个事件，而带标签的监听器只接收自己作用域
 * 及其后代的事件——所以这条门禁**只对指挥者模式下的 agent 生效**，别的模式完全
 * 不受影响。
 *
 * ## 子代理必须放行（最重要的一条）
 *
 * teammate / subagent 通过 `agentPresets.composeFrom()` 加入**父会话的同一个 preset
 * scope**（见 `@deepseek-ai/dsh-subagent` 的 `applyChildComposition`），因此它们也会
 * 触发同一个监听器。如果身份判错，**子代理会被自己的父级门禁拦死**，整个模式就废了。
 *
 * 所以这里的原则是**宁可漏拦，不可拦死**：任何一处判断不出"这是 Lead"，就放行。
 *
 * @module dsh-commander-mode/lib/guard
 */

/**
 * 默认拦截的工具。
 *
 * 这些都是"改变工作区或宿主状态"的动作，也正是本模式要求派给子代理的东西。只读工具
 * （`read` / `glob` / `grep` / `web_*` / `skill`）与调度工具（`spawn_teammate` /
 * `send_message` / `team_task_*` / `todo_write` / `ask_user_question`）**不在其中**——
 * 它们是指挥者的本职。
 */
export const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  'write',
  'edit',
  'pwsh',
  'bash',
  'job_kill',
  'plugin_manager',
]);

/**
 * 能"把活派出去"的工具。
 *
 * 门禁只有在**至少有一个**可用时才生效：一个既不能自己动手、又没法派活的 agent 会
 * 陷入死锁，那比"指挥者偶尔自己动手"糟糕得多。精简部署里可能没有 Team 工具，这条
 * 检查就是给那种情况的逃生门。
 */
export const DELEGATION_TOOLS = Object.freeze([
  'spawn_teammate',
  'send_message',
  'team_task_create',
  'subagent',
  'subagent_fork',
  'workflow',
]);

/**
 * 判断一个 agent 是不是被委派出来的子级（teammate / subagent）。
 *
 * 三个独立证据，任一命中即可（`childSessionMeta()` 会同时写入它们）：
 *
 * | 字段 | 来源 |
 * |---|---|
 * | `header.parentSession` | 子会话记录其直接父级 |
 * | `header.origin === 'subagent'` | 子会话的产品来源分类 |
 * | `header.delegationDepth > 0` | 递归预算，持久化 |
 *
 * **拿不到 header 时返回 `true`**（当作子级放行）。这是刻意的：把 Lead 误判成子级
 * 只是门禁少拦一次，把子级误判成 Lead 却会让它彻底干不了活。
 *
 * @param {unknown} agent - 发起工具调用的 agent。
 * @returns {boolean} 是否应当视为"已委派的子级"。
 */
export function isDelegatedAgent(agent) {
  try {
    if (agent === null || typeof agent !== 'object') return true;
    const header = agent.session?.header;
    if (header === null || header === undefined || typeof header !== 'object') return true;
    if (header.parentSession !== undefined && header.parentSession !== null) return true;
    if (header.origin === 'subagent') return true;
    const depth = header.delegationDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * 从 agent 上读它可用的工具名。
 *
 * ## ⚠️ 这个函数曾经读出一个**空列表**，把门禁整个废掉了
 *
 * 第一版用 `agent.ctx.tools.schemas()`，注释里写着"在 agent 自己的作用域里求值"。**这是错的。**
 * 实测（`commander-web` 探针 profile，一个 web-app 式部署）：
 *
 * ```
 * schemaCount: 0
 * agent.ctx.tools.get('write')            === undefined
 * agent.ctx.tools.get('pwsh')             === undefined
 * agent.ctx.tools.get('ask_user_question') === undefined
 * ```
 *
 * 连 `write` 都"不存在"。原因是 `dsh-web-app` 把它随附的每一个能力行都设成
 * `disabled: true`，然后在**每个 preset 内部**重新声明 —— 于是**全局层是空的**，工具都在
 * preset 层与 agent 层。而 `schemas()` / `get()` 不显式传 scope 时，用的是**服务注册时的
 * 那个层**（全局），沿不到 preset 链上去。
 *
 * 后果不是"少拦一次"，而是**门禁在目标部署（桌面版正是 web-app）里完全不生效**：
 * 空列表 → `canDelegate === false` → `evaluatePreExecute` 放行 → 指挥者照常 `write`/`pwsh`。
 * 在 headless 里它"看起来是好的"，因为 headless 没有那层全局禁用，全局层里工具齐全。
 *
 * ## 所以：空视图 = 读不到，不是"这个 agent 没有工具"
 *
 * 任何活着的 agent 至少也有 `read` / `glob`。视图为空只可能是上面那种层错位，此时**必须**
 * 返回 `undefined`（未知），让调用方按"有派发通道"处理，而不是把空列表当成事实。
 *
 * @param {unknown} agent - 发起调用的 agent。
 * @returns {string[] | undefined} 工具名；读不到时 `undefined`。
 */
export function agentToolNames(agent) {
  try {
    const schemas = agent?.ctx?.tools?.schemas?.();
    if (!Array.isArray(schemas)) return undefined;
    const names = schemas.map((schema) => String(schema?.name ?? '')).filter((name) => name !== '');
    // 空视图按"读不到"处理 —— 见上面那段：把 [] 当事实会让门禁在 web-app 式部署里失效。
    return names.length === 0 ? undefined : names;
  } catch {
    return undefined;
  }
}

/**
 * 判定一次工具调用是否应当被拒绝。
 *
 * 返回 `undefined` 表示放行。所有"拿不准"的分支都走放行。
 *
 * @param {object} input - 判定输入。
 * @param {unknown} input.agent - 发起调用的 agent。
 * @param {string} input.name - 工具名。
 * @param {Iterable<string>} [input.blocked] - 被拦截的工具名集合。
 * @param {boolean} [input.canDelegate] - 该 agent 是否有可用的派发工具；`undefined`
 *   表示未知（按"有"处理，因为正常部署里一定有）。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名，用来生成**它真
 *   的能照着做**的纠正指令；`undefined` 表示未知（按"都有"处理）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluatePreExecute({ agent, name, blocked = DEFAULT_BLOCKED_TOOLS, canDelegate, availableTools }) {
  const toolName = typeof name === 'string' ? name : '';
  if (toolName === '') return undefined;

  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  if (!blockedSet.has(toolName)) return undefined;

  // 子级（teammate / subagent）必须能干活。
  if (isDelegatedAgent(agent)) return undefined;

  // 没有任何派发工具时不能拦：那会让会话死锁。
  if (canDelegate === false) return undefined;

  return { kind: 'deny', reason: buildDenialReason(toolName, availableTools) };
}

/**
 * 拒绝理由。
 *
 * 它会被原样包进 `Error: …` 交给模型，所以措辞是**纠正指令**而不是报错说明：说清
 * 为什么被拦、下一步具体调哪个工具、以及不要重试。
 *
 * ⚠️ 指引必须按 agent **实际拥有的工具**生成。第一版把 `spawn_teammate` 与
 * `team_task_create` 写死了，结果在一个没有 Agent Teams 的部署里（headless 探测 profile，
 * 只有 `subagent`），模型收到"请用 `spawn_teammate`"却找不到这个工具，**当场卡住** ——
 * 既不能自己动手，也没被指引到它真正能用的那条路。这与"协议里点名工具前，先确认那个
 * 工具真的在"是同一课，只不过这次踩在错误信息里。
 *
 * @param {string} toolName - 被拒绝的工具名。
 * @param {string[]} [availableTools] - 该 agent 可用的工具名；`undefined` 表示未知
 *   （按"都有"处理，生成完整指引）。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildDenialReason(toolName, availableTools) {
  const known = Array.isArray(availableTools);
  const has = (name) => !known || availableTools.includes(name);

  const steps = [];

  // 第一步：先让用户确认计划 —— 只有在真有这个工具时才点名它。
  steps.push(
    has('ask_user_question')
      ? '1) 如果计划还没让用户确认，先调用 `ask_user_question` 把计划摆给用户确认；'
      : '1) 如果计划还没让用户确认，就在正文里把计划列出来、请用户确认后再继续；',
  );

  // 第二步：派发。按实际可用的通道分派措辞。
  //
  // specialist 工具名是动态的（`subagent_<id>`），所以只在**读得到工具视图**时按前缀
  // 收集 —— 读不到视图时不能猜，否则会点名一个不存在的工具（0.1.x 踩过这个坑）。
  const specialistTools = known ? availableTools.filter((name) => typeof name === 'string' && name.startsWith('subagent_')) : [];
  if (specialistTools.length > 0) {
    steps.push(
      `2) 用 ${specialistTools.map((name) => `\`${name}\``).join(' / ')} 把这一步派给对应的 specialist —— ` +
        'task 必须自包含：目标与背景、产出物、验收判据、写作用域、回报格式；',
    );
  } else if (has('spawn_teammate') && has('send_message')) {
    steps.push(
      '2) 用 `spawn_teammate` 建一个 teammate，再用 `send_message` 把这一步发给它——prompt 里写清目标、产出物、验收判据与写作用域；',
    );
  } else if (has('subagent')) {
    steps.push(
      '2) 用 `subagent` 把这一步派出去——prompt 必须自包含：目标、产出物、验收判据、写作用域都要写清（子代理看不到本会话的对话）；',
    );
  } else if (has('workflow')) {
    steps.push('2) 用 `workflow` 把这一步扇出给子代理执行——每个子任务的 prompt 都要自包含；');
  }

  // 第三步：任务板（可选通道，只在真有的时候提）。
  if (has('team_task_create')) {
    steps.push('3) 或者用 `team_task_create` 建任务、`team_task_update` 认领，再派发。');
  }

  // 一条派发路径都没找到（或者读不到工具视图却也没有任何已知通道）时，给逃生口。
  const tail =
    steps.length > 1
      ? '如果你认为这一步确实必须由你自己完成，请向用户说明理由并请他决定。'
      : '这个部署里没有可用的委派工具：请把要做的事连同验收判据写进正文，请用户决定怎么办——不要自己动手。';

  return [
    `指挥者模式：你不自己执行 \`${toolName}\`。`,
    '本模式下所有写文件、跑命令、装依赖、删东西的动作都必须派给子代理，指挥者只做分析、规划、拆分、派发与汇总。',
    '现在请这样做（不要重试本工具）：',
    ...steps,
    tail,
  ].join('\n');
}
