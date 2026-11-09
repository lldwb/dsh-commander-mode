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
 * ## 判据是「会不会改变工作区 / 宿主 / 外部系统的状态」
 *
 * 不只是"写文件"。历史事故（session-a0c0b646，2026-11-09）就是只拦了六个本地工具：
 * 那一轮指挥者本地 `write`/`edit`/`pwsh` 都是 **0 次**（确实派出去了），但它自己调了
 * **51 次 `ssh_exec` + 2 次 `ssh_upload` + 1 次 `ssh_job`**，在远程 PC 上 dir/ver/powershell
 * 一路操作 —— 用户看到的就是"指挥者亲力亲为"。远程执行、桌面注入、浏览器操作、
 * 模拟器控制、持久终端，本质和 `pwsh` 一样是"执行操作"，必须一起拦。
 *
 * 只读工具**不在其中**：`read` / `glob` / `grep` / `web_*` / `skill` / `session_*`、
 * 以及各执行类插件的**只读半边**（`ssh_host` 的 list、`desktop_screenshot` /
 * `desktop_ui_dump` / `desktop_windows_list`、`browser_snapshot` / `browser_screenshot` /
 * `browser_console` / `browser_network` / `browser_status` / `browser_list_pages`、
 * `android_status` / `android_screenshot` / `android_ui_dump` / `android_logcat`、
 * `terminal_read` / `terminal_list`、`job_output` / `job_list`）—— 只读侦察是指挥者的本职。
 * 调度工具（`spawn_teammate` / `send_message` / `team_task_*` / `todo_write` /
 * `ask_user_question`）同样不在其中。
 */
export const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  // 本地：写文件、跑命令、杀任务、装插件
  'write',
  'edit',
  'pwsh',
  'bash',
  'job_kill',
  'plugin_manager',
  // 远程执行：SSH 跑命令 / 传文件 / 长任务（只放行 ssh_host 的只读查询）
  'ssh_exec',
  'ssh_job',
  'ssh_upload',
  'ssh_download',
  'ssh_fetch',
  // 桌面注入：鼠标 / 键盘 / 控件动作 / 窗口聚焦
  'desktop_mouse_move',
  'desktop_mouse_click',
  'desktop_mouse_drag',
  'desktop_mouse_scroll',
  'desktop_key_press',
  'desktop_type_text',
  'desktop_ui_invoke',
  'desktop_ui_set_value',
  'desktop_window_focus',
  // 浏览器改动：导航 / 点击 / 输入 / 上传 / 对话框 / 执行 JS
  'browser_connect',
  'browser_disconnect',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_upload_file',
  'browser_handle_dialog',
  'browser_evaluate',
  'browser_close_page',
  // 模拟器控制：建/起/停设备、装包、启停应用、点击滑动输入
  'android_avd_create',
  'android_emulator_start',
  'android_emulator_stop',
  'android_apk_install',
  'android_app_launch',
  'android_app_stop',
  'android_ui_tap',
  'android_ui_swipe',
  'android_ui_input',
  'android_ui_key',
  // 持久终端：开会话 / 发输入 / 发信号 / 关会话（读输出不限）
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  // 工作树：建分支 / 切换目录属于改变仓库状态
  'create_worktree',
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
 * `wait_agent` 的等待上限门禁（2.0.0）。
 *
 * ## 为什么这条要做成代码
 *
 * 协议可以"劝"模型别长等，但历史会话证明劝不住：2026-11-09 复盘的四个会话里，
 * 会话 5d9b3002 有 39 次 `wait_agent` 合计 231 分钟、单次最长 127.5 分钟；
 * 会话 3b342fc5 有 101 次合计 667.5 分钟，其中 6 次直接等满 1800000ms 超时。
 * 用户在那两个会话里反复追问"怎么停下来了""你手下又停止了"。
 *
 * DSH 的 `wait_agent` 参数是 `timeout_ms`（整数毫秒，缺省 30000，工具本身允许
 * 10000–3600000）。给了多大的值就真的挂住多久。所以这里在 `tools/pre-execute` 上
 * 确定性拒绝超长等待 —— 不是提示，是拒绝。
 *
 * ## 边界
 *
 * 只拦 `wait_agent` 的**超长 timeout_ms**。`list_agents` / `team_task_list` /
 * `send_message` / `team_task_update` 这些"读状态 / 唤醒队友 / 建板"的工具一律不拦：
 * 它们不会挂住会话，而且是"不要长等"之后的正确动作。
 *
 * @param {object} [input] - 判定输入。
 * @param {string} [input.name] - 工具名。
 * @param {unknown} [input.args] - 工具参数（`{ timeout_ms?: number }`）。
 * @param {number} [input.maxWaitMs] - 允许的单次等待上限（ms）；`<= 0` 表示关闭门禁。
 * @returns {string | undefined} 拒因（面向模型的纠正指令）；放行时 `undefined`。
 */
