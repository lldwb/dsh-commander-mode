# dsh-commander-mode

DeepSeek Harness（dsh）的**一个模式**（agent preset）加**一个可选工作流组件**：
**指挥者模式**。指挥者接单、只读侦察、按任务形状拆分，把执行全部派给**小组长**
（可续做的标准 `subagent`，它可以自己执行，也可以再交下级子智能体），然后逐项验收；
**它自己不执行任何改变状态的操作**。

适合的场景：你只想做判断与决策，希望有人替你拆分、派活、盯进度、逐项验收；同时要求
这些边界**不是靠提示词自觉**，而是有确定性门禁兜底——越权调用会被直接拒绝并给出纠正指令。

**一句话**：你只做判断，小组长做执行；流程按任务形状定，不套模板。

```text
30 秒上手
1) 插件页安装本包，重启桌面版
2) 新建会话，模式菜单选「指挥者模式」（另有「指挥者 · CC 模式」：小组长改派 Claude Code 会话）
3) 把任务丢给它 → 只读侦察 → 按任务形状拆 → 用 ask_user_question 让你确认计划
   → 建任务板 → 派给小组长 → 逐项验收；需要完整交付链时让它加载 skill project-dev-workflow
   （想调专家？设置 → 插件 → 指挥者专家名册：增删、改定位、绑模型、一键恢复预置）
```

- 仓库：<https://github.com/lldwb/dsh-commander-mode>（公开）
- 许可：[MIT](./LICENSE)

## 加载方式

加载方式：按需（挂载点：声明「指挥者模式」agent preset——5 个工具与 3 个提示词 section 都在 preset 内，宿主行只做事件队列/门禁；未选中该模式时不加载这些工具）

> 加载方式是 DSH 插件开发的必答项（工作区约定 §10.0）：按需的必须有入口与退路，
> 常驻的必须写理由。这条标记行供人工审阅与将来做门禁。

## 它做什么

在输入框上方的模式菜单里选中「指挥者模式」后，当前会话的 agent 变成**指挥者**：

| 它做 | 它不做 |
|---|---|
| 只读侦察（`read` / `glob` / `grep` / `web_search`） | 写文件、改文件（`write` / `edit`） |
| 规划与拆分、维护 `todo_write` | 跑命令（`pwsh` / `bash`） |
| 建任务板、派发给小组长（`subagent` / `subagent_fork`） | 杀作业（`job_kill`） |
| 结算后三同步：任务板 / 计划清单 / 团队状态 | 装插件（`plugin_manager`） |
| 读状态（`list_agents` / 任务板）、核对验收判据 | 替用户拍板 |
| 用 `ask_user_question` 让用户确认计划、上报分歧 | |

「指挥者不执行操作」有**两道**保障，一道概率性、一道确定性：

1. **协议**（system-prompt section，`order: 650`，每轮重新求值）——告诉模型它是指挥者、
   该派活。它不会被遗忘，也不会被上下文压缩掉。
2. **门禁**（`tools/pre-execute` waterfall）——指挥者自己调用执行类工具会被**直接拒绝**，
   拒绝理由就是纠正指令（"先用 `ask_user_question` 确认计划 → 派给小组长"）。

门禁挂在 preset scope 上，所以**只对指挥者模式下的 agent 生效**，别的模式完全不受影响。

**两次必须问用户**（写进协议）：

1. **规划/拆分完成后**——必须停下来用 `ask_user_question` 把计划摆给用户，问是否有问题、
   是否需要调整。**用户确认之前不派任何活**。
2. **出现分歧或不确定时**——小组长之间结论冲突、需求有歧义、必须做取舍、
   要动高风险的东西、小组长报回 BLOCKER，都交回用户选。

## 两个模式

模式菜单里有两个条目，**组合完全相同**（同一份能力行 + 同一份协议 + 同一套门禁与工单），
差别只在**小组长那一层的下级**：

| | 指挥者模式（`commander`，`order: 7`） | 指挥者 · CC 模式（`commander-cc`，`order: 8`） |
|---|---|---|
| 指挥官（L0） | `subagent` / `subagent_fork` 建小组长 | **一样** |
| 小组长（L1）的下级 | `subagent` / `subagent_fork` 建 DSH 子智能体（可 `send_message` 续做、可读任务板）、`workflow` 扇出、名册一次性专家 `subagent_<id>` | `subagent_claude_code` 派 **Claude Code 会话**（一次性、不可追问、不可续会话） |
| 小组长能自己 `write` / `edit` 吗 | 能 | **不能**：活要交给 CC，自己只写任务书 + 验收 |
| 深度 | 最大 2 | 小组长之后是外部 CLI，**没有 DSH 深度** |

**CC 模式的前置条件**：需要启用官方 **Claude Code 子智能体** bundle（提供
`subagent_claude_code` 与 `claude-code` provider）。没有启用时协议与小组长 brief 都会点名
告警（"没有检测到 `subagent_claude_code`"），不会让小组长空转。另外，CC 执行者跑在
`permissionMode: dontAsk` 下时 `Write` / `Bash` 会被权限拒绝、任务零产物——要在
「设置 → 插件 → Claude Code 子智能体」把 `permissionMode` 调成 `acceptEdits`（可写文件）
或 `auto`（原生分类器判定）。

**CC 模式不适合的活**：需要多轮澄清、需要中途改方向、需要读任务板/工单的任务——CC 会话
没有回问通道（`AskUserQuestion` 被禁用、权限提示一律拒绝）。这种活要么拆成一轮自包含
任务，要么换回原生模式。

**CC 产能纪律**：能整块写成一份自包含任务书的活不要切碎（CC 之间看不到彼此）；
派活时写清"这一单由 CC 执行、产出怎么验收、要不要原始输出"；并行只留给确实独立的块。

## 三层指挥链：指挥官 → 小组长 → 子智能体

### 三层职责

- **L0 指挥官**（主会话 / Lead）：目标、拆分、派单、验收、与用户沟通。它不执行操作，
  也不越过小组长用别的通道派活（`workflow` / 一次性专家 / Worker 通道对它是硬门禁）。
- **L1 小组长**（`subagent` / `subagent_fork` 建出的具名子代理，可续做）：各背**一个团队任务**，
  可以**自己执行**（它继承同一 preset scope，有写文件与跑命令的能力），也可以把子任务交给
  **下级子智能体**；**任务进展与排期由它写**。L1→L2 不受派发通道硬门禁限制。
- **L2 子智能体**（小组长派出的 `subagent_<id>` / `subagent` / `workflow` 子代理）：只负责执行，
  **不再向下派**（运行时递归深度上限 2）。

### 团队形状：一条任务链默认 1 位小组长统筹

**判据是「这件事是否服务于同一个下游目标」**，不是"能不能并行"，也不是"每份产出是不是
独立文件"（A 写报告、B 写清单，只要都喂给同一次根因定位/修复/发版，就是同一条工作流的切片）。

计划里的 A/B/C/D/E 是**阶段**，不是小组长数量：由一位统筹小组长扇出子智能体跑各阶段，
**扇出者负责扇入**。只有产出彼此独立**且不喂给同一个下游目标**、或需要**独立视角**角色
（审查 / 测试 / 安全，必须与被审对象并列）时才拆多个并列小组长。

自检问题：拆成 N 个小组长之后，若还得有人对"整体结论"负责——那个人就该是统筹的小组长，
不该拆。

**并行还是串行是技术判断**：先核实写作用域是否真的不冲突、有没有真实依赖，自己决定，
不要拿这个问题去问用户。

### 运行限制

- **最大递归深度 2**：`subagent.maxDepth = 2`。小组长是 L1、子智能体是 L2；L2 再向下派会被
  运行时拒绝，硬试只是白烧轮次。
- **并行上限由宿主决定**：`subagent.maxActiveSubagents`（DSH 0.2.2-rc.2 默认 **8**）。
  互不依赖的工作流各开一个小组长并行推进；**真到上限才排队或复用**，不要因为"怕撞上限"
  提前串行化。配置项 `maxTeammates` 只是**写进协议的建议值**，插件不自己压低真实上限。
- 这两个数字写在协议正文里（模型读不到运行时配置）：文本与运行时不一致时以本节口径为准。

