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
 * ## 7.0.0：派发通道硬门禁（用户硬要求，不可配置、无开关）
 *
 * 用户 2026-11-12 原话：「不能出现这种另辟蹊径开子智能体的方法，需要把这种指挥官->小组长->
 * 小组长的手下 这种分发没问题」；口径已明确：**连 Worker Session 一起禁**。
 *
 * 于是 `evaluateCommanderChannels()` 对**指挥官本人**一律拒绝：
 *
 * - `workflow`（一次性扇出）；
 * - 名册生成的一次性专家工具（`subagent_<id>`）；
 * - 所有 `commander_worker_*`（Worker Session；7.0.1 起实现已删除，前缀判定保留作防御）。
 *
 * 唯一允许的通道是 `subagent` / `subagent_fork`（建小组长）+ `send_message`（派活）
 * + `team_task_*`（任务板）+ `list_agents`（读状态），`interrupt_agent` 仍可纠偏。
 * **小组长 / 子智能体不受限**（L1→L2 是用户明确认可的链路）。这条门禁在
 * `tools/pre-execute` 上**无条件**执行，`delegationHierarchy: false` 也拦。
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
 * 能"把活派出去"的工具（**只算指挥官真正能用的通道**）。
 *
 * 门禁只有在**至少有一个**可用时才生效：一个既不能自己动手、又没法派活的 agent 会
 * 陷入死锁，那比"指挥者偶尔自己动手"糟糕得多。
 *
 * 6.0.0：`subagent` / `subagent_fork` 是 Team 通道（建小组长），`send_message` 是续做，
 * `team_task_create` 是建板。`spawn_teammate` 已随 rc.2 移除。
 *
 * 7.0.0（用户硬要求「不能另辟蹊径开子智能体」）：**`workflow` 已从清单里删除** ——
 * 它不再是指挥官的派发通道（对指挥官是硬门禁拒绝）。若还留在这里，
 * `hasUsableDispatchChannel()` 会误判"指挥官有派发通道"，于是执行边界继续拦 `write`，
 * 而真正能用的通道其实只有建小组长 —— 那正是 3.4.0 修过的死锁形状。
 */
export const DELEGATION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'send_message',
  'team_task_create',
]);

/**
 * 指挥官**被硬禁用**的派发工具（7.0.0，用户硬要求，不可配置、无开关）。
 *
 * 用户原话：「不能出现这种另辟蹊径开子智能体的方法，需要把这种指挥官->小组长->小组长的
 * 手下 这种分发没问题」；口径已明确：**连 Worker Session 一起禁**。
 *
 * 真实现场（session-2cd6ae3c）：指挥者在 Worker 停滞被停掉后，向用户推荐"改用 specialist
 * 分 4 路" —— 直接用名册生成的 `subagent_<id>` 开 4 个子智能体，**跳过小组长层**。这就是
 * 「另辟蹊径」。所以对指挥官：
 *
 * - `workflow`（一次性扇出）→ 一律拒绝；
 * - 名册生成的一次性专家 `subagent_<id>` → 一律拒绝（`isSpecialistDispatchTool` 识别）；
 * - 所有 `commander_worker_*`（Worker Session；7.0.1 起实现已删除）→ 一律拒绝。
 *
 * 唯一允许的通道是 `subagent` / `subagent_fork`（建小组长）+ `send_message`（派活）
 * + `team_task_*`（任务板）+ `list_agents`（读状态）；`interrupt_agent` 仍可用于纠偏。
 *
 * ⚠️ **只拦指挥官本人**：小组长 / 子智能体调用这些工具**必须放行** —— 它们派自己的手下
 * 是 L1→L2，正是用户明确认可的那条链。
 */
export const COMMANDER_FORBIDDEN_DISPATCH = Object.freeze(['workflow']);

/**
 * Worker Session 工具名前缀（`commander_worker_spawn` / `_send` / `_status` / `_stop`）。
 *
 * ⚠️ **7.0.1 起这组工具的实现已从仓库删除**（`lib/worker-tools.js` 不再存在），所以正常
 * 部署里不会再有同名工具。保留前缀判定是**防御性**的：旧 profile 的 loader 树里可能还挂着
 * 升级前的工具行（热更新前），或者有人把旧版插件行混进同一个 profile —— 那时这道门禁
 * 仍然应该拒绝指挥官，而不是放它绕开小组长层。
 */
