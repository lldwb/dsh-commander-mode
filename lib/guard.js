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
 * ## 3.0.0：三条「谁来做」门禁（三层指挥链）
 *
 * 「指挥官 → 小组长 → 子智能体」之后，除了"不执行操作"，还有三类动作不该由指挥官直接做：
 *
 * 1. **任务板进展与排期**（`team_task_update` 的 claim / release / complete / reopen /
 *    set_dependencies）—— 见 `evaluateBoardWrite()`；
 * 2. **工单推进状态**（`commander_ticket_update` 的六态回报，它会投影到共享任务板）——
 *    见 `evaluateTicketWrite()`，否则指挥官可以绕道工单间接改进度；
 * 3. **专家名册的一次性工具**（`subagent_<id>`）—— 见 `evaluateSpecialistDispatch()`：
 *    团队活交给小组长（`subagent` / `subagent_fork` 建），一次性专家由小组长调用。
 *
 * 6.0.0（DSH 0.2.2-rc.2）起：`subagent` / `subagent_fork` **不再**是被拦的通道 —— 它们就是
 * 「智能体团队」里建小组长的手段（旧 Team 的 `spawn_teammate` 已移除）。被拦的只剩名册
 * 生成的 `subagent_<id>` 一次性专家工具。
 *
 * 三条都只对 Lead 生效（`isDelegatedAgent` 命中即放行），并受 `delegationHierarchy`
 * 配置控制；拒绝理由同样是**纠正指令**，且只按 agent 实际可用的工具生成。
 *
 * ## 3.1.0：禁止等待子智能体（硬编码，没有开关）
 *
 * 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**。所以 `wait_agent` 是
 * **无条件拒绝**（`evaluateWaitForbidden()`）——既不受 `blockedTools` 影响，
 * 也不受 `delegationHierarchy` 影响，更没有 `maxWaitMs` 之类的配置项（2.0.0 的
 * 等待上限门禁已整体移除）。
 *
 * **3.2.0 起覆盖整条链**：用户追加「不要等」之后，teammate（小组长）也不再放行 ——
 * 本模式里任何 agent 调 `wait_agent` 都被拒。不等之后靠「【派工完成】」通知唤醒 +
 * 读状态 + 追问，见该函数的注释。
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
 * 调度工具（`subagent` / `send_message` / `team_task_*` / `todo_write` /
 * `ask_user_question`）同样不在其中。
 *
 * ⚠️ `wait_agent` **也不在**这份清单里：它由 `evaluateWaitForbidden()` 单独、无条件地
 * 拦（3.1.0 起禁止等待，且没有开关）。放进来反而会让用户可以靠 `blockedTools: []`
 * 把它一起放开——那不是"不设开关"。
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
 * 陷入死锁，那比"指挥者偶尔自己动手"糟糕得多。
 *
 * 6.0.0：`subagent` / `subagent_fork` 是 Team 通道（建小组长），`send_message` 是续做，
 * `team_task_create` 是建板；`workflow` 是一次性扇出。`spawn_teammate` 已随 rc.2 移除。
 */
export const DELEGATION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'send_message',
  'team_task_create',
  'workflow',
]);

/**
 * 只有**小组长**能改的任务板动作（进度 + 排期）。
 *
 * 用户 2026-11-11 规则 4：「只有小组长可以修改智能体团队的任务进展并做排期」。
 * 这五个动作改变的是"这件事现在处于什么阶段、接下来谁做"——正是小组长对一个团队任务
 * 的职责。指挥官只保留建任务（`team_task_create`）、指派 owner（`reassign`）与读板。
 *
 * 刻意**不含** `reassign` / `edit` / `delete`：那是派单与清理，属于指挥官。
 */
export const LEADER_ONLY_TASK_ACTIONS = Object.freeze([
  'claim',
  'release',
  'complete',
  'reopen',
  'set_dependencies',
]);

/**
 * 只有**小组长**能报的工单推进状态（`commander_ticket_update` 的 `status`）。
 *
 * 为什么工单也要拦：`commander_ticket_update` 会通过 `lib/team-board-bridge.js` 把工单状态
 * 投影到共享任务板。只拦 `team_task_update` 的话，指挥官仍能改工单**间接**改进度，
 * 规则 4 就没落地。
 *
 * 刻意**不含** `done` / `cancelled`：那是指挥官的**验收与取消**（验收通过结算 / 放弃）。
 * 也不含 `dropped`：它语义上是"无需处理"的终结动作，与 `cancelled` 同族；按 Lead 的定稿
 * 清单只拦这五个六态回报。
 */