### 完成语义：子未完成 ≠ 父完成

小组长的"完成"只由它的下级收尾来证明：子智能体还有 `running`、失败、或产物没回填，
它的交付就还缺件，只能报 `progress` / `blocked`。`STATUS: progress` ≠ `ready`。

这条有确定性门禁兜底（`evaluateTicketSettle`）：工单 `done` 时若小组长子树里还有 `running`
的行，`commander_ticket_update` 会被直接拒绝并给出纠正阶梯；门禁只认正面证据，
读不到就放行。

### 重启后续做

宿主重启/崩溃时正在跑的小组长与子智能体被 `dispose`——**会话还在磁盘、Agent 没了**。
指挥官下次被唤醒时如果看到"空团队"，很自然会再建一批：同一份活做两遍。

所以每轮运行时上下文里，若本会话有**离线但仍在册的可续做下级**
（`subagents.listDescendants()` 里 `kind=child`、`depth=1`，用 `agents.get()` 判在线），
插件就列出名单 + 会话 id，并给出处置顺序：

1. `session_resume_subagents`（先 `dryRun: true` 看清单）→ **只 resume 没做完的**；
2. 没有可复用的才新建；
3. 新建时写清「上一棒是谁、做到哪、产物在哪」。

**离线 ≠ 被中断**：正常做完的子代理也会离线，所以插件**只报事实**（"你有 N 个离线下级"），
不替模型断定谁被中断——已完成并结算的不需要 resume。没有离线下级时**一个字都不输出**；
部署里没有 `session_resume_subagents` 时提示换成"不要另开一批做同一件事，先问用户"，
并且不点名一个不存在的工具。

## 确定性门禁

门禁都在 `tools/pre-execute` 上，挂在 preset scope 里，**只影响本模式**。
下面的"能否配置"列就是全部可调范围——写"无开关"的门禁没有任何配置项能放开。

| # | 门禁 | 拦什么 | 能否配置 |
|---|---|---|---|
| 1 | 执行边界（`evaluatePreExecute`） | 指挥者调用"会改变状态"的工具（见下表） | `blockedTools` |
| 2 | 禁止等待（`evaluateWaitForbidden`） | `wait_agent`——**整条链**无条件拒绝，传什么 `timeout_ms` 都一样 | 无开关 |
| 3 | 禁止轮询（`evaluatePollingGuard`） | 同一回合内反复读状态：`list_agents` / `team_task_list` / `team_task_get` / `commander_tickets` 累计超过 4 次即拒绝 | 无开关 |
| 4 | 派发通道硬门禁（`evaluateCommanderChannels`） | 指挥者调用 `workflow`、名册一次性专家（`subagent_<id>`）、`commander_worker_*` 前缀 | 无开关（`delegationHierarchy: false` 也拦） |
| 5 | 任务板写入（`evaluateBoardWrite`） | 指挥者调 `team_task_update` 的 `claim` / `release` / `complete` / `reopen` / `set_dependencies`（`reassign` / `edit` / `delete` 仍由指挥官做） | `delegationHierarchy` |
| 6 | 工单推进状态（`evaluateTicketWrite`） | 指挥者用 `commander_ticket_update` 报 `progress` / `waiting` / `ready` / `blocked` / `failed`（`done` / `cancelled` 仍是指挥官的验收动作） | `delegationHierarchy` |
| 7 | 结算门禁（`evaluateTicketSettle`） | 工单 `done` 时小组长子树里还有 `running` | 无开关 |
| 8 | 派发门禁（`evaluateDispatchGate`） | 没有计划授权 / 不带工单 / 工单不属于本会话或建立在旧授权下 / Team 通道缺任务板投影 | `requireMandate` / `requireTicket` / `requireTeamTask` / `requireTeamTaskMarker` |
| 9 | 重复建小组长（`evaluateDuplicateLead`） | `subagent` 的定位与已知小组长定位最长公共子串 ≥ 4 字（同功能的活应 `send_message` 复用，inactive 也能冷恢复） | 无单独开关 |
| 10 | CC 委派门禁（`evaluateCcDelegation`） | **只拦子级**：CC 模式下小组长调用 `subagent` / `subagent_fork` / `workflow` / 名册专家 | 仅 CC 模式，无开关 |
| 11 | CC 执行归属（`evaluateCcExecution`） | CC 模式下小组长的 `write` / `edit` / `apply_patch`；`read` / `grep` / `glob` / `pwsh`（只读命令、跑测试、看 diff）**仍放行** | 仅 CC 模式，无开关 |

`delegationHierarchy: false` 只关闭第 5、6 两条（回到"只靠协议"），**放不开**第 4 条。
第 1 条另有一条逃生门：如果真的一件可用派发工具都没有（连 `subagent` / `subagent_fork` /
`send_message` 都被禁），执行边界会放行你自己动手，避免"既不能动手也不能派活"的死锁。

### 执行边界：什么算「执行操作」

判据不是"是不是本地文件操作"，而是**"会不会改变工作区 / 宿主 / 外部系统的状态"**。
默认拦截 **55 项**：

| 类别 | 工具 |
|---|---|
| 本地执行 | `write` `edit` `pwsh` `bash` `job_kill` `plugin_manager` |
| 远程执行 | `ssh_exec` `ssh_job` `ssh_upload` `ssh_download` `ssh_fetch` |
| 桌面注入 | `desktop_mouse_move` `desktop_mouse_click` `desktop_mouse_drag` `desktop_mouse_scroll` `desktop_key_press` `desktop_type_text` `desktop_ui_invoke` `desktop_ui_set_value` `desktop_window_focus` |
| 浏览器改动 | `browser_connect` `browser_disconnect` `browser_navigate` `browser_click` `browser_type` `browser_fill` `browser_press_key` `browser_hover` `browser_drag` `browser_upload_file` `browser_handle_dialog` `browser_evaluate` `browser_close_page` |
| 模拟器控制 | `android_avd_create` `android_emulator_start` `android_emulator_stop` `android_apk_install` `android_app_launch` `android_app_stop` `android_ui_tap` `android_ui_swipe` `android_ui_input` `android_ui_key` |
| 持久终端 | `terminal_open` `terminal_send` `terminal_signal` `terminal_close` |
| 仓库状态 | `create_worktree` |
| 沙箱执行（devkit） | `devkit_sandbox_create` `devkit_sandbox_install` `devkit_sandbox_run` `devkit_sandbox_destroy` `devkit_ui_open` `devkit_ui_act` `devkit_ui_close` |

**只读侦察不受限**（不在清单里）：`read` / `glob` / `grep` / `read_image` / `web_*` /
`skill` / `session_*`、`ssh_host`、`desktop_screenshot` / `desktop_screen_info` /
`desktop_ui_dump` / `desktop_windows_list`、`browser_status` / `browser_snapshot` /
`browser_screenshot` / `browser_console` / `browser_network` / `browser_list_pages` /
`browser_ping` / `browser_wait_for`、`android_status` / `android_screenshot` /
`android_ui_dump` / `android_ui_wait` / `android_logcat`、`terminal_read` / `terminal_list`、
`job_output` / `job_list`、`devkit_status` / `devkit_sandbox_list` / `devkit_sandbox_compose`、
以及全部调度与任务板工具。

**为什么不干脆把 `write` 从 preset 里裁掉**：裁不掉，这是硬约束。子代理通过
`agentPresets.composeFrom()` 加入**父会话的同一个 preset scope**，而 per-child 的工具限制
只能**收紧**、不能扩展。一旦把 `tool-fs` / `tool-pwsh` 从 preset 里删掉，小组长与子智能体
也会一起失去这些能力，模式就彻底干不了活了。所以能力行必须保留，边界落在"**谁可以调用**"
这一层——这也正是 `tools/pre-execute` 存在的意义。

### 禁止等待、禁止轮询

`wait_agent` 在**整条链**上被硬禁用：指挥官、小组长、子智能体一视同仁（身份读不到也拒绝）——
**不要等下级，也不要等上级**。没有 `maxWaitMs` 之类的开关，传什么 `timeout_ms` 都没用，
不存在"短等"与"超时"这两个动作。