export const COMMANDER_WORKER_TOOL_PREFIX = 'commander_worker_';

/**
 * 指挥官**允许**的调度类工具（7.0.0 硬规则的正面清单，只用于文档与测试引用）。
 *
 * 注意这不是白名单实现：门禁只拦 `COMMANDER_FORBIDDEN_DISPATCH` / Worker 前缀 /
 * 名册专家三类，其余工具照旧走各自的门禁（执行边界 / 层级 / 等待）。列在这里是为了让
 * 「唯一允许的派发通道」在代码里有据可查。
 */
export const COMMANDER_DISPATCH_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'send_message',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'list_agents',
  'interrupt_agent',
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
 * 判断一个工具名是否属于「指挥官被硬禁用的派发通道」（7.0.0）。
 *
 * 三类：`workflow`、Worker Session（`commander_worker_*` 前缀；7.0.1 起实现已删除，
 * 判定保留作防御）、名册生成的一次性专家（`subagent_<id>`）。**不含** `subagent` /
 * `subagent_fork` / `send_message` / `team_task_*` / `list_agents` / `interrupt_agent`
 * —— 那些是指挥官唯一允许的通道。
 *
 * @param {unknown} name - 工具名。
 * @returns {boolean} 是否属于被硬禁用的派发通道。
 */
export function isCommanderForbiddenChannel(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (COMMANDER_FORBIDDEN_DISPATCH.includes(name)) return true;
  if (name.startsWith(COMMANDER_WORKER_TOOL_PREFIX)) return true;
  return isSpecialistDispatchTool(name);
}

/**
 * 「指挥官只能建小组长」派发通道硬门禁（7.0.0，用户硬要求，**不可配置、无开关**）。
 *
 * ## 为什么必须无条件执行
 *
 * 6.0.0 的 `evaluateSpecialistDispatch()` 被包在 `delegationHierarchy !== false` 的条件块里，
 * 而 `workflow` / Worker Session 干脆不在拦截面里。于是指挥官可以：
 *
 * - 用 `workflow` 一次性扇出 4 个子代理（跳过小组长层）；
 * - 用名册生成的 `subagent_<id>` 直派专家（同上）；
 * - 用 `commander_worker_spawn` 开独立 Worker Session（第三条执行通道）。
 *
 * 用户 2026-11-12 的硬要求把这三条一起关掉：**「不能出现这种另辟蹊径开子智能体的方法，
 * 需要把这种指挥官->小组长->小组长的手下 这种分发没问题」**，并明确「连 Worker Session
 * 一起禁」。所以本函数在 `tools/pre-execute` 上**先于层级门禁、无条件**调用：
 * `delegationHierarchy: false` 也拦（它不是"层级门禁的可选子集"，是通道本身不成立）。
 *
 * ## 放行面（最重要）
 *
 * `isDelegatedAgent(agent)` 命中即放行：小组长 / 子智能体可以用 `workflow`、名册专家、
 * 甚至再开自己的下级 —— 那是 L1→L2，用户明确认可。**门禁只拦指挥官本人。**
 *
 * ## 身份读不到时放行（与其它门禁同一方向）
 *
 * `isDelegatedAgent()` 对"读不到身份"返回 `true`（宁可漏拦，不可拦死）。这里沿用该语义：
 * 拦错小组长的代价是它派不了自己的手下（L1→L2 断链），而指挥官的身份在真实运行时
 * 总是可读的（根会话有 `session.header`）。真正需要防的是"明确判定为指挥官"却换通道。
 *
 * @param {object} [input] - 判定输入。
 * @param {unknown} [input.agent] - 发起调用的 agent。
 * @param {string} [input.name] - 工具名。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名（用来生成**它能照着做**
 *   的纠正指令）；`undefined` 表示未知（按"都有"处理）。
 * @returns {{ kind: 'deny', reason: string } | undefined} 拒绝决策，或放行。
 */