export function evaluateWaitCap({ name, args, maxWaitMs } = {}) {
  try {
    if (name !== 'wait_agent') return undefined;

    // 上限本身非法时按默认值处理（读配置的链路已经兜过一层，这里只防手调）。
    const capRaw = typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs) ? Math.round(maxWaitMs) : DEFAULT_MAX_WAIT_MS;
    if (capRaw <= 0) return undefined; // 0 = 关闭门禁

    const timeout = readWaitTimeout(args);
    // `timeout_ms` 缺省时 DSH 用 30000：按这个真实生效值比较，而不是当成"没有参数"。
    if (timeout.kind === 'absent') return DSH_DEFAULT_WAIT_MS <= capRaw ? undefined : buildWaitCapReason({ cap: capRaw, value: DSH_DEFAULT_WAIT_MS, invalid: false });
    if (timeout.kind === 'invalid') return buildWaitCapReason({ cap: capRaw, value: timeout.shown, invalid: true });
    if (timeout.value <= capRaw) return undefined;
    return buildWaitCapReason({ cap: capRaw, value: timeout.value, invalid: false });
  } catch {
    // 门禁自己出错时放行：它只是行为约束，不能让工具调用整体失败。
    return undefined;
  }
}

/**
 * 等待门禁的默认上限（ms）—— 与 `lib/config.js` 的 schema 默认值同源。
 *
 * 默认 **120000（2 分钟）**：用户 2026-11-09 复盘四个历史会话后要求"等子代理不要
 * 一直等"，并在 2.0.1 短暂关掉后**改回开启**——确认这条硬约束要生效。
 * 正常的子代理进展通知通常远小于 2 分钟；超过它就该去做别的（推进其它阶段、补文档、
 * 跑只读核对），而不是挂住会话。需要彻底放开时把 `maxWaitMs` 设为 0。
 */
export const DEFAULT_MAX_WAIT_MS = 120_000;

/** DSH `wait_agent` 在没给 `timeout_ms` 时实际生效的默认值（ms）。 */
export const DSH_DEFAULT_WAIT_MS = 30_000;

/**
 * 解析 `wait_agent` 的 `timeout_ms`。
 *
 * 三态：缺省（走 DSH 默认）、合法整数、非法（字符串 / 非整数 / 非正 / 其它类型）。
 * 字符串数字也按非法处理 —— 模型把 1800000 写成 "1800000" 时语义是超长等待，
 * 不能被静默放行。
 *
 * @param {unknown} args - 工具参数。
 * @returns {{ kind: 'absent' } | { kind: 'value', value: number } | { kind: 'invalid', shown: string }} 解析结果。
 */
function readWaitTimeout(args) {
  if (args === null || typeof args !== 'object') return { kind: 'absent' };
  const raw = args.timeout_ms;
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { kind: 'invalid', shown: String(raw) };
  return { kind: 'value', value: raw };
}

/**
 * 等待门禁的拒绝理由 —— 同样是**纠正指令**，不是报错说明。
 *
 * 必须让模型当场知道三件事：被拦的是哪次等待、合法上限是多少、以及"不等之后该干什么"。
 *
 * @param {object} input - 参数。
 * @param {number} input.cap - 当前上限（ms）。
 * @param {number | string} input.value - 模型给的值（或非法值的字符串形式）。
 * @param {boolean} input.invalid - 是否因为取值非法（而不是超限）被拒。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildWaitCapReason({ cap, value, invalid }) {
  const head = invalid
    ? `项目经理/指挥者模式：\`wait_agent\` 的 \`timeout_ms\` 必须是**正整数毫秒**（例如 60000），收到的是 ${value}，已拒绝。`
    : `项目经理/指挥者模式：\`wait_agent\` 的 \`timeout_ms\`=${String(value)} 超过本次等待上限 ${cap}ms，已拒绝。`;
  return [
    head,
    `等子代理不要一直等：改成 ≤ ${cap} 的短等待（建议 60000ms 以内），超时后**继续推进其它工作**——推进其它阶段、补文档、跑只读核对、准备下一批派工；不要长等。`,
    '子代理完成时会主动发一条「【派工完成】」通知（会唤醒你），优先依赖它；要确认状态用 `list_agents` / `team_task_list`（这些工具不会被拦），疑似停滞再 `interrupt_agent` 或换人。',
  ].join('\n');
}

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
    '本模式下所有"执行操作"都必须派给子代理：写文件、跑命令、装依赖、删东西，**以及远程执行（`ssh_*`）、'
      + '桌面注入（`desktop_*`）、浏览器操作（`browser_*`）、模拟器控制（`android_*`）、持久终端（`terminal_*`）**。'
      + '指挥者只做分析、规划、拆分、派发与汇总；只读侦察（`read` / `grep` / 截图 / `ssh_host list` 之类）不限。',
    '现在请这样做（不要重试本工具）：',
    ...steps,
    tail,
  ].join('\n');
}