同一回合反复读状态也会被拒（`list_agents` / `team_task_list` / `team_task_get` /
`commander_tickets` 超过 4 次）：那是"等"的另一种写法，只是额外烧轮次。拒因给两条路——
**推进**（`send_message` 追问/追加指令、`interrupt_agent` 纠偏、去干下一件可并行的活）或
**收尾**（一句话阶段汇报后结束回合）。

不等之后靠什么：

1. **完成通知会自己回来**：下级结算时用「【派工完成】」通知**主动唤醒**它的调用者；
   有在飞下级时**不得结束回合**，没有才可收尾等外部输入。
2. **要看状态**：`list_agents` / `team_task_list` / `team_task_get`（读一次，不挂起）。
3. **要推进**：`send_message` 追问或追加指令；疑似停滞用 `interrupt_agent` 纠偏或换人。
4. **没有可推进的事**：给用户（或上级）一句话阶段汇报并结束回合，等通知唤醒。

**派活时要把这条写进 prompt**：小组长也不许等它的下级——不写这句，它那一层就等于没生效。

### 判错方向：宁可漏拦，不可拦死

门禁最怕的不是漏拦，而是**拦到子代理**。所以 `lib/guard.js` 里每个"拿不准"的分支都走放行：

- 读不出 agent 身份（没有 `session.header`）→ 当作子代理，放行；
- 判定过程抛错 → 放行，并让工具调用继续；
- 确认是**指挥官本人**时，第 4 条硬门禁一律拒绝，但身份读不到同样放行
  （拦错小组长会让 L1→L2 断链；指挥官的身份在真实运行时总是可读的）。

**唯一的两个例外**是「禁止等待」与「禁止轮询」：它们不按身份判定、也不"拿不准就放行"——
理由是等待不是完成工作所必需的动作，拦错的代价只是少一条捷径。

身份判别的三个证据都来自 `childSessionMeta()`：`header.parentSession`、
`header.origin === 'subagent'`、`header.delegationDepth > 0`。

## 看板与告警

看板是**每轮运行时上下文**（`systemPrompt.context`，与用户请求同一条消息）里的确定性文本，
比 section 的遵从率高得多。四个部分：

- **同步看板**（`syncGuard` 控制）：任务板几项已结算 / 谁还没结算、计划清单完成度、
  每个成员 running 还是 inactive；有未同步项时直接给 `todo_write` / `send_message` 指令。
  任务板进展由**小组长**写，指挥官只核对。
- **工单看板**：计划授权状态、进行中工单、待验收 / 受阻 / 失败 / 停滞 / 等你回答的项与下一步
  动作；优先级 = 等你回答 > 受阻 > 失败 > 待验收 > 停滞 > 进行中，最多列 6 项；
  没有工单且没有授权时**不产生任何文本**（安静默认）。
- **执行者看板**：被委派的小组长 / 子智能体也拿到自己的看板（并行度、下级状态），
  否则"规则只放指挥官那一层"等于只治症状。
- **长会话体检**：定期把"规则漂移"摆到眼前（规则每轮重注入、用户消息不会被剪，
  所以退化不是"忘了"而是"漂移了"）。

回合还没结束就还有未同步项时，`agent/turn-stopping` 会注入一次提醒（每回合最多一次）。

### 13 类看板告警

| code | 含义 |
|---|---|
| `plan-stale` | 任务结算发生在计划清单最后一次更新之后 |
| `board-open-plan-closed` | 计划清单说全做完了，任务板还有未结算任务 |
| `plan-missing` | 任务板已有结算项，但**从未**写过计划清单（弱提醒，不拦回合） |
| `board-stale-open` | **孤儿任务**：未结算、无人认领或主人已停手，且超过宽限期 |
| `channel-drift` | **团队闲置**：任务板还开着，最近几次派活却全走一次性 specialist（不拦回合） |
| `all-idle-stalled` | 全员 inactive 但板上还有活——不会再有通知唤醒你 |
| `ticket-backlog` | 工单积压（太多未结算的单子同时开着） |
| `ticket-created-not-dispatched` | 建了单但没派活（超 2 分钟仍无 assignment，且不在等用户） |
| `fan-out-unused` | 小组长独干：明明可以派下级却全部自己扛 |
| `scope-conflict` | 同一批文件被多个工单声明为写作用域 |
| `parallel-underused` | 并行度不足：本可并行的活被串行推进 |
| `starved-ticket` | **多线并行时被冷落的线**：另一条工单在推进，这条超过 25 分钟没被碰 |
| `dispatch-focus` | 派活过度集中：长期只推同一个小队长，把并行做成串行 |

每条告警都设计成**可被行动消除**（去更新那条线、去派活、去结算，它就会消失），
不会变成永久噪音。

## 看门狗与唤醒链

只补"检测"是不够的：告警的可见性建立在"agent 正在运行"这个前提上，而停下来恰恰是
"它不运行"。所以插件自己补了唤醒机制。

### 停滞看门狗（`stallWatchdog`）

空闲、没有在飞下级、账本里却还有未结算活 → 插件**主动唤醒指挥官一次**（`steer`）。
这是插件在投递唤醒，不是让 agent 自己轮询。宽限期刻意短：90 秒；"回合刚结束 + 还有 open
工单 + 没有下级在跑"这个最强停滞信号是 15 秒。小组长侧只有一个判据：**有代投通知就立即
唤醒**，不等宽限——它的活由指挥官派，不替它判断"有活没活"。看门狗**只提醒，不自动改状态**。

### 通知补投与冷唤醒

运行时的结算通知在父级回合不在跑时会**静默丢弃**（既不生成、不排队、也不唤醒）。插件的
补救分三层：

1. **入队 + 补投**（`lib/pending-notices.js`）：送不到的通知入账本队列（同一子会话只留一条、
   TTL 6 小时、上限 20 条），父级下次渲染上下文时补投并清空，不重复轰炸；会话开场 /
   被冷唤醒时也会主动投一次。
2. **冷唤醒**（`lib/wake-chain.js`）：父级不活时不再放弃——L1 活父级就 `steer`；
   L2 拿不到活父级就 `sessionController.prompt()` 冷唤醒父会话；L3 因 subagent ownership
   失败时沿父子链上溯到 root 指挥者投一条极短升级通知。同一 childId 只唤醒一次，
   全程 fail-open（失败只记日志，通知仍在队列里等下次醒来）。
3. **结束回合条件化**：有在飞下级时不得结束回合；`agent/turn-stopping` 对被委派的 agent
   额外看一次成员快照，仍有 `running` 下级就注入 advisory（不硬拦、同 turn 一次）。

### 退化输出看门狗（`degenerationGuard`）

模型陷入重复循环（例如 `Emit. Now. OK.` 无限重复、或反复对自己说"现在发工具调用"却真的
不发）时，**在生成中途掐断**当前回合，并把"改用工具、长文档分段写、不要复述计划"的说明
排给下一回合：`agent.cancel({ kind: 'hook', reason: 'degeneration' }, { keepInbox: true })`。

判据：末尾**连续重复** ≥ 20 次（≥ 8 字符单元）+ 周期搜索（末尾连续 3 个周期全等），
只取语义明确的正文增量（不拿 frame 元数据当正文），**宁可漏报不可误报**。
另加**熔断**：60 秒内最多掐 3 次，超过只 warn 不再 cancel，交给 `max-tokens` 自然收场
（连掐不会让任务变好，只会烧预算）。

## 工单、计划授权与账本

把"派活"从一段文本变成**有状态、可审计、可恢复**的工单。三个工具：

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `commander_ticket_create` | 建工单 | `title`（必填）、`intent`、`acceptance`（验收判据数组，建议至少一条）、`scope`（写作用域，只是提示不是锁） |
| `commander_ticket_update` | 改状态 / 结算 / 改描述 | `status`（`progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` 六态回报，外加 `done` / `cancelled`）、`reason`、描述字段 |
| `commander_tickets` | 只读列出当前会话的工单 | 返回工单的当前状态与 `updated_at` 等字段 |