export function evaluateCommanderChannels({ agent, name, availableTools } = {}) {
  try {
    if (!isCommanderForbiddenChannel(name)) return undefined;
    // 小组长 / 子智能体：派自己的手下是 L1→L2，必须放行（见函数注释）。
    if (isDelegatedAgent(agent)) return undefined;
    return { kind: 'deny', reason: buildCommanderChannelReason({ toolName: name, availableTools }) };
  } catch {
    // 门禁自己出错时放行：它只是行为约束，不能让工具调用整体失败。
    return undefined;
  }
}

/**
 * 派发通道硬门禁的拒绝理由 —— 纠正指令，不是报错说明。
 *
 * 必须让模型当场知道四件事：
 *
 * 1. 被禁的是哪条通道（`workflow` / 名册一次性专家 / Worker Session）；
 * 2. 指挥官**唯一**的通道是「建小组长」（`subagent` / `subagent_fork` + `send_message`）；
 * 3. 子任务由小组长再派给它的手下（L1→L2），不是指挥官的活；
 * 4. **需要小组长 / 小组长失败时的唯一恢复阶梯**（用户 2026-11-12 追问
 *    「如果遇到需要小组长怎么办，比如 session-fb21d6a0 这种会话」）——任何一步都不许换通道。
 *
 * 指引按 `availableTools` 生成（读不到就按"都有"给完整指引），绝不点名 agent 没有的工具
 * （沿用 `buildDenialReason` 的既有纪律）。
 *
 * @param {object} [input] - 参数。
 * @param {string} [input.toolName] - 被拒绝的工具名。
 * @param {string[]} [input.availableTools] - 该 agent 实际可用的工具名；`undefined` = 未知。
 * @returns {string} 面向模型的拒绝理由。
 */