export const LEADER_ONLY_TICKET_STATUSES = Object.freeze([
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
]);

/**
 * 判断一个工具名是不是**名册生成的一次性专家工具**（`subagent_<id>`）。
 *
 * 6.0.0：`subagent` / `subagent_fork` **不属于**这一类 —— 它们是建小组长的 Team 通道，
 * 指挥官必须能用。被规则 3 约束的只有名册生成的 `subagent_<id>`（一次性、无任务板、
 * 无持续对话），那才是小组长的通道。
 *
 * `workflow` 也不算：它是编排，不是"派给某个子智能体"这条被规则 3 约束的通道。
 *
 * @param {unknown} name - 工具名。
 * @returns {boolean} 是否属于一次性专家工具。
 */
export function isSpecialistDispatchTool(name) {
  if (typeof name !== 'string' || name === '') return false;
  // ⚠️ `subagent_fork` 也以 `subagent_` 开头，所以必须先按**名字**排除两个标准 Team 通道工具，
  // 再按前缀识别名册工具（`subagent_<id>`）。只按前缀判会把 `subagent_fork` 当成一次性专家，
  // 于是指挥官建小组长的通道被自己的门禁拦死。
  if (name === 'subagent' || name === 'subagent_fork') return false;
  return /^subagent_[a-z0-9_-]+$/u.test(name);
}