`commander_ticket_create` 的返回不只是工单本身：还带 `mandate_pending`（本会话是否还没有计划
授权）、`mandate_required`（当前部署是否要求授权）与一段 `note`（下一步该做什么）；
装了 Agent Teams 时另有 `team_task_id`（派发时在 prompt 首行并列写 `[ticket:t-N] [task:task-N]`）。
刚建单的返回里 `note` 会明确写「下一步必须派活」，因为**建单不等于派活**。

**闭环**：

1. **计划确认有固定格式**：必须用 `ask_user_question`，问题 id 精确写成 `commander-plan`，
   选项第一项 label 精确写成「确认，开始执行」，第二项「需要调整」。只有选中第一项
   （或自定义答案以"确认"开头）才算拿到**计划授权（Mandate）**。
2. **建单即派**：计划确认后，每一项要交付的活用 `commander_ticket_create` 建工单，
   **建单后必须在同一回合内完成派活**（`team_task_update action:"reassign"` + `send_message`，
   prompt 首行写 `[ticket:t-N]`）；做不到就在回复里说明为什么先不派。一张工单可多次派发
   （实现 / 返工 / 审查）。
3. **回报必须结构化**：执行者（小组长）最终答复最后一行写
   `STATUS: progress|waiting|ready|blocked|failed|dropped`，并用 `commander_ticket_update`
   回报推进状态；指挥官只核对、验收后才 `done` / `cancelled`。
4. **Team 通道**可另带 `[task:task-N]` marker（`requireTeamTaskMarker` 默认关，
   投影已由插件自动建立，强制模型复述 task id 只会增加一轮重试）。

**账本**：

- 位置：默认 `<DSH_HOME>/commander/<profile>.json`；配置 `stateDir` 可改（相对路径以
  `DSH_HOME` 为基准；`.json` 结尾视为文件，否则视为目录）；
- 原子写（临时文件 + rename）、损坏 JSON 自动备份为 `*.corrupt-<时间戳>` 后用空账本启动、
  按会话隔离、最多保留 `maxTickets` 张（超出裁剪最老的已结束工单）；
- 只存工单 / 授权 / 派发 / 回报 / 通知这类状态事实；**不存**会话正文或子代理输出；
- 写盘失败降级为"内存继续 + warning"，绝不把工具调用弄挂；
- 同步账本会持久化看板状态（任务板镜像、计划快照、派活计数、小组长定位），
  重启后看板与"重复建小组长"门禁仍然有效；
- 关掉 `ledger: false` 时退化为"只有同步看板与协议"（没有工单工具、没有授权门禁）。

### 任务板投影

装了「智能体团队」时，每张工单会被**单向投影**成共享任务板上的一张任务：账本仍是权威，
任务板是它的可见层。投影任务描述的前三行是机器 marker：

```text
[commander:ticket=t-17]
[commander:channel=team]
[commander:status=working]

<intent>
## 验收判据
- ...
```

- **状态映射**：`open` → `pending`；`working`（Team 通道）→ `in_progress`；
  `waiting` / `review` / `blocked` / `failed` 保持原 status（真实状态见
  `[commander:status=...]`）；`done` → `completed`；`cancelled` → `deleted`。
- **自动绑定 owner**：`subagent` 成功后插件把投影任务 `reassign` 给该队友，
  "建板必有主"不再依赖模型自觉。
- **写作用域清洗**：工单的 `scope` 经 `sanitizeWriteScopes()` 清洗后才进板上 `writeScopes`——
  只接受工作区相对路径，绝对路径 / 空段 / `.` / `..` 段丢弃（运行时会拒绝这些值并抛
  `TEAM_INVALID_WRITE_SCOPE`）；丢弃不影响派发，工单本身保留完整 `scope`。
- **三条纪律**：板上的投影任务不要重复创建（模型自己建的旧任务会被**收养**，
  不会出现两份）；任务板只有 4 个状态，`review / blocked / failed` 以描述 marker 与
  「指挥者·工单看板」为准；改进度用 `commander_ticket_update`，直接改投影任务会被下次同步覆盖。
- **降级**：没有 `agentTeams` 服务 / 当前 agent 不是 Team 成员 / 方法缺失 → 全部 no-op，
  工单、门禁、派发照常工作。

## 专家名册（多模型 specialist）

名册里的每个 specialist 是一个独立工具（`subagent_<id>`）+ 一份独立 agent preset
（承载人设）。**这些工具归小组长使用**（L1→L2）；指挥官直调会被派发通道硬门禁拒绝。

出厂预置六位（按主流软件开发生命周期划分，装好即可派活）：

| id | 定位 |
|---|---|
| `architect` | 系统架构与拆分：需求拆解、技术方案、接口与数据模型设计（不直接写实现） |
| `implementer` | 代码实现：按既定方案写/改代码，补齐边界处理，产出可运行改动与自检结果 |
| `reviewer` | 代码审查：正确性、可维护性、风格一致性与潜在缺陷，按严重程度给意见 |
| `tester` | 测试：设计并补齐覆盖改动的测试，运行验证并报告明细，复现缺陷给最小步骤 |
| `security-auditor` | 安全审计：依赖漏洞、注入与越权、密钥与敏感信息泄漏、不安全默认值 |
| `doc-writer` | 文档：README、API 说明、使用与迁移文档 |

预置专家的 `provider` / `model` 是**空的**，语义是**继承指挥者（父会话）的模型**——不同
部署可用的模型完全不同，预置名册不能硬编码任何模型 id。想给某个专家绑定专属模型时，
在设置页把两栏都填上（两栏必须同时填或同时留空）。

于是同一个会话里，小组长可以把"实现"交给跑在小模型上的 `subagent_implementer`、把"审查"
交给跑在强模型上的 `subagent_reviewer`，而不是所有子代理都继承父会话的模型。

**专家是"一次性"通道**：没有持续对话、任务板、后台通知；要那些语义就用 Team 通道。
它也没有"问用户"的通道，遇到需要用户决定的事只能报回指挥者。

### 在设置页里调整名册