export function buildCommanderChannelReason({ toolName = '', availableTools } = {}) {
  const known = Array.isArray(availableTools);
  const has = (name) => !known || availableTools.includes(name);
  const shown = toolName === '' ? '这个工具' : `\`${toolName}\``;
  const canSpawnLead = has('subagent') || has('subagent_fork');
  const leadTool = has('subagent') ? 'subagent' : 'subagent_fork';

  const steps = [];
  // 通道说明必须按**实际可用工具**生成（沿用 buildDenialReason 的既有纪律：
  // 点名一个不存在的工具会让模型当场卡住）。
  const channelLine = canSpawnLead && has('send_message')
    ? '指挥官**只有一条**派发通道：**建小组长**（`subagent` / `subagent_fork` 建人 + `send_message` 派活）；子任务由**小组长自己**再派给它的手下（`subagent` / `subagent_fork` / `workflow` / 名册专家）——那是 L1→L2，不受本门禁限制。'
    : canSpawnLead
      ? `指挥官**只有一条**派发通道：**建小组长**（用 \`${leadTool}\` 建人，prompt 一次派全）；子任务由**小组长自己**再派给它的手下（\`subagent\` / \`subagent_fork\` / \`workflow\` / 名册专家）——那是 L1→L2，不受本门禁限制。`
      : has('send_message')
        ? '指挥官**只有一条**派发通道：**交给已有的小组长**（用 `send_message` 派活/续做）；子任务由**小组长自己**再派给它的手下——那是 L1→L2，不受本门禁限制。'
        : '指挥官**只有一条**派发通道：**建小组长**（本会话读不到建人工具，见下面的逃生口）。子任务由**小组长自己**再派给它的手下——那是 L1→L2，不受本门禁限制。';
  // 第 1 步：需要小组长时怎么建（这是唯一入口）。
  if (canSpawnLead && has('send_message')) {
    steps.push(
      `1) 需要小组长 → 用 \`${leadTool}\` 创建（需要继承你已完成轮次的上下文时用 \`subagent_fork\`），prompt 自包含并写 \`[ticket:t-N]\`；建完用 \`send_message\` 派活（或在创建时的 prompt 里一次派全）。`,
    );
  } else if (canSpawnLead) {
    steps.push(
      `1) 需要小组长 → 用 \`${leadTool}\` 创建，prompt 必须自包含：目标、产出物、验收判据、写作用域、\`[ticket:t-N]\`、回报格式一次写全。`,
    );
  } else if (has('send_message')) {
    steps.push('1) 需要小组长 → 用 `send_message` 交给已有的小组长；还没有小组长就请用户决定（本会话读不到建人工具）。');
  } else {
    steps.push('1) 需要小组长 → 本会话读不到建小组长的工具：把要做的事连同验收判据写进正文，请用户决定——**不要换通道，也不要自己动手**。');
  }
  // 第 2 步：已有小组长时不要新建。只点名它真有的工具。
  steps.push(
    has('send_message')
      ? '2) 小组长已存在但 inactive → 用 `send_message` 冷恢复并派活，**不要新建**（新建会丢掉它已有的上下文与产物）。'
      : '2) 小组长已存在时**不要新建**（新建会丢掉它已有的上下文与产物）；本会话没有可用的续做工具，把这一步交给用户决定。',
  );
  // 第 3 步：停滞 / 失败时的处置。只点名它真有的工具（`git log` / 产物目录不是工具，永远可提）。
  const readHints = [has('list_agents') ? '`list_agents`' : '', has('team_task_list') ? '`team_task_list`' : '', '`git log` / 产物目录']
    .filter((hint) => hint !== '')
    .join(' / ');
  const recoverHint = has('interrupt_agent')
    ? '确认停滞就 `interrupt_agent` 纠偏，或**新建一个小组长接管同一张工单**（旧的不再使用，避免两个执行者写同一批文件）'
    : '确认停滞就**新建一个小组长接管同一张工单**（旧的不再使用，避免两个执行者写同一批文件）';
  steps.push(`3) 小组长停滞 / 失败 → 先只读核对产物（${readHints}）→ ${recoverHint} → 仍不行就把工单标 \`blocked\`、上报用户。`);
  // 第 4 步：建人工具自己报错时怎么办（session-fb21d6a0 的现场）。只点名它真有的工具。
  steps.push(
    canSpawnLead
      ? '4) `subagent` 本身报错（含内部错误）→ 重试一次；再失败就标 `blocked` 并问用户，不要改走别的通道。'
      : '4) 建人工具本身报错（含内部错误）→ 重试一次；再失败就标 `blocked` 并问用户，不要改走别的通道。',
  );

  return [
    `派发通道门禁：${shown} 不是指挥官的派发通道（7.0.0 起**硬禁用、没有开关**，不要重试）。`,
    channelLine,
    '⚠️ **任何一步都不许换通道**：不许用 `workflow` 一次性扇出、不许用名册生成的一次性专家工具（`subagent_<id>`）、不许用 Worker Session（`commander_worker_*`，7.0.1 起实现已删除），也不许自己直接动手。小组长失败就**换一个小组长重派或上报用户，不要换通道**。',
    '现在请按这个恢复阶梯做（不要重试本工具）：',
    ...steps,
  ].join('\n');
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
 * 判断一个 agent **实际能用**的派活通道是否非空（3.4.0，7.0.0 收窄到"只算建小组长"）。
 *
 * ## 为什么不能只看工具视图
 *
 * 历史实现直接拿工具视图里有没有 `DELEGATION_TOOLS` / `subagent_*` 当"能派活"。
 * 但"视图里有"不等于"能调用"：
 *
 * 1. 用户可能把某个派发工具写进 `blockedTools`；
 * 2. 名册生成的一次性专家工具（`subagent_<id>`）归小组长，对指挥官是**硬门禁拒绝**；
 * 3. `wait_agent` 之类本来就不是派发通道。
 *
 * 只看视图会得出"能派活"的结论 → 执行边界继续拦 `write` → 而真正能调用的派发工具
 * 全被禁 → **指挥官既不能动手也不能派活**，整个模式死锁（与 def6609d 同一类冲突）。
 * 所以这里按"真的能调用"来算，拿不准时**按能派活处理**（宁严不漏，与其它门禁一致）。
 *
 * ## 7.0.0：只有 Team 建人算通道
 *
 * 指挥官唯一允许的派发通道是 `subagent` / `subagent_fork` / `send_message`（建小组长 +
 * 派活）。`workflow`、名册专家、Worker Session 对指挥官都是硬门禁拒绝 —— 若把它们算成
 * "可用通道"，执行边界会继续拦 `write`，而指挥官实际无路可派 → 死锁。
 *
 * ⚠️ 本函数**只用于指挥官视角**（`agent.js` 的执行边界判据）。小组长的能力不受它影响：
 * 门禁按身份放行子级，小组长照旧可以自己执行、用 `workflow` / 名册专家派它的手下。
 *
 * @param {object} [input] - 判定输入。
 * @param {string[]} [input.availableTools] - 工具视图；`undefined` 表示读不到。
 * @param {Iterable<string>} [input.blocked] - 被 `blockedTools` 拦下的工具名。
 * @returns {boolean | undefined} 是否有可用派活通道；`undefined` = 读不到视图（按"有"处理）。
 */
export function hasUsableDispatchChannel({ availableTools, blocked = [] } = {}) {
  try {
    if (!Array.isArray(availableTools)) return undefined;
    const blockedSet = blocked instanceof Set ? blocked : new Set(blocked ?? []);
    const usable = (name) => availableTools.includes(name) && !blockedSet.has(name);

    // 7.0.0：指挥官的通道**只有**建小组长这一条（`subagent` / `subagent_fork` 建人，
    // `send_message` 给已有小组长派活/续做）。`workflow` / 名册专家 / Worker Session
    // 都已从"可用通道"里删除 —— 它们对指挥官是硬门禁拒绝，算进来只会制造死锁。
    return usable('subagent') || usable('subagent_fork') || usable('send_message');
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
 * 门禁「小组长的下级没干完，就不能把小组长算作完成」（7.2.0）。
 *
 * ## 用户原话（2026-11-14，session-062eb97a）
 *
 * 「如果小组长的子智能体没有完成任务，不能视作小组长完成任务」。
 *
 * ## 现场
 *
 * 那个会话里 `bm-model-lead`（逆向汇总小组长）报的是 `STATUS: progress`，并明确写了
 * 「两个子智能体**仍在运行**……它们回报后我会再补一次提交回填最终结果——这是本任务唯一
 * 未闭合项」。指挥者仍然把它的工单结算成 `done`，直到用户指出「没有完成啊，逆向汇总的
 * 小组长的子智能体还没有完成任务呢」才纠正（它自己也承认「我把 `STATUS: progress` 当成了
 * `ready` 来结算」）。
 *
 * 这是**完成语义**的漏洞：工单的 `done` 只由指挥官写（`evaluateTicketWrite` 刻意放行它，
 * 因为那是验收动作），而"验收通过"的前提是**被验收的那件事真的做完了**——小组长没做完
 * 它的下级，它的交付就还缺件。
 *
 * ## 判据（只认正面证据，读不到一律放行）
 *
 * 拦截条件必须同时成立：
 *
 * 1. 工具是 `commander_ticket_update`、`status` 是 `done`（`cancelled` 是放弃，不拦）；
 * 2. 调用者是指挥官本人（子级放行：小组长结算自己的活不归这条管）；
 * 3. 这张工单**派过小组长**（`assignments[].ref` 非空），否则无从核对；
 * 4. 子智能体树**可读**，且其中存在 `activity === 'running'` 的行，其 `path` 等于某个
 *    派出去的小组长名，或在该名字的子树下（`<lead>/<child>`）。
 *
 * 任何一项读不到（没有 ledger / 没有 subagents 服务 / 身份不明 / 快照抛错）都**放行**：
 * 门禁只负责"有证据时不许结算"，不能因为读不到就卡住收尾。
 *
 * ## 为什么用 `assignments[].ref` 而不是任务板 owner
 *
 * `ticketView()` 不暴露 owner（owner 在共享任务板上，是异步视图）；而 `assignments[].ref`
 * 就是建小组长时 `subagent` 返回的 `name`，也正是 `list_agents` 里 `path` 的第一段——
 * 两者同源，不需要额外查询。
 *
 * @param {object} [input] - 判定输入。
 * @param {unknown} [input.agent] - 发起调用的 agent。
 * @param {string} [input.name] - 工具名。
 * @param {unknown} [input.args] - 工具参数（`{ ticket?: string, status?: string }`）。
 * @param {object | undefined} [input.ledger] - `commanderLedger` 服务（可能缺失）。
 * @param {object | undefined} [input.subagents] - `subagents` 服务（可能缺失）。
 * @param {string | undefined} [input.sessionId] - 指挥官会话 id（用于读子树）。
 * @returns {Promise<{ kind: 'deny', reason: string } | undefined>} 拒绝决策或放行。
 */
export async function evaluateTicketSettle({ agent, name, args, ledger, subagents, sessionId } = {}) {
  try {
    if (name !== 'commander_ticket_update') return undefined;
    if (isDelegatedAgent(agent)) return undefined;
    if (readLowerString(args, 'status') !== 'done') return undefined;
    const ticketId = readString(args, 'ticket');
    if (ticketId === '') return undefined;
    if (ledger === undefined || ledger === null) return undefined;
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    if (subagents === undefined || subagents === null) return undefined;
    if (typeof subagents.listDescendants !== 'function') return undefined;

    let ticket;
    try {
      ticket = ledger.getTicket(ticketId, sessionId, { allowMissing: true });
    } catch {
      return undefined;
    }
    if (ticket === null || ticket === undefined) return undefined;

    // 这张工单派过哪些小组长（去重；`ref` 是 `subagent` 返回的 name，也就是 path 第一段）。
    const leads = [...new Set((Array.isArray(ticket.assignments) ? ticket.assignments : [])
      .map((assignment) => (typeof assignment?.ref === 'string' ? assignment.ref.trim() : ''))
      .filter((ref) => ref !== ''))];
    if (leads.length === 0) return undefined;

    let rows;
    try {
      rows = await subagents.listDescendants(sessionId);
    } catch {
      return undefined;
    }
    const running = (Array.isArray(rows) ? rows : [])
      .filter((row) => row !== null && typeof row === 'object' && row.kind === 'child')
      .filter((row) => row.activity === 'running')
      .map((row) => (typeof row.path === 'string' && row.path !== '' ? row.path : String(row.id ?? '')))
      .filter((path) => leads.some((lead) => path === lead || path.startsWith(`${lead}/`)));
    if (running.length === 0) return undefined;

    return { kind: 'deny', reason: buildSettleReason({ ticketId, running }) };
  } catch {
    // 任何意外都放行：门禁只在证据充分时拦，读不到不能卡住收尾。
    return undefined;
  }
}

/**
 * 拒绝理由：说清"为什么不能结算"与"现在该做什么"。
 *
 * 措辞是**纠正指令**而不是报错说明（它会被原样交给模型）。
 *
 * @param {{ ticketId: string, running: string[] }} input - 工单 id 与仍在跑的下级路径。
 * @returns {string} 拒绝理由。
 */
function buildSettleReason({ ticketId, running }) {
  const shown = running.slice(0, 4).join('、');
  const more = running.length > 4 ? ` 等 ${running.length} 个` : '';
  return [
    `工单 \`${ticketId}\` 不能结算：它的下级**还在跑** —— ${shown}${more}。`,
    '小组长的下级没干完，小组长的交付就还缺件；"它的子智能体没完成任务"不等于"它完成了任务"。',
    '',
    '现在这样做（按顺序）：',
    '1. 用 `send_message` 让该小组长**收齐下级**：等这些子智能体结束、把它们的结论回填到主产物，',
    '   再让它自己回报 `STATUS: ready` + 回填提交哈希 + 「仍完全未验」清单；',
    '2. 它报 `ready` 之后，你核对：下级是否都已结束（`list_agents` 看 `path` 前缀）、产物是否真的回填了；',
    '3. 核对通过再用 `status:"done"` 结算；仍缺件就用 `status:"cancelled"` 放弃，或标 `blocked` 上报用户。',
    '',
    '⚠️ 不要重试本工具；也不要因为"催过它了"就当作完成 —— 只有下级的产物齐了才算完成。',
  ].join('\n');
}

/**
 * 门禁「指挥官不直接派一次性专家」（3.0.0 规则 3，6.0.0 收窄，7.0.0 并入硬通道门禁）。
 *
 * 团队活一律用 Team 通道交给小组长：`subagent` / `subagent_fork` 建小组长、`send_message`
 * 续做；名册生成的 `subagent_<id>`（一次性、无任务板、无持续对话）只由小组长调用。
 *
 * ## 7.0.0：保留本函数，但接线以 `evaluateCommanderChannels()` 为准
 *
 * 7.0.0 起 `subagent_<id>` 的拒绝**不再受 `delegationHierarchy` 控制**，并与 `workflow` /
 * Worker Session 合并成一条不可配置的硬规则（`evaluateCommanderChannels`）。本函数保留：
 *
 * - 它是"一次性专家工具"这一判据的**纯函数**（测试与文档按它引用）；
 * - 小组长路径的语义（`isDelegatedAgent` 命中即放行）不变；
 * - 若将来要单独恢复"只拦一次性专家"的软门禁，仍然可用。
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
 * 读一个**原样**字符串参数（trim，但不改大小写）；非法/缺失返回 `''`。
 *
 * 与 {@link readLowerString} 分开：工单 id（`t-339`）与小组长名（`bm-model-lead`）是
 * **大小写敏感**的标识符，小写化会让匹配失败（`t-339` 不受影响，但用户名可能是
 * `UI-Frame-Lead` 这种），所以匹配用原样值。
 *
 * @param {unknown} args - 工具参数。
 * @param {string} key - 字段名。
 * @returns {string} 归一化后的值。
 */
function readString(args, key) {
  if (args === null || typeof args !== 'object') return '';
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 拒绝理由（执行边界）。
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
 * ## 7.0.0：指引**永远**只给「建小组长」这一条
 *
 * 6.0.0 曾按 `delegationHierarchy` 在"Team 指引"与"2.x 的 specialist 指引"之间切换。
 * 7.0.0 起这是**不可配置的硬规则**：`workflow` / 名册一次性专家 / Worker Session 对指挥官
 * 都是硬门禁拒绝，所以拒因里**不得**再出现"用 `subagent_<id>` / 用 `workflow`"这类直调
 * 指引 —— 否则模型照做会撞上另一条门禁，白烧一轮（3.0.0 踩过的 P2 矛盾）。
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

  // 第二步：派发。**唯一**通道是建小组长（7.0.0 硬规则）。
  // 一次性专家工具名是动态的（`subagent_<id>`），这里不收集、不点名 —— 它们归小组长。
  const canSpawnLead = has('subagent') || has('subagent_fork');
  const leadTool = has('subagent') ? 'subagent' : 'subagent_fork';
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
  }

  // 第三步：任务板（可选通道，只在真有的时候提）。
  if (has('team_task_create')) {
    steps.push('3) 或者用 `team_task_create` 建任务、`team_task_update` `action:"reassign"` 指派 owner，再派发。');
  }

  // 一条派发路径都没找到时，给逃生口（不是让模型去换通道）。
  const tail =
    steps.length > 1
      ? '如果你认为这一步确实必须由你自己完成，请向用户说明理由并请他决定。'
      : '本模式下你没有可用的派活通道：请把要做的事连同验收判据写进正文，请用户决定——**不要自己动手，也不要换通道**。';

  const lines = [
    `指挥者模式：你不自己执行 \`${toolName}\`。`,
    '本模式下所有"执行操作"都必须派给子代理：写文件、跑命令、装依赖、删东西，**以及远程执行（`ssh_*`）、'
      + '桌面注入（`desktop_*`）、浏览器操作（`browser_*`）、模拟器控制（`android_*`）、持久终端（`terminal_*`）**。'
      + '指挥者只做分析、规划、拆分、派发与汇总；只读侦察（`read` / `grep` / 截图 / `ssh_host list` 之类）不限。',
    '现在请这样做（不要重试本工具）：',
    ...steps,
  ];
  // 明确告诉指挥官"那些通道不是给你的"（7.0.0 硬规则），否则它会继续找别的路。
  lines.push(
    canSpawnLead && has('send_message')
      ? '团队活交给小组长（`subagent` / `subagent_fork` 建人 + `send_message` 续做）：子任务由小组长再派给它的手下。'
        + '**不要换通道**——`workflow`、名册生成的一次性专家工具（`subagent_<id>`）、Worker Session（`commander_worker_*`，7.0.1 起实现已删除）都不是指挥官的通道，调用会被硬门禁拒绝。'
      : '**不要换通道**——`workflow`、名册生成的一次性专家工具（`subagent_<id>`）、Worker Session（`commander_worker_*`，7.0.1 起实现已删除）都不是指挥官的通道（它们只属于小组长），调用会被硬门禁拒绝。',
  );
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