/**
 * 「禁止等待子智能体」硬门禁（3.1.0，3.2.0 起覆盖整条指挥链）。
 *
 * 用户 2026-11-11 补充要求：**禁止等待子智能体，且不设开关**；随后追加一句
 * **「不要等」**——即**整条链上都不许等**，小组长也不许等自己的下级。
 *
 * ## 为什么是"完全禁止"，而不是"限制时长"
 *
 * 2.0.0 曾用 `maxWaitMs` 限制单次 `wait_agent` 的上限（默认 120s，配 0 可关闭）。
 * 历史数据说明"限制时长"不够：会话 5d9b3002 里 39 次 `wait_agent` 合计 231 分钟、
 * 单次最长 127.5 分钟；会话 3b342fc5 里 101 次合计 667.5 分钟（11.1 小时），其中
 * 6 次直接等满 1800000ms。用户在那两个会话里反复追问"怎么停下来了""你手下又停止了"。
 * 只要还能等，模型就会把"等"当成默认动作；只要还能配，部署里就会出现"这次先关掉"。
 * 所以 3.1.0 起：**本模式不允许调用 `wait_agent`，且没有任何配置项可以放开**。
 *
 * ## 不等之后靠什么
 *
 * - 下级结算时会用「【派工完成】」通知**主动唤醒**它的调用者（`agent.steer()`），
 *   这条通知自己会回来，不需要等；
 * - 要看状态：`list_agents` / `team_task_list` / `team_task_get`（读状态，不挂起）；
 * - 要推进：`send_message` 追问或追加指令；疑似停滞用 `interrupt_agent` 纠偏；
 * - 没有可推进的事：给用户（或上级）一句话阶段汇报并结束回合，等通知唤醒。
 *
 * ## 边界（3.2.0：不再有"子级放行"）
 *
 * 3.1.0 曾放行 teammate（小组长在 L1 等自己的下级）。用户随后明确要求**整条链都不许等**，
 * 所以 3.2.0 起**不再按身份放行**：只要这个 preset scope 里的 agent 调用 `wait_agent`，
 * 一律拒绝。门禁本身注册在 preset scope 上（见 `agent.js` 的
 * `tools/pre-execute`），所以"本模式之外"的 agent 本来就不会命中。
 *
 * 身份读不到也**拒绝**（与其它门禁的"宁可漏拦"不同）：等待不是完成工作所必需的动作，
 * 拦错的代价只是少一条捷径，而放过的代价是把"挂机"重新引回来。
 *
 * @param {object} [input] - 判定输入。
 * @param {string} [input.name] - 工具名（只有 `wait_agent` 会被拦）。
 * @param {unknown} [input.agent] - 发起调用的 agent（3.2.0 起**不参与判定**，保留参数只为
 *   调用点签名稳定）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluateWaitForbidden({ name } = {}) {
  try {
    if (name !== 'wait_agent') return undefined;
    return { kind: 'deny', reason: buildWaitForbiddenReason() };
  } catch {
    // 门禁自己出错时放行：它只是行为约束，不能让工具调用整体失败。
    return undefined;
  }
}

/**
 * 「禁止等待」的拒绝理由 —— 纠正指令，不是报错说明。
 *
 * 必须让模型当场知道三件事：被禁的是哪个工具、为什么连"短等"也不行、以及**不等之后
 * 具体该做什么**（读状态 / 追问 / 汇报收尾）。措辞里不要出现任何"可以配置"的暗示——
 * 这条门禁是硬编码的，也不区分层级。
 *
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildWaitForbiddenReason() {
  return [
    '三层指挥链门禁：本模式**不允许** `wait_agent`（硬禁用，**没有开关**，不要重试）。',
    '**整条链都不许等**：指挥官、小组长、子智能体都一样——不要等下级，也不要等上级。',
    '不等之后这样做：',
    '1) 要看状态 → `list_agents` / `team_task_list` / `team_task_get`（读状态，不挂起）；',
    '2) 要推进 → `send_message` 追问或追加指令；疑似停滞用 `interrupt_agent` 纠偏或换人；',
    '3) 没有可推进的事 → 给用户（或上级）一句话阶段汇报并**结束回合**，等完成通知唤醒你。',
  ].join('\n');
}

/**
 * 判断一个 agent **实际能用**的派活通道是否非空（3.4.0）。
 *
 * ## 为什么不能只看工具视图
 *
 * 历史实现直接拿工具视图里有没有 `DELEGATION_TOOLS` / `subagent_*` 当"能派活"。
 * 但"视图里有"不等于"能调用"：
 *
 * 1. 用户可能把某个派发工具写进 `blockedTools`；
 * 2. 6.0.0 起名册生成的一次性专家工具（`subagent_<id>`）归小组长，对指挥官是关闭的；
 * 3. `wait_agent` 之类本来就不是派发通道。
 *
 * 只看视图会得出"能派活"的结论 → 执行边界继续拦 `write` → 而真正能调用的派发工具
 * 全被禁 → **指挥官既不能动手也不能派活**，整个模式死锁（与 def6609d 同一类冲突）。
 * 所以这里按"真的能调用"来算，拿不准时**按能派活处理**（宁严不漏，与其它门禁一致）。
 *
 * @param {object} [input] - 判定输入。
 * @param {string[]} [input.availableTools] - 工具视图；`undefined` 表示读不到。
 * @param {Iterable<string>} [input.blocked] - 被 `blockedTools` 拦下的工具名。
 * @param {boolean} [input.delegationHierarchy] - 层级门禁是否开启（默认开启）。
 * @returns {boolean | undefined} 是否有可用派活通道；`undefined` = 读不到视图（按"有"处理）。
 */