「设置 → 插件 → 指挥者专家名册」。**专家行默认折叠**（只显示 `id` + 模型路由与职责摘要），
点击标题栏展开编辑、再点收起。新增行会自动展开；点保存时若某行校验失败，出错行也会自动展开。

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9_-]{0,47}$`，名册内唯一；工具名就是 `subagent_<id>` |
| `provider` / `model` | 否 | 该专家的模型路由；**两栏都空 = 继承指挥者的模型**（要么都填、要么都空） |
| `description` | 是 | 展示给指挥者的职责摘要（= 定位），用来选人 |
| `persona` | 否 | 追加到该专家人设末尾的专属提示词（预置项都有） |
| `reasoningEffort` | 否 | 该模型支持的推理等级 |
| `maxTokens` | 否 | 该专家的输出上限 |

「**恢复预置名册**」按钮把草稿恢复成出厂清单——**只改草稿，仍需点「保存」才落盘**，
点「放弃」可还原。保存后**新会话**立刻拿到新的 `subagent_<id>` 工具；已打开的会话保持
启动时的名册。

名册条数上限 `maxSpecialists`（默认 20，每项 = 一个 preset + 一个工具）。专家 preset 不会
出现在模式菜单里：插件把它们从 preset 目录读取（`agentPresets.remoteExportList`）里过滤掉了，
**只隐藏目录条目，注册与挂载不变**，诊断通道仍能看到它们。

### 建议的小组长名字

`architect-lead`、`implementer-lead`、`reviewer-lead`、`tester-lead`、`security-lead`、
`doc-writer-lead`。小组长的定位写在它的 `description` 与 `prompt` 里；派活前先拿任务性质
去对（领域、产出类型、需要的技能）：落在定位内就派，差距大就换人或新开一位小组长
（`subagent` / `subagent_fork`），一个任务里混着两种定位就拆成两个任务。
**"这是另一类工作"必须换人**；顺带多做一点同领域的小事可以接受。

## 六段工作流（可选组件）

本模式附带可选组件 `dsh-commander-mode/workflow`：它**只注册一个 skill**——
`project-dev-workflow`，不注入常驻 prompt section。指挥者与专家小组长都可以用 `skill`
按需加载，**也可以只读需要的那一段**；不加载也能正常干活。

手册内容：每段的**目的 / 必做动作 / 必须落盘的产物 / 验收判据 / 失败返工规则 /
对应专家与团队用法**。

每段的专家小组长都可以把该段的子任务交给下级一次性专家（`subagent_<id>`，例如架构段
`subagent_architect`、实现段 `subagent_implementer`、安全段 `subagent_security-auditor`）。

| 阶段 | 对应小组长 | 产出 |
|---|---|---|
| 架构 | `architect-lead` | 需求 → 方案 + 任务拆分（写作用域、验收判据、依赖） |
| 实现 | `implementer-lead` | 按方案产出可运行改动 + 自检证据 |
| 审查 | `reviewer-lead`（**必须独立于实现者**） | 按严重程度给可定位意见 |
| 测试 | `tester-lead`（**必须独立于实现者**） | 真实执行用例并保留原始输出 |
| 安全 | `security-lead` | 按攻击面排查，带证据与风险等级 |
| 文档 | `doc-writer-lead` | 文档与最终实现一致，可直接照做 |

**它不是流水线**：不预设"每单必走六段"。发版打包、交接、单点修复、排障各有自己的拆法，
只有从零开发或大改造才值得按六段推进。

它同时是 **20 个方法 skill 的阶段索引**——这些 skill 在本包 `skills/` 目录里，
由 `skill-filesystem.config.customSkillDirs` 加载：

| 阶段 | 该用哪个 skill |
|---|---|
| 开工前 / 跨阶段 | `file-location-alignment`、`skill-router`、`repo-init`、`spec-route`、`project-explain` |
| 架构 | `task-commander`、`check-rule-extract` |
| 实现 | `feature-dev`、`bug-fix`、`refactor`、`code-optimize`、`comment-supplement`、`i18n-transform`、`module-batch`、`opencode-batch` |
| 审查 | `code-review` |
| 测试 | `unit-test` |
| 文档 / 收尾 | `doc-sync`、`app-packaging`、`session-summary` |

**边界**：skill 是工作方法，**不替代验收证据**。加载了方法仍要按该段的「必须落盘的产物」与
「验收判据」交证据；没有证据 = 这一段没做。工作流组件不持有配置、不注册工具、不读账本，
skill 注册失败只记 warning。

### 无论走不走六段都成立的硬要求

- 每个任务有**可观察的验收判据**，完成必须有**落盘证据**；
- 需要独立审查或独立测试的必须派**独立于实现者**的小组长；
- **不为了走流程制造依赖**（不要为了"顺序"给每张任务加 `blocked_by`）；
- 每个任务结束三件事：git 分类提交（**未提交视为该任务未完成**）、任务板结算
  （由该任务小组长 `complete`，指挥官只核对）、证据归档；
- 最终汇报列提交分类与短哈希、是否还有未提交内容；
- 不做人日 / 人天 / 工期估算：用「步骤 + 验收判据 + 依赖」表达计划。

## 插件开发：通过预设组件接入 dsh-plugin-devkit

preset 是**完整组合**——一个模式能拿到什么，只取决于它自己的 `config.plugins`。
devkit 的 patch 只能按 id 覆盖创造模式（`preset-cordis`），也无法把行插进本包的 preset
（`insert` 只对 `group: true` 的行有效），更不该把 `devkit_*` 挂成全局行（那会让标准模式等
所有模式泄漏沙箱工具）。所以链路是「提供方声明、消费方发现」：

1. devkit 在自己的 `package.json` 里**声明**预设组件：
   `dsh.presetComponent = { id, module, skillDirs }`；
2. 本包在声明 preset 前用 `lib/preset-components.js` 从 Loader 起点（`ctx.baseUrl` = profile
   目录的 file URL）解析它，把 `module` 这一行追加到组合末尾、把 `skillDirs` 并进
   `skill-filesystem.customSkillDirs`；
3. 于是指挥者模式的 scope 里就有：10 个 `devkit_*` 工具、`devkit:workspace-conventions`
   prompt section、以及 devkit 的三个开发 skill（`dsh-plugin-development` /
   `dsh-plugin-settings-page` / `dsh-plugin-debugging`）。

**它是软依赖**：devkit 没装 / 不在 `dsh.profile.bundles` / 清单字段不合法 / 入口解析不到 →
跳过并 `warn`，指挥者模式照旧声明。发现逻辑 fail-closed——preset 的实例审计是"一行挂不上
⇒ 整个模式判坏"，所以宁可少一个组件，也不能把注定挂不上的行塞进来。

**指挥官自己仍然不执行**：devkit 的执行类工具已补进默认 `blockedTools`（见「执行边界」表）；
只读的 `devkit_status` / `devkit_sandbox_list` / `devkit_sandbox_compose` 放行。
小组长 / 子智能体不受 `blockedTools` 影响，照常能用全套。

**怎么确认挂上了**：`preset_audit { preset: "commander" }` 应出现
`dsh-plugin-devkit/preset-component` 行，工具集里有 10 个 `devkit_*`；新会话里调
`devkit_status` 应看到 `conventionsSection` 为 `devkit:workspace-conventions`。
插件页的「包含的组件」**看不到**这一行——预设子行是运行时挂载的 fiber，不在 Loader 的
entry 树里，别用插件页判断"挂没挂上"。

## 智能体团队

Team 成员就是**可续做的标准 subagent**，所以建人/续做用的是标准工具：

| 动作 | 工具 |
|---|---|
| 建小组长（不继承对话） | `subagent({ name, description, prompt })` |
| 建小组长（继承已完成轮次） | `subagent_fork({ description, prompt })` |
| 续做 / 追加指令 | `send_message({ agent, message })`（`agent` 用 `list_agents` 里的名字） |
| 看整棵树 | `list_agents({})` |
| 纠偏 | `interrupt_agent({ agent })` |
| 共享任务板 | `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` |

四个 `team_task_*` 由 base bundle 提供，不在 preset 里声明。`agent-team` 只接受
`maxTasks` / `defaultEnabled` 两个键（旧键会抛 `TEAM_INVALID_CONFIG`）。

### 团队默认启用且不可关闭

本模式的三层指挥链完全建立在 Team 上，而 Team 模式是按根会话选择的（`team/mode` 事件），
新会话默认关闭——所以插件**强制开启**，三条通道缺一不可：

- **创建即开启**：`agent/created` 里，对根 agent 且当前 preset 是本模式家族的会话调用
  `agentTeams.setEnabled(agent, true)`（当前 preset 优先读 `agentPresets.presetForSession()`
  的投影、回退 `session.header.agentPreset`）；
- **切到本模式即开启**：输入框里切模式走 `agentPresets.select(liveAgent, …)`，
  **不会**产生新的 `agent/created`，所以还要监听 `session/event` 的 `agent-preset/selected`；
- **被关掉即重开**：监听 `session/event` 的 `team/mode`，本模式会话出现 `enabled: false`
  时立刻重开并记日志。

**没有任何"关闭团队"的配置项**——这是硬约束，不是可调选项。两个模式（原生 / `*-cc`）
都覆盖。`agentTeams` 是硬依赖：读不到时记 `error` 日志，不静默降级。

## 外部事件接入

外部系统（CI、告警、Issue 评论、定时巡检结果）可以把事件**推进**指挥者会话——空闲的
指挥者会被唤醒，不需要人先说话。

```powershell
node <本插件目录>\bin\commander-event.mjs --profile desktop `
  --ticket t-3 --kind ci-failed `
  --summary "build #42 失败：test/auth 3 个用例" `
  --detail "https://ci.example.com/builds/42" --source github-actions
```

- 路由用 `--ticket`（反查该工单所属的指挥者会话）或 `--session`（直接指定会话，优先）；
- `--id` 可指定事件 id，让"至少一次投递"的外部系统重试时保持幂等（重复写入只算成功、不覆盖）；
- `--list` 列出待投递事件；`--json` 机器可读；
- 退出码：`0` 已写入/列出，`2` 用法错误，`1` 写盘失败。

事件落到 `<账本所在目录>/events/inbox/<id>.json`（空 `stateDir` 时 =
`<DSH_HOME>/commander/events/`）。插件每 `eventPollMs`（默认 15 秒）扫一次：能路由到会话
就投递（`steer`，空闲会话会被唤醒），成功移进 `delivered/`；格式坏了移进 `rejected/`；
目标会话暂时不在就**留在 inbox 等下次重试**——不会静默丢事件，待投递数量在
`commander-status` 的 `events_pending` 里可见。

事件文件就是契约（外部系统也可以直接写文件）：

```json
{
  "version": 1,
  "id": "evt-1793787000000-ab12",
  "kind": "ci-failed",
  "summary": "build #42 失败：test/auth 3 个用例",
  "detail": "https://ci.example.com/builds/42",
  "ticket": "t-3",
  "source": "github-actions",
  "createdAt": 1793787000000
}
```

`kind` / `summary` 必填；`ticket` 与 `session` 至少一个。指挥者收到的是
「【指挥者·外部事件】…」，消息里明确写着**这不是用户消息**，要它先只读核对再决定
（更新工单 / 派活 / 标记受阻），需要用户决定时用 `ask_user_question`。

典型接法：CI 失败分支跑一条 `commander-event`（没有 dsh 凭据也能跑——事件只是文件）；
Windows 任务计划程序定时检查健康端点，失败时写一条 `kind: alert`；用 DSH 的定时任务
（`schedule_create` / `schedule_edit`）在日常 profile 里定时跑一条命令并把结果写成事件。

**边界**：投递需要 dsh 进程在跑（文件是队列，不是守护进程）；只投递给**已存在 / 可恢复**
的会话，不会新建会话或工单；不做鉴权（能写这个目录就等于能指挥，单机场景可接受，
多用户/共享目录部署要自己限制目录权限）；`eventInbox: false` 可整体关闭。

## 运维巡检

账本是文件，所以可以在**指挥者进程之外**巡检：

```powershell
node <本插件目录>\bin\commander-status.mjs --profile desktop
# 或指定账本文件：--ledger <path>；机器可读：--json；停滞阈值：--stall-minutes 10（或 --stall-ms 600000）
```

| 退出码 | 含义 |
|---|---|
| `0` | 没有未结束工单（空闲） |
| `1` | 有未结束工单，但没有待人工项（在跑） |
| `2` | 有待人工项（待验收 / 受阻 / 失败 / 等回答 / 停滞）——需要人 |
| `3` | 账本不可读（损坏 / 读失败 / schema 不支持）——需要人检查 |

`--json` 输出含 `ledger` / `open` / `tickets` / `attention` / `events_pending`。
它**只读**：不写账本、不清理、不备份损坏文件，适合被 schedule / 任务计划程序 / CI cron 调用，
按退出码决定"沉默 / 提醒 / 报告"。

定时巡检配方（可选，不自动改状态）——在**你日常用的 profile**（不是指挥者会话）里建一个
定时任务，提示词示例：

```text
检查指挥者账本：运行
node <本插件目录>/bin/commander-status.mjs --profile desktop --json
退出码 0：什么都不说。
退出码 1：只说一句"指挥者在做 N 项"。
退出码 2：把 attention 明细逐条列出来提醒我。
退出码 3：报告账本损坏，让我检查（不要自己改账本）。
不要自动重启 dsh，不要修改或删除账本。
```

**不要把巡检放进被监督的指挥者进程**：进程挂掉时它也不会跑。

## 安装

```powershell
# 桌面版：用 plugin_manager 工具安装本目录（把 <本目录> 换成你 clone 下来的绝对路径）
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }

# 或命令行
dsh plugin --profile desktop add -w <本目录的绝对路径>
```

⚠️ **依赖必须自己装一次**：`dsh plugin add` 对本地目录用 `link:` 安装，**不会**给被链的包
装依赖。本包需要 `@deepseek-ai/schemastery` 在自己 `node_modules` 里（profile 下解析不到
随附包）：

```powershell
cd <本目录>
pnpm install     # 或 node <dsh>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs install
```

**装完必须重启桌面版**：preset 与协议文本都在启动时注册，热挂载不会让新模式出现。
模式在**新会话**里选择，已有会话的 preset 在第一轮之前就已绑定。

本包自带**等效的 preset 声明器**（`dsh-commander-mode/preset-commander`，实现见
`lib/preset-declaration.js`，语义等价于随附的 `@deepseek-ai/dsh-agent-preset`），只依赖随附的
`agentPresets` 服务。所以**随附的「Agent 预设定义」那一行被禁用 / 缺失时，本包的模式照常
出现**。自带一份的目的是让插件页「包含的组件」的组件行标题显示**「指挥者模式」**，
而不是通用的「Agent 预设定义」。

`skills/` 下的 20 个方法 skill 由本模式的 `skill-filesystem.config.customSkillDirs` 加载
（按包名定位包目录，不写死绝对路径）；`link:` 安装的目录随包在工作区里，不需要额外构建。

### 为什么拆成两行

preset 子行是运行时挂载的 Cordis fiber，**不在 Loader 的 entry 树里**，而设置页的
`Config.listConfigs` 与 `settings.describe()` 读的都是那棵树。把 `Config` 放在 preset 子行上，
设置命名空间不可达、设置页卡片**静默消失**。所以配置行必须是 profile 顶层行
（行 id = `commander-mode` = 设置命名空间）。

配置行的 `name` 还必须是**裸包名**：`dsh-client-modules` 判定一个 Loader 行有没有 client 半时，
要求 `name` 是不含 `/` 的裸包说明符——写成 `dsh-commander-mode/host` 会让 client 半永远进不了
页面清单。所以模式行用子路径出口 `dsh-commander-mode/agent`（preset 子行不需要被 client 扫描）。

## 配置

配置挂在**顶层行 `commander-mode`**（`dsh-commander-mode`）上，`cordis.patch.yml` 里已写好
默认值。只有 `specialists` 是 volatile：设置页保存后 Loader 热更新运行中的引用（不重载行），
配置行通过 `commanderSettings` 服务广播，模式行据此重建 specialist preset 与工具。
其余字段是加载期配置，改它们要改 profile patch 并重载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `specialists` | 出厂预置六位（**volatile**） | 多模型 specialist 名册，由设置页编辑 |
| `maxSpecialists` | `20` | 名册条数上限（每项 = 一个 preset + 一个工具） |
| `confirmPlan` | `true` | 是否强制"规划/拆分完成后先让用户确认" |
| `escalateOnConflict` | `true` | 是否强制"子代理之间有分歧时交回用户" |
| `maxTeammates` | `16` | 写进协议的建议并行上限（1–16）；真实上限由宿主 `subagent.maxActiveSubagents` 决定（行里不写该键时 schema 兜底 8） |
| `delegationHierarchy` | `true` | 是否启用"任务板写入 / 工单推进状态"两条层级门禁；`false` 只留协议。**放不开派发通道硬门禁** |
| `syncGuard` | `true` | 同步看板（每轮运行时上下文）+ 回合结束前的同步兜底 |
| `stallWatchdog` | `true` | 停滞看门狗：空闲但有活时由插件唤醒一次；`false` 只能靠下级通知或用户说话唤醒 |
| `degenerationGuard` | `true` | 退化输出看门狗：重复循环时在生成中途掐断；`false` 完全关闭 |
| `blockedTools` | 55 项（见「执行边界」） | 指挥者不许自己调用的工具；传 `[]` 可只留协议约束。别把唯一的派发通道一起禁掉（禁掉也不会死锁，执行边界会放行你自己动手） |
| `registerSkill` | `true` | 是否把长文协议注册成 `commander-mode` skill |
| `ledger` | `true` | 工单账本（`commander_ticket_*` + 看板 + 计划授权门禁）；关掉退化为"只有同步看板与协议" |
| `stateDir` | `''` | 账本位置；空 = `<DSH_HOME>/commander/<profile>.json`。相对路径以 `DSH_HOME` 为基准 |
| `requireMandate` | `true` | 派发新工作前必须有用户确认的计划授权（`commander-plan`） |
| `requireTicket` | `true` | 每次派发必须带工单（Team 的 `[ticket:t-N]` / 小组长的 `ticket` 参数） |
| `teamTaskProjection` | `true` | 工单自动投影到共享任务板；没有团队服务时 no-op |
| `requireTeamTask` | `true` | Team 通道派发要求工单已有有效投影（缺投影时插件先自愈补建） |
| `requireTeamTaskMarker` | `false` | Team 通道派发要求 prompt 带 `[task:task-N]` 且与投影一致 |
| `asyncDelegation` | `true` | 小组长的一次性 specialist 异步派发：工具立即返回，完成通知唤醒调用者；`false` 回退前台阻塞 |
| `maxAsyncTasks` | `16` | 同一会话同时在飞的一次性 specialist 上限（1–16） |
| `ticketStallMs` | `600000` | 派发后多久没有新回报算"疑似停滞"（只进看板，不自动处理） |
| `maxTickets` | `100` | 账本最多保留工单数（超出裁剪最老的已结束工单） |
| `eventInbox` | `true` | 外部事件投递：轮询 `events/inbox/` 并 `steer` 对应指挥者会话 |
| `eventPollMs` | `15000` | 外部事件轮询间隔（ms，≥1000） |