export function hasUsableDispatchChannel({ availableTools, blocked = [], delegationHierarchy = true } = {}) {
  try {
    if (!Array.isArray(availableTools)) return undefined;
    const blockedSet = blocked instanceof Set ? blocked : new Set(blocked ?? []);
    const usable = (name) => availableTools.includes(name) && !blockedSet.has(name);

    // Team 通道：建小组长（`subagent` / `subagent_fork`）或给它续做（`send_message`）。
    if (usable('subagent') || usable('subagent_fork') || usable('send_message')) return true;
    // `workflow` 是一次性扇出，不受层级门禁限制，也算派活通道。
    if (usable('workflow')) return true;
    // 一次性专家（`subagent_<id>`）：只在层级门禁关闭时才归指挥官。
    if (delegationHierarchy === false) {
      const specialist = availableTools.some((name) => isSpecialistDispatchTool(name) && !blockedSet.has(name));
      if (specialist) return true;
    }
    return false;
  } catch {
    return undefined;
  }
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
 * @param {boolean} [input.delegationHierarchy] - 是否启用三层指挥链门禁（3.0.0）。开启时
 *   一次性子智能体通道对指挥官关闭，拒因的派发指引会**优先给 Team 通道**；`undefined`
 *   按开启处理（与 `lib/config.js` 的 schema 默认一致）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluatePreExecute({ agent, name, blocked = DEFAULT_BLOCKED_TOOLS, canDelegate, availableTools, delegationHierarchy }) {
  const toolName = typeof name === 'string' ? name : '';
  if (toolName === '') return undefined;

  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  if (!blockedSet.has(toolName)) return undefined;

  // 子级（teammate / subagent）必须能干活。
  if (isDelegatedAgent(agent)) return undefined;

  // 没有任何派发工具时不能拦：那会让会话死锁。
  if (canDelegate === false) return undefined;

  return { kind: 'deny', reason: buildDenialReason(toolName, availableTools, { delegationHierarchy }) };
}

/**
 * 门禁「任务板进展与排期只能由小组长改」（3.0.0）。
 *
 * 判定链：不是 `team_task_update` → 放行；调用者是子级（`isDelegatedAgent` 命中，含身份
 * 读不出来）→ 放行；`action` 不在 `LEADER_ONLY_TASK_ACTIONS` 里（`reassign` / `edit` /
 * `delete` / 缺省）→ 放行；否则 deny。
 *
 * @param {object} [input] - 判定输入。
 * @param {unknown} [input.agent] - 发起调用的 agent。
 * @param {string} [input.name] - 工具名。
 * @param {unknown} [input.args] - 工具参数（`{ action?: string }`）。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名（用来生成**它能照着做**
 *   的纠正指令）；`undefined` 表示未知（按"都有"处理）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluateBoardWrite({ agent, name, args, availableTools } = {}) {
  try {
    if (name !== 'team_task_update') return undefined;
    // 子级（小组长 / 子智能体）必须能改任务板，否则"只有小组长改进度"就没人能改。
    if (isDelegatedAgent(agent)) return undefined;
    const action = readLowerString(args, 'action');
    if (!LEADER_ONLY_TASK_ACTIONS.includes(action)) return undefined;
    return { kind: 'deny', reason: buildBoardWriteReason({ action, availableTools }) };
  } catch {
    // 门禁自己出错时放行：它只是行为约束，不能让工具调用整体失败。
    return undefined;
  }
}

/**
 * 门禁「工单推进状态只能由小组长回报」（3.0.0）。
 *
 * `commander_ticket_update` 的状态会投影到共享任务板（`lib/team-board-bridge.js` 的
 * `applyStatus`），所以它和 `team_task_update` 是同一块写入口的两个面：只拦后者，
 * 指挥官仍能通过工单间接改进度。
 *
 * 放行：非 `commander_ticket_update`、子级调用、`status` 缺失或不属于六态回报
 * （`done` / `cancelled` / `dropped` 或只改 title / intent / acceptance / scope）。
 *
 * @param {object} [input] - 判定输入。
 * @param {unknown} [input.agent] - 发起调用的 agent。
 * @param {string} [input.name] - 工具名。
 * @param {unknown} [input.args] - 工具参数（`{ status?: string }`）。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` 表示未知。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluateTicketWrite({ agent, name, args, availableTools } = {}) {
  try {
    if (name !== 'commander_ticket_update') return undefined;
    if (isDelegatedAgent(agent)) return undefined;
    const status = readLowerString(args, 'status');
    if (!LEADER_ONLY_TICKET_STATUSES.includes(status)) return undefined;
    return { kind: 'deny', reason: buildTicketWriteReason({ status, availableTools }) };
  } catch {
    return undefined;
  }
}

/**
 * 门禁「指挥官不直接派一次性专家」（3.0.0 规则 3，6.0.0 收窄）。
 *
 * 团队活一律用 Team 通道交给小组长：`subagent` / `subagent_fork` 建小组长、`send_message`
 * 续做；名册生成的 `subagent_<id>`（一次性、无任务板、无持续对话）只由小组长调用。
 *
 * 6.0.0：`subagent` / `subagent_fork` **放行** —— 它们就是建小组长的通道（旧 Team 的
 * `spawn_teammate` 已被 rc.2 移除）。`workflow` 也不在拦截范围。
 *
 * @param {object} [input] - 判定输入。
 * @param {unknown} [input.agent] - 发起调用的 agent。
 * @param {string} [input.name] - 工具名。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` 表示未知。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluateSpecialistDispatch({ agent, name, availableTools } = {}) {
  try {
    if (!isSpecialistDispatchTool(name)) return undefined;
    // 小组长（L1）可以自己把子任务交给下级一次性专家（L2）—— 这正是规则 3。
    if (isDelegatedAgent(agent)) return undefined;
    return { kind: 'deny', reason: buildSpecialistDispatchReason({ toolName: name, availableTools }) };
  } catch {
    return undefined;
  }
}

/**
 * 读一个小写化的字符串参数（trim + toLowerCase）；非法/缺失返回 `''`。
 *
 * @param {unknown} args - 工具参数。
 * @param {string} key - 字段名。
 * @returns {string} 归一化后的值。
 */
function readLowerString(args, key) {
  if (args === null || typeof args !== 'object') return '';
  const value = args[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 拒绝理由。
 *
 * 它会被原样包进 `Error: …` 交给模型，所以措辞是**纠正指令**而不是报错说明：说清
 * 为什么被拦、下一步具体调哪个工具、以及不要重试。
 *
 * ⚠️ 指引必须按 agent **实际拥有的工具**生成。第一版把 `subagent` 与
 * `team_task_create` 写死了，结果在一个没有 Agent Teams 的部署里（headless 探测 profile，
 * 只有 `subagent`），模型收到"请用 `subagent`"却找不到这个工具，**当场卡住** ——
 * 既不能自己动手，也没被指引到它真正能用的那条路。这与"协议里点名工具前，先确认那个
 * 工具真的在"是同一课，只不过这次踩在错误信息里。
 *
 * ## 3.0.0：`delegationHierarchy` 改变第 2 步的指引
 *
 * 层级门禁开启时，一次性子智能体通道（`subagent_<id>` / `subagent` / `subagent_fork`）对
 * 指挥官是**关闭的**。如果还教它"用 `subagent_<id>` 派给 specialist"，它照做会立刻被
 * `evaluateSpecialistDispatch()` 拒绝 —— 白烧一轮，而且两次拒因互相矛盾。所以开启时第 2 步
 * **优先给 Team 通道**（`subagent` + `send_message` 交给小组长），并明确"一次性子
 * 智能体工具由小组长使用"；关闭时保持 2.x 的原行为（specialist 通道优先）。
 *
 * @param {string} toolName - 被拒绝的工具名。
 * @param {string[]} [availableTools] - 该 agent 可用的工具名；`undefined` 表示未知
 *   （按"都有"处理，生成完整指引）。
 * @param {object} [options] - 3.0.0 选项。
 * @param {boolean} [options.delegationHierarchy] - 是否启用三层指挥链门禁；`undefined` 按
 *   开启处理（与 `lib/config.js` 的 schema 默认一致），`false` 时按 2.x 行为生成指引。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildDenialReason(toolName, availableTools, options = {}) {
  const known = Array.isArray(availableTools);
  const has = (name) => !known || availableTools.includes(name);
  // 3.0.0：层级门禁默认开启（与 config schema 的 `delegationHierarchy` 默认一致）。
  const hierarchy = options?.delegationHierarchy !== false;

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
  //
  // 6.0.0：Team 通道 = `subagent` / `subagent_fork`（建小组长）+ `send_message`（续做）。
  // 这两个建人工具在 rc.2 里是标准 subagent 工具，不再是 Team 专属的 `spawn_teammate`。
  const specialistTools = known ? availableTools.filter((name) => isSpecialistDispatchTool(name)) : [];
  const canSpawnLead = has('subagent') || has('subagent_fork');
  const leadTool = has('subagent') ? 'subagent' : 'subagent_fork';
  if (hierarchy) {
    // 一次性专家通道归小组长。**不要**再指引指挥官去调 `subagent_<id>`——
    // 那会撞上 `evaluateSpecialistDispatch()`，模型会连续吃两次互相矛盾的拒绝。
    if (canSpawnLead && has('send_message')) {
      steps.push(
        `2) 用 \`${leadTool}\` 建一个小组长，再用 \`send_message\` 把这一步发给它（\`agent\` 参数用 \`list_agents\` 里的名字）——prompt 里写清目标、产出物、验收判据与写作用域；`,
      );
    } else if (has('send_message')) {
      steps.push(
        '2) 用 `send_message` 把这一步交给已有的小组长——prompt 里写清目标、产出物、验收判据与写作用域；',
      );
    } else if (canSpawnLead) {
      steps.push(
        `2) 用 \`${leadTool}\` 建一个小组长，并在它的 prompt 里把这一步交代清楚（目标、产出物、验收判据、写作用域）；`,
      );
    } else if (has('workflow')) {
      steps.push('2) 用 `workflow` 把这一步扇出给子代理执行——每个子任务的 prompt 都要自包含；');
    }
  } else if (specialistTools.length > 0) {
    steps.push(
      `2) 用 ${specialistTools.map((name) => `\`${name}\``).join(' / ')} 把这一步派给对应的 specialist —— ` +
        'task 必须自包含：目标与背景、产出物、验收判据、写作用域、回报格式；',
    );
  } else if (canSpawnLead && has('send_message')) {
    steps.push(
      `2) 用 \`${leadTool}\` 建一个小组长，再用 \`send_message\` 把这一步发给它——prompt 里写清目标、产出物、验收判据与写作用域；`,
    );
  } else if (canSpawnLead) {
    steps.push(
      `2) 用 \`${leadTool}\` 把这一步派出去——prompt 必须自包含：目标、产出物、验收判据、写作用域都要写清（子代理看不到本会话的对话）；`,
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
      : hierarchy
        ? '本模式下你没有可用的派活通道（一次性专家工具归小组长）：请把要做的事连同验收判据写进正文，请用户决定——不要自己动手。'
        : '本模式下没有可用的委派工具：请把要做的事连同验收判据写进正文，请用户决定怎么办——不要自己动手。';

  const lines = [
    `指挥者模式：你不自己执行 \`${toolName}\`。`,
    '本模式下所有"执行操作"都必须派给子代理：写文件、跑命令、装依赖、删东西，**以及远程执行（`ssh_*`）、'
      + '桌面注入（`desktop_*`）、浏览器操作（`browser_*`）、模拟器控制（`android_*`）、持久终端（`terminal_*`）**。'
      + '指挥者只做分析、规划、拆分、派发与汇总；只读侦察（`read` / `grep` / 截图 / `ssh_host list` 之类）不限。',
    '现在请这样做（不要重试本工具）：',
    ...steps,
  ];
  // 明确告诉指挥官"那条通道不是给你的"，否则它会在 Team 指引之外继续找一次性专家工具。
  if (hierarchy) {
    lines.push(
      canSpawnLead && has('send_message')
        ? '名册生成的一次性专家工具（`subagent_<id>`）由小组长使用，你不要调用；团队活交给小组长（`subagent` / `subagent_fork` 建人 + `send_message` 续做）。'
        : '名册生成的一次性专家工具（`subagent_<id>`）由小组长使用，你不要调用。',
    );
  }
  lines.push(tail);
  return lines.join('\n');
}

/**
 * 任务板写入门禁的拒绝理由 —— 纠正指令，不是报错说明。
 *
 * 说清三件事：被拦的是哪个动作、为什么它属于小组长、以及**现在该调哪个工具**。
 * 指引按 `availableTools` 生成（读不到就按"都有"给完整指引），绝不点名 agent 没有的工具。
 *
 * @param {object} [input] - 参数。
 * @param {string} [input.action] - 被拒绝的 `team_task_update` 动作。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` = 未知。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildBoardWriteReason({ action = '', availableTools } = {}) {
  const known = Array.isArray(availableTools);
  const has = (toolName) => !known || availableTools.includes(toolName);
  const shown = action === '' ? '这次动作' : `\`action:"${action}"\``;
  const steps = [];

  steps.push(
    has('send_message')
      ? '1) 用 `send_message` 让 owner（小组长）自己结算：写清该 claim / complete / reopen 哪个任务，由它调 `team_task_update`；'
      : '1) 让 owner（小组长）自己结算：把该 claim / complete / reopen 哪个任务写进派活消息，由它调 `team_task_update`；',
  );
  steps.push('2) 任务还没有 owner 时，用 `team_task_update` `action:"reassign"` 把 owner 指给小组长，再让它自己 claim / complete；');
  if (has('team_task_create')) {
    steps.push('3) 需要新增或拆分工作时用 `team_task_create` 建任务（一个团队一个任务），再 `reassign` 给小组长。');
  }

  return [
    `三层指挥链门禁：任务板动作 ${shown} 被拒绝 —— 任务进展与排期由小组长做，指挥官不改任务板状态。`,
    '`claim` / `release` / `complete` / `reopen` / `set_dependencies` 是**小组长（owner）**的动作；指挥官只负责建任务、指派 owner、读板与验收。',
    '现在请这样做（不要重试本次调用）：',
    ...steps,
    '`reassign` / `edit` / `delete` 仍然允许指挥官做（派单与清理）；被拦不代表不用结算——让 owner 做，然后核对它的回执。',
  ].join('\n');
}

/**
 * 工单写入门禁的拒绝理由 —— 纠正指令，不是报错说明。
 *
 * @param {object} [input] - 参数。
 * @param {string} [input.status] - 被拒绝的工单状态。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` = 未知。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildTicketWriteReason({ status = '', availableTools } = {}) {
  const known = Array.isArray(availableTools);
  const has = (toolName) => !known || availableTools.includes(toolName);
  const shown = status === '' ? '这次状态' : `\`status:"${status}"\``;
  const steps = [];

  steps.push(
    has('send_message')
      ? '1) 用 `send_message` 让小组长自己回报：要求它在回执里写 `STATUS: progress|waiting|ready|blocked|failed`，并调 `commander_ticket_update` 更新工单；'
      : '1) 让小组长自己回报：在派活消息里要求它回执写 `STATUS: progress|waiting|ready|blocked|failed`，并更新工单；',
  );
  steps.push('2) 你只做验收：核对小组长给的自证（产物路径 / 测试原始输出 / `git diff`），通过后用 `status:"done"` 结算，或 `status:"cancelled"` 取消；');

  return [
    `三层指挥链门禁：工单推进状态 ${shown} 被拒绝 —— 工单的推进状态由小组长回报，指挥官不代它报。`,
    '工单状态会投影到共享任务板；指挥官自己改状态等于绕过「只有小组长改进度与排期」这条边界。',
    '现在请这样做（不要重试本次调用）：',
    ...steps,
    '`done` / `cancelled`，以及只改 title / intent / acceptance / scope 的调用仍然允许（验收结论与派单信息由指挥官维护）。',
  ].join('\n');
}

/**
 * 子智能体派发门禁的拒绝理由 —— 纠正指令，不是报错说明。
 *
 * @param {object} [input] - 参数。
 * @param {string} [input.toolName] - 被拒绝的工具名。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` = 未知。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildSpecialistDispatchReason({ toolName = '', availableTools } = {}) {
  const known = Array.isArray(availableTools);
  const has = (name) => !known || availableTools.includes(name);
  const shown = toolName === '' ? '一次性专家工具' : `\`${toolName}\``;
  const canSpawnLead = has('subagent') || has('subagent_fork');
  const leadTool = has('subagent') ? 'subagent' : 'subagent_fork';
  const teamChannel = canSpawnLead && has('send_message')
    ? '团队活交给小组长（`subagent` / `subagent_fork` 建小组长、`send_message` 续做派活）'
    : has('send_message')
      ? '团队活交给小组长（用 `send_message` 派给已有的小组长；还没有就先建一个）'
      : '团队活交给小组长';
  const steps = [];

  steps.push(
    canSpawnLead && has('send_message')
      ? `1) 用 \`${leadTool}\` 建一个小组长，再用 \`send_message\` 把这一步发给它（\`agent\` 用 \`list_agents\` 里的名字）——prompt 写清目标、产出物、验收判据与写作用域；`
      : '1) 把这一步交给小组长：写清目标、产出物、验收判据与写作用域；',
  );
  if (has('team_task_create')) {
    steps.push('2) 需要跟踪时用 `team_task_create` 建团队任务、`team_task_update` `action:"reassign"` 指派 owner（这两个动作允许指挥官做）。');
  }
  steps.push('3) 名册生成的一次性专家工具（`subagent_<id>`）只由**小组长**调用：它可以把子任务交给下级；指挥官不直接派。');

  return [
    `三层指挥链门禁：${shown} 被拒绝 —— ${teamChannel}；一次性专家由小组长自己调用。`,
    '你现在是 L0（指挥官）：只做目标、拆分、派单、验收与与用户沟通。子智能体是 L2，由小组长（L1）派——你越过小组长直接派，等于让"任务进展与排期"没有主人。',
    '现在请这样做（不要重试本工具）：',
    ...steps,
    '如果你认为这一步确实必须由你自己派子智能体，请向用户说明理由并请他决定。',
  ].join('\n');
}