`requireMandate` / `requireTicket` 是本包 patch 写定的严格流程默认值；如果你自定义的行里
不写这两个键，schema 兜底是 `false`（工单退化成可选记账工具）。两者与 `confirmPlan`
是同一个决策的两面：`confirmPlan: false` 时 `requireMandate` 会被自动视为 `false`
（否则授权永远记录不到、所有派发被永久拒绝），并给一条 warning。同理
`teamTaskProjection: false` 时 `requireTeamTask` 会被自动视为 `false`（否则 Team 通道永远
派不出去）。

**兼容字段（no-op）**：`workerSessions` / `workRoot` / `maxWorkers` / `prepareCommand` /
`workerPermission` 五个键仍在 schema 里，只为让旧 profile patch 不报未知键——写什么值都不
会启用任何东西（没有对应工具、没有服务）。

profile 层覆盖时注意：按 id 定向的 patch 会**整块替换** `config`，所以覆盖
`preset-commander` / `preset-commander-cc` 必须重述 `id` / `name` / `description` / `order`
（`plugins` 由 `lib/preset-plugins.js` 注入，YAML 覆盖它不会生效）；覆盖 `commander-mode`
（配置行）必须重述全部 config 键。

## 已知限制

- **投影是单向且尽力而为的。** 任务板上的改动不会回写工单；投影任何一步失败只记日志，
  工单、门禁、派发照常工作。任务板被手动改坏时，下一次工单变更会把它同步回来。
- **投影任务表达不了 4 个以上状态。** `review / blocked / failed / waiting` 在板上显示为
  `in_progress` 或 `pending`，真实状态在描述里的 `[commander:status=...]`；完整视图看
  「指挥者·工单看板」。
- **一次性 specialist 的投影任务没有 owner。** 它不是 Team 成员，板上只能保持 `pending`；
  Team 通道的任务由插件自动绑定 owner。
- **投影任务不参与同步看板的告警。** 「团队闲置」「孤儿任务」只看**非投影**任务，
  避免把投影的 specialist 工单误判；投影进度由工单看板负责。
- **名册改动对新会话生效。** 已打开的会话保持启动时的工具清单；旧工具执行时会检查名册，
  发现 specialist 已被移除就给出可执行的错误（提示重新规划），而不是静默派给旧配置。
- **名册为空时协议走降级段。** 不点名不存在的工具：让小组长自己执行，或改用 Team 通道按
  同样定位新开队友。
- **安装失败只降级。** 某个 specialist 的 preset/工具注册失败时，插件记 warning 并把它从协议里
  剔除（避免点名不存在的工具）；其余 specialist 与整个模式照常工作。
- **`inactive` ≠ 做完了。** 它只表示"当前没有轮次在执行"。判断结果要看它报回来的内容与
  验收判据——协议里写明了，但这是模型行为，不是代码保证。
- **看板成员状态来自异步快照。** 成员状态用 `ctx.subagents.listDescendants()` **异步**读取，
  看板用的是缓存快照，最多过期十几秒。
- **同步兜底最多每回合提醒一次。** 模型若坚持不同步，回合会正常结束（不会卡住），下一次有
  新未同步项时才会再提醒。看板只报告**证据充分**的未同步，读不到的一律按"未知"处理，不误报。
- **同一步先结算再写清单不算未同步。** 写清单时会先把当时的任务板记成新基线。
- **协议 section 不再注入给小组长（原生模式）。** 子级返回空串以省 token；CC 模式例外，
  它会拿一份 ~1 KB 的 brief。副作用：原生小组长看不到「结算同步」等条款——它们不需要，
  指挥官负责。
- **告警是提示，不是强拦。** 孤儿任务、团队闲置、并行度不足等只进看板（部分带一次性收尾
  提醒），不拦回合；阈值写死在 `lib/sync.js`。
- **派发配比只统计指挥者自己的派活动作。** `subagent` / `subagent_fork` / `send_message`
  记 Team；`subagent_<id>` / `workflow` 记一次性；`list_agents` / `team_task_*` 不计入
  （它们是读状态与建板）。重启不丢：计数随同步账本持久化。
- **门禁只覆盖 DSH 工具调用。** 如果某个插件通过别的途径派活（例如自定义工具自己起子代理），
  本插件的 `tools/pre-execute` 看不到；`blockedTools` 可用来补。
- **工单是"状态"不是"锁"。** 工单的 `scope`（写作用域）只是提示；执行环境仍共享 cwd，
  没有 worktree / 文件锁，`writeScopes` 也只是 advisory——Bash、formatter、代码生成器与
  直接外部写入都能绕过它。最终 diff 仍需人（或指挥者的只读核对）来看。
- **停滞只是代理指标。** "派发后 N 分钟没有新回报"不等于任务没进展，也不等于失败；看板只
  提示"先只读核对产物，再决定问用户 / 补派 / 标记受阻"，**不自动重派或结束**。
- **账本是单进程文件。** 同一 profile 下多进程写同一 `stateDir` 没有锁；正常部署只有一个
  桌面进程，不构成问题。账本损坏时自动备份并用空账本启动，工单会"丢"（历史仍在会话日志里）。
- **没有计划授权也能建工单。** `commander_ticket_create` 不要求授权；门禁在**派发**时检查。
  这样规划阶段可以先建工单，但"建了工单≠可以派活"。
- **工单工具依赖配置行的账本服务。** 账本初始化失败 / `ledger: false` 时工具不可用或报
  可执行错误，模式其余部分（门禁、看板降级）仍工作。
- **异步完成通知依赖调用者 agent 仍存活。** 会话关闭后再结算：账本仍会写入，但 `steer`
  投递失败（只记 warning），通知丢失——该工单属于旧会话，新会话的看板看不到它。这是
  "会话内模式"的边界，不是队列；重启后靠「重启后续做」提示 + `session_resume_subagents`
  人工续做，未结算的 assignment 不会自动恢复。
- **`maxAsyncTasks` 只限制一次性 specialist。** Team 通道不受这个上限约束；真实并行上限是
  宿主 `subagent.maxActiveSubagents`，本插件的 `maxTeammates` 只是写进协议的建议值。
- **完成通知 ≠ 验收。** 通知只把结果与 `STATUS:` 送到眼前；是否完成仍要指挥者按验收判据核对，
  再 `commander_ticket_update`。没有 STATUS 的结算按 progress 记录，不能当完成。
- **任务板写入权只判断"调用者是不是指挥官"。** 门禁不校验 owner 归属：指挥官 `reassign`
  给某个 teammate 后，那个 teammate 就能 claim / complete。owner 指错人时进度会卡在
  "无人结算"——看板会提示，门禁不会替你修。
- **没有「智能体团队」的部署：三层指挥链退化为协议。** 没有 `subagent` / `subagent_fork` /
  `send_message` 就建不出小组长：协议会把任务连同验收判据写进正文、请用户决定。
  这条退化**不会放宽**派发通道——`workflow` / 一次性专家照旧被拒（它们不是"没有 Team 时的
  替代通道"）。
- **没有 `ask_user_question` 的部署：计划授权门禁自动跳过。** 授权只能由它记录，没有它时
  若仍拒绝派发整个模式会死锁；所以门禁跳过，协议仍要求先把计划讲给用户。
- **降级判据是"工具视图可读且确实没有"。** 视图读不到（`undefined`）时按"有"处理——
  保持原门禁，宁可漏拦也不因为读不到而放宽。
- **深度 2 是运行时限制，不是插件限制。** 插件只把 `subagent.maxDepth=2` 写进协议文本；
  L2 再向下派由运行时拒绝。想加深要改运行时「子智能体」设置。
- **声明器是自带的等效实现，代价是没有 `EntryGroup` 标记。** Loader 会在加载期递归求值
  `plugins` 里的 `!!js`（子行拿到的是已求值的布尔/字符串，而不是惰性表达式）；随附声明器则
  把它们留给子行自己求值。对本包的能力行（平台二选一、`customSkillDirs`）两者等价——
  平台在进程生命周期内不变，`baseUrl` 在加载期同样可用。若将来 DSH 给声明器增加新字段，
  `PresetDeclarationConfig`（`z.object`）需要跟着补；这是刻意的：宁可显式报错，也不要静默丢字段。
- **`skills/` 目录缺失或文件损坏只影响 skill 加载**，不影响协议 section 与门禁。
- **协议是概率性的。** "规划后先确认"与"分歧上报"由协议保证，模型偶尔可能跳过。
  门禁兜住的是"不执行操作"与几条"谁来做"边界——那些是确定性的。
- **CC 模式的产能取决于 Claude Code 子智能体的权限设置**（见「两个模式」）。CC 会话没有
  回问通道，需要澄清的活不适合它。
- **外部事件不做鉴权，且是"至少一次"投递。** 跨进程重启后同一事件 id 仍可能被投递第二次，
  事件正文本身应幂等。

## 开发与测试

```powershell
cd <本插件目录>
pnpm install      # 只为 @deepseek-ai/schemastery
node --test "test/**/*.test.mjs"
```

| 文件 | 职责 |
|---|---|
| `index.js` | **配置行**（profile 顶层）：导出 `Config`、提供 `commanderSettings` / `commanderLedger` 服务、关掉自动设置页 |
| `agent.js` | **指挥者模式行**（preset 内）：协议 section、执行门禁、派发/计划授权门禁、工单工具、skill、specialist 安装与重建、看板与看门狗接线 |
| `workflow.js` | **工作流组件**（preset 内）：只注册 skill `project-dev-workflow`，手册正文在 `lib/workflow.js` |
| `preset-commander.js` / `preset-commander/` | 指挥者模式的声明器 + locale + icon（行是 `dsh-commander-mode/preset-commander`） |
| `preset-cc.js` / `preset-cc/` | CC 模式的声明器 + locale + icon |
| `specialist.js` | specialist preset 里的人设 section（`dsh-commander-mode/specialist`） |
| `client.js` | 设置页（手写 ModuleLoader bundle，无构建） |
| `cordis.patch.yml` | 配置行 + 两个模式行的**声明元数据**（`id / name / description / order`）；`plugins` 由 JS 注入 |
| `lib/capabilities.js` | **能力行唯一真源**（`CAPABILITY_ROWS` + `capabilityEntries()`）：模式与每个 specialist preset 都从这里展开 |
| `lib/preset-plugins.js` | 模式的**完整 plugins 组合**（能力行 + 模式行 + 可选的同伴包组件行） |
| `lib/preset-components.js` | 同伴包预设组件的发现与校验（fail-closed 软依赖） |
| `lib/preset-declaration.js` | 自带的 agent preset 声明器（语义等价于随附实现） |
| `lib/preset-catalog.js` | 把内部 specialist preset 从模式菜单目录里过滤掉（注册与挂载不变） |
| `lib/protocol.js` | 指挥者协议（紧凑版注入 system prompt，长文注册成 skill） |
| `lib/team-model.js` | 团队模型的**唯一正文来源**（三层职责 + 十条规则，含团队形状与完成语义） |
| `lib/mode-variant.js` | 变体判定（按会话头 `agentPreset` 判原生 / `*-cc`） |
| `lib/discipline.js` | 五条工作纪律的**唯一真源**（Team 优先 / 禁止等待 / 禁人日 / git 分类提交 / 经验教训） |
| `lib/settings-service.js` | 配置行与模式行之间的桥：读配置/名册、广播 volatile 变化 |
| `lib/specialists.js` | 名册清洗、人设渲染、specialist preset 定义、`subagent_<id>` 工具的自实现 |
| `lib/presets.js` | 出厂预置名册（`DEFAULT_SPECIALISTS`） |
| `lib/guard.js` | 全部确定性门禁的纯函数：执行边界、禁止等待、禁止轮询、派发通道硬门禁、任务板/工单写入、结算门禁、重复建小组长、CC 两条门禁，以及 `blockedTools` 默认清单 |
| `lib/dispatch-gate.js` | 派发门禁：计划授权 / 工单 / 任务板投影，含缺投影自愈 |
| `lib/ticket-tools.js` | 三个工单工具（create / update / list）的 schema、执行与错误文案 |
| `lib/tickets.js` | 工单状态机：六态回报 → 工单状态/阶段、停滞判定、计划授权判定、`STATUS:` 解析、工单看板渲染（纯函数） |
| `lib/ledger.js` / `lib/ledger-service.js` | 账本存储层（原子写、损坏备份、schema 清洗、路径解析）与 `commanderLedger` 服务 |
| `lib/sync.js` / `lib/sync-store.js` | 结算同步状态机、13 类看板告警、收尾兜底提醒的渲染（纯函数）与持久化 |
| `lib/team-board-bridge.js` | 工单 → 共享任务板的单向投影（best-effort，永不抛错） |
| `lib/team-mode.js` | 强制开启智能体团队（三条通道） |
| `lib/stall-watchdog.js` | 停滞看门狗（空闲但有活时唤醒） |
| `lib/degeneration-guard.js` | 退化输出看门狗（生成中途掐断 + 熔断） |
| `lib/wake-chain.js` / `lib/pending-notices.js` | 冷唤醒三级降级与通知补投队列 |
| `lib/reboot-resume.js` | 重启后续做的离线可续做下级提示 |
| `lib/event-inbox.js` / `lib/events.js` | 外部事件文件队列与投递 |
| `lib/in-flight-advisory.js` | 有在飞下级时的收尾提醒 |
| `lib/config.js` | schemastery `Config`、默认值、宽容读取器 |
| `bin/commander-status.mjs` / `bin/commander-event.mjs` | 运维巡检 / 外部事件 CLI |

### 图标

包根 `icon.svg` 按 dsh 官方插件的矢量语言手绘：36×36 透明底、官方 artwork 调色板、一个意象。

同一份图标在**三处界面**生效：

| 位置 | 来源 |
|---|---|
| 插件页卡片 / 详情页头图 / 「包含的组件」行 | `package.json` 的 `"icon": "./icon.svg"`（Host 读包清单，声明即可） |
| 「设置 → 插件 → 内置插件配置」卡片插画 | client 半把同一份字节以 data URI 登记进 `globalThis.__DSH_PLUGIN_ITEM_ARTWORK__['commander-mode']`；**需要** dsh-plugin-devkit 的 `scripts/patch-plugin-item-artwork.mjs --apply` 给随附的插件管理页补一次查询逻辑，否则回落官方默认插画 |

改图标的正确顺序：改 `icon.svg` → `node <devkit>/scripts/embed-plugin-artwork.mjs .`
（同步 `client.js` 里的 `ITEM_ARTWORK_URI`）→ 跑本包测试。图标规范全文见
dsh-plugin-devkit 的 skill `dsh-plugin-development/references/icon-design-language.md`。

## 兼容性与依赖

- 要求 DSH 具备 `agentPresets` / `agentTeams` / `subagents` / `systemPrompt` / `tools` /
  `skills` 这些面，并按「Team 成员 = 可续做的标准 subagent」的口径工作
  （DSH 0.2.2-rc.2 口径；rc.3 与 rc.5 上可用）。
- Node ≥ 20（`package.json` 的 `engines`）。
- 唯一运行时依赖：`@deepseek-ai/schemastery`（声明 `Config` 所需，装进本包 `node_modules`）。
- 可选：`@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」，
  本模式强制开启它）、Claude Code 子智能体 bundle（只有 CC 模式需要）、
  dsh-plugin-devkit（预设组件，软依赖）。

变更历史见 git 历史与版本 tag。
