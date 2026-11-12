# dsh-commander-mode

DeepSeek Harness（dsh）的**一个模式**：**指挥者模式**。指挥者接单、分析、按任务形状拆分，
把执行全部派给**小组长**（自己不执行操作，规划与分歧都交回用户确认），并逐项验收。
六位开发流程专家（3.0.0 起是**专家小组长**）与六段工作流（架构 → 实现 → 审查 → 测试 →
安全 → 文档）都是**按需**的：专家团按任务形状选人，工作流用 `skill` 按需加载。

**一句话**：你只做判断，小组长做执行（它也可以再交子智能体）；需要有人替你拆分、派活与逐项验收，就用这个模式——流程按任务形状定，不套模板。

> **5.0.0：原「项目经理模式」已并入本模式。** 两边的差别（专家团、六段工作流）本来就都是按需能力，不需要用两个模式来表达。现在只有一个模式、一个 preset，切换成本为零。

- **指挥者不执行**：`write` / `edit` / `pwsh` 这类调用会被**确定性拒绝**并附上纠正指令
  （不是"靠提示词自觉"）——所以「分析、拆解、派活、验收」是它唯一的工作方式。
- **三层指挥链（3.0.0）**：**指挥官 → 小组长 → 子智能体**。指挥官的下一级只有小组长
  （`spawn_teammate` 建出的具名队友）：它自己执行，或把子任务交给下级子智能体。最大递归
  深度 2、并行上限 16，都来自运行时「子智能体」设置，插件不再自己压低。
- **派发通道（3.0.0 起指挥官只剩一条）**：指挥官的通道是「智能体团队」（小组长）；一次性
  `subagent_<id>`（开箱六位专家，可继承你的模型或绑定专属模型）归**小组长**使用。
- **两次必须问你**：规划拆分完成后先确认再派活；出现分歧、歧义或取舍时交回你选。
- **结算即同步**：任务一完成就同步**任务板 / 计划清单 / 团队状态**，而不是收尾才补
  （3.0.0：任务板由小组长结算，指挥官只核对）。
  每轮运行时上下文里有「**同步看板**」（任务板、计划清单、团队状态的实时快照，有未同步项
  时直接给纠正指令）；万一还是忘了，回合结束前的兜底钩子会把它拽回来。0.4.0 起生效。
- **a2a 有纪律**：派活一次写全、开工前先约定回报格式、**不等**（`wait_agent` 3.1.0 起硬禁用、
  3.2.0 起整条链生效、无开关）——状态用 `list_agents` / 任务板读一次，少一轮就是一个回合。0.4.0 起生效。
- **Team 优先（0.5.0）**：多阶段 / 长任务 / 需要中途追加指令或任务板进度 → 走「智能体团队」
  （`spawn_teammate` + `team_task_*` + `send_message`）；一次性单点任务由**小组长**用
  `subagent_<id>`（3.0.0：指挥官的通道只剩 Team）。
  看板会显示**派发通道配比**并点名**孤儿任务**（没人认领 / 主人已停手），防止"重启后队友没了
  就退化成只用一次性 specialist、任务板留下 6 项没收尾"。
- **工单与计划授权（0.6.0）**：每一件被派出去的活都挂一张**工单**（`commander_ticket_*`），
  派发前必须有用户确认的**计划授权**（`ask_user_question` 的固定问题 id / 选项）。
  没有授权或不带工单的派发会被**确定性拒绝**；每轮看板显示「**指挥者·工单看板**」——
  计划授权状态、进行中工单、待验收 / 受阻 / 停滞 / 等你回答的项与下一步动作。
  账本落在 `<DSH_HOME>/commander/<profile>.json`（原子写、损坏自动备份、重启不丢）。
- **异步派工与完成唤醒（0.7.0）**：一次性 specialist 不再阻塞等待——工具立即返回 childId，
  结算时用一条「【指挥者·派工完成】」通知**唤醒**指挥者（带工单、`STATUS:`、摘要与下一步），
  并同时写账本。派活后可以继续做别的或结束回合，**不要等**（3.1.0 起 `wait_agent` 硬禁用、
  3.2.0 起整条链生效）也不要 `list_agents` 轮询；
  在飞数量有上限（`maxAsyncTasks`，3.0.0 起默认 16），`asyncDelegation: false` 可回退前台阻塞行为。
- **Worker Session（0.8.0；1.0.0 起默认开启）**：`commander_worker_spawn` 可给一张工单开
  **独立 DSH Session + 独立目录**（`workRoot/<ticket>`，可选 prepare 命令），worker 只拿工作
  工具、结束时用 `commander_report` 汇报并用通知唤醒你；有槽位上限（`maxWorkers`）与重启恢复
  提示。它改变执行模型（会话列表会出现 `执行 <ticket>：<标题>` 会话），不需要时在 profile
  patch 里显式写 `workerSessions: false` 即可回退（关闭后不注册四个 `commander_worker_*` 工具）。
- **外部事件接入（1.1.0）**：CI / 告警 / 定时巡检可以用
  `bin/commander-event.mjs` 往 `events/inbox/` 写事件，插件轮询取走并 `steer` 对应指挥者
  会话——**空闲的指挥者会被外部事件唤醒**（不需要人先说话）。事件不建工单、不派活，
  只把"外面发生了什么"送到指挥者眼前；待投递数量在 `commander-status` 里可见。
- **工单投影到共享任务板（1.2.0）**：账本仍是权威；装了「智能体团队」时，每张工单会被
  **确定性投影**成任务板上的一张任务（描述首行 `[commander:ticket=t-N]`），工单状态变化
  自动同步；走 Team 通道派发后，投影任务的 owner 会**自动绑定**到那个队友。你在
  Agent Teams 面板里看到的板就是工单的进度，不需要模型自觉去建。没有 Agent Teams 的
  部署行为与 1.1.x 完全一致。
- **按任务形状拆分（3.6.0；5.0.0 并入本模式）**：不预设流水线——先判断"这次要交付什么、
  需要哪些能力、任务之间有没有真实依赖"，再拆任务。交接 / 发版打包 / 单点修复 / 排障各有
  自己的拆法；从零开发或大改造才值得按可选六段工作流推进。每个任务都有可观察的验收判据、
  完成必须有落盘证据；需要独立审查 / 独立测试的换人做；每个任务结束做 git 分类提交
  （未提交视为该任务未完成）。
- **项目开发工作流（2.0.0；3.6.0 起按需）**：可选执行手册组件（`dsh-commander-mode/workflow`）：
  六段每段的必做动作、必须落盘的产物、验收判据、失败返工、对应专家与团队用法，并给出本包
  `skills/` 目录里 **20 个方法 skill** 的阶段归位（先加载方法再动手；其中
  `file-location-alignment` 专门治"位置歧义 / 用缺失否定用户"）。**3.6.0 起它只注册
  skill（`project-dev-workflow`），不再每轮注入**：指挥者与专家小组长都可以按需加载、
  只取其中一段。它明确一条边界：**skill 是工作方法，不替代验收证据**。
- **禁止等待子智能体（3.1.0 起无开关；3.2.0 起整条链生效）**：`wait_agent` 被**硬禁用**——
  没有 `maxWaitMs`、也没有任何配置项能放开（连"短等"也不行）；3.2.0 起**不按身份放行**，
  指挥官、小组长、子智能体都一样（不要等下级，也不要等上级）。不等之后靠「派工完成」通知
  唤醒 + 读状态（`list_agents` / 任务板）+ `send_message` 追问。依据是历史会话里单次
  127.5 分钟、累计 11 小时的等待：等子代理不要一直等，连"等一会儿"也不行。

```text
30 秒上手
1) 插件页安装本包，重启桌面版
2) 新建会话，模式菜单选「指挥者模式」（现在只有一个模式）
3) 把任务丢给它 → 只读侦察 → 按任务形状拆 → 你确认 → 建 Team/任务板 → 派给小组长 → 逐项验收
   - 需要完整交付链（从零开发 / 大改造）时，让它用 skill 加载 project-dev-workflow 按六段推进
   - 发版打包 / 交接 / 单点修复 / 排障不需要六段，按对应形状拆即可
   （想调专家？设置 → 插件 → 指挥者专家名册：增删、改定位、绑模型、一键恢复预置）
```

- 仓库：<https://github.com/lldwb/dsh-commander-mode>（公开）
- 许可：[MIT](./LICENSE)
- 形态：**配置行**（profile 顶层，裸包名 `dsh-commander-mode`）+ **一个 agent preset**
  （指挥者模式：`dsh-commander-mode/agent` + 可选工作流组件 `dsh-commander-mode/workflow`）
  + 设置页（Client 半）
- 依赖：`@deepseek-ai/schemastery`（声明 `Config` 所需，装进本包 `node_modules`）、
  `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」，可选但推荐）
- 前置条件：本模式由**本包自带的声明器**注册（`dsh-commander-mode/preset-commander`，
  实现见 `lib/preset-declaration.js`，语义等价于随附的 `@deepseek-ai/dsh-agent-preset`）。
  它只依赖随附的 `agentPresets` 服务（agent preset 注册表）；**随附的「Agent 预设定义」
  （`@deepseek-ai/dsh-agent-preset`）那一行与本模式无关**——禁用 / 缺失它不会让模式消失
  （2.1.0 起自带声明器，2.0.x 时才是依赖）。

> **为什么拆成两行**：preset 子行是运行时挂载的 Cordis fiber，**不在 Loader 的 entry 树里**，
> 而设置页的 `Config.listConfigs` 与 `settings.describe()` 读的都是那棵树。把 `Config`
> 放在 preset 子行上，设置命名空间不可达、设置页卡片**静默消失**（dsh 0.2.1-rc.2 实测）。
> 所以配置行必须是 profile 顶层行。
>
> **为什么配置行的 `name` 必须是裸包名**：`dsh-client-modules` 判定一个 Loader 行有没有
> client 半时，要求 `name` 是不含 `/` 的裸包说明符 —— 写成 `dsh-commander-mode/host`
> 会让 client 半永远进不了页面清单（同一轮实测）。所以模式行用子路径出口
> `dsh-commander-mode/agent`（preset 子行不需要被 client 扫描）。

## 它做什么

在输入框上方的模式菜单里选中「指挥者模式」后，当前会话的 agent 变成**指挥者**：

| 它做 | 它不做 |
|---|---|
| 只读侦察（`read` / `glob` / `grep` / `web_search`） | 写文件、改文件（`write` / `edit`） |
| 规划与拆分、维护 `todo_write` | 跑命令（`pwsh` / `bash`） |
| 建任务板、派发给小组长（`spawn_teammate`） | 杀作业（`job_kill`） |
| 结算后三同步：任务板 / 计划清单 / 团队状态 | 装插件（`plugin_manager`） |
| 读状态（`list_agents` / 任务板）、核对验收判据 | 替用户拍板 |
| 用 `ask_user_question` 让用户确认计划、上报分歧 | |

> **3.0.0 起是三层指挥链（指挥官 → 小组长 → 子智能体）**：下表与后续小节里的「子代理」
> 现在特指**小组长**；一次性 `subagent_<id>` 归小组长使用。详见「3.0.0 团队模型」一节。

### 结算同步（0.4.0）

多子代理会话里最贵的失误不是派错活，而是**做完了但没人同步进度**。真实事故（2026-11-02，
一次三小时、1111 个事件、3 个子代理的会话）：

- `todo_write` 全程只调了 **5 次**，最后一次停在 **+61 分钟**；
- 之后 100 分钟里任务板完成/删除了 4 个任务，**计划清单一次都没动**；
- 收尾报告发出时任务板 4 分钟前刚结算完，清单还是两小时前的快照 —— 直到用户亲口问
  「进度如何？同步更新任务」才补上。

0.4.0 用**两条确定性通道**堵住（不靠"希望模型记得"）：

1. **每轮运行时上下文**里的一行「指挥者·同步看板」（`systemPrompt.context`，比 section
   遵从率高得多）：任务板几项已结算 / 谁还没结算、计划清单完成度、每个成员 running 还是
   inactive；有未同步项时直接给出 `todo_write` / `send_message` 让 owner（小组长）结算的
   纠正指令（3.0.0：任务板进展由小组长写，指挥官只核对，见「3.0.0 团队模型」）。
2. **回合结束兜底**（`agent/turn-stopping`）：回合要结束了还有未同步项，就注入一次提醒
   （每回合最多一次），让模型在同一个回合里补完，并要求它补一条 1–2 行的同步回执而不是
   重复报告。

两条都只对指挥者生效（teammate 用 `isDelegatedAgent` 排除）。关掉看板与兜底：
配置行 `syncGuard: false`（协议里的同步要求仍在）。

### a2a 效率（0.4.0）

同一会话的浪费是可以量化的：**50 次 `wait_agent`、27 次 `list_agents`、12 次
`team_task_list`**（合计 39 次纯轮询工具调用），30 条 `send_message` 合计 2.6 万字，
其中两次因为"重复同一个调用"被运行时警告。0.4.0 把这些写成 a2a 纪律（并在看板提供状态
之后把轮询变成**不必要**）：

- **派活一次写全**：目标 / 产出物 / 验收判据 / 写作用域 / 回报格式 / 停手条件写进一条消息；
- **先约定回报协议**：长任务连续跑到完成，只在一行里程碑或异常时回报，**不要每批结束回合
  等指令**（每次多两轮：它停一次、你再推一次）；
- **不等，也不轮询**：`wait_agent` 被**硬禁用（无开关；3.2.0 起整条链生效）**——不存在"超时"这个
  动作；要看状态用 `list_agents` / 任务板读一次，别紧接着 `list_agents` + `team_task_list`
  复查；同一参数连续重复会被运行时警告；
- **回执即成功**：`send_message` 返回 `accepted` / `queued` 都算投递成功，绝不重发。

顺带修掉一个真实的**系统提示泄漏**：teammate 与指挥者共用同一个 preset scope，0.3.x 里
每个执行者的系统提示都带着整份「指挥者模式 … 你不执行操作」（约 4.4 KB/请求），既浪费
token 又和它自己的执行者人设冲突。0.4.0 起 prompt section 按 agent 判定，子级返回空串。

### Team 优先与通道配比（0.5.0）

0.4.0 让 Agent Teams 的**状态**可见，但没有解决"**干脆不用 Team**"。真实会话
（`session-7064696b`，4 天、1374 个事件、21 个子代理）的形状：

| 阶段 | Team 工具调用 | 一次性 specialist | 任务板 |
|---|---|---|---|
| seq 0–1000 | **118 次**（6 `spawn_teammate` / 14 建板 / 22 `send_message` / 37 `wait_agent`） | 0 | 正常推进 |
| seq 1000–1333（运行时重启后） | 13 次 | **13 次** | 开始漂移 |
| seq 1333–结束 | **0 次** | **2 次** | 留了 6 项没收尾 |

结局：`task-3` / `task-4` / `task-14` **从未被认领**，`task-5` / `task-12` / `task-13`
的主人已经 `inactive`，而指挥者还在用一次性 specialist 派新活 —— 长活被切成一堆互不相干的
一次性调用，任务板成了"假进度"。0.5.0 从三个地方一起堵：

1. **决策点提示**：每个 `subagent_<id>` 的**工具描述**里写明"一次性通道：没有持续对话 /
   任务板 / 后台通知，每次新 child；多阶段 / 长任务 / 需中途追加指令 → 改用 Team"。
   通道选择是在**选工具的那一刻**做的，提示放在那里比埋在长协议里有效。
2. **协议新增「通道配比：Team 优先，specialist 只做单点」**（两条通道都存在时才出现）：
   按任务形状选通道、**建板必有主**、复用同一个 teammate、**重启后先看团队再决定用谁**、
   teammate 静默结束时**先查产物**再判（别一次就得出"Team 不好用"）。
3. **看板新增两类告警**：
   - **派发通道配比**：`派发通道：Team N 次 / 一次性 specialist M 次`；最近 3 次派活全是
     一次性 specialist 且任务板还有未结算 → `⚠️ 团队闲置`，提示改用 Team；
   - **孤儿任务**（`⚠️ 任务板有孤儿任务`）：未结算 + 超过 10 分钟宽限期 + （无人认领 或
     主人已 `inactive`）→ 提示"用 `spawn_teammate` 补人认领，或自己 `team_task_update`
     结算/删除"。这类任务每条会话**强制兜底提醒一次**，之后留在看板里常驻。

宽限期 10 分钟是刻意留的：规划阶段一次建 5–15 个任务是常态，过早报警只会有噪声；
而那次会话里的孤儿任务躺了**两天**，10 分钟足够区分。

### 工单、计划授权与注意力看板（0.6.0）

0.4/0.5 的看板只回答"任务板 / 计划清单同步了没"，不回答"**每一件被派出去的活**现在在哪一步、
卡在谁身上、要不要人管"。0.6.0 借鉴 DeepSeek Harness 团队 Super-agent 原型的
Ticket / Mandate / Assignment / Report 形状（裁剪到指挥者场景，去掉 Source/Thread/Eval），
把"派活"从一段文本变成**有状态、可审计、可恢复**的工单。

**模型可见的闭环**（全部写进协议，且大部门禁是代码）：

1. **计划确认有固定格式**：必须用 `ask_user_question`，问题 id 精确写成 `commander-plan`，
   选项第一项 label 精确写成「确认，开始执行」，第二项「需要调整」。只有选中第一项
   （或自定义答案以"确认"开头）才算拿到**计划授权（Mandate）**。
2. **先建工单再派活**：计划确认后，每一项要交付的活用 `commander_ticket_create` 建工单
   （`title` + `acceptance`，可选 `intent` / `scope`）。一张工单可多次派发（实现 / 返工 / 审查）。
3. **每次派发都带工单**：specialist 工具传 `ticket` 参数；Team 的 `spawn_teammate` 在
   prompt 首行写 `[ticket:t-N]`。
4. **回报必须结构化**：执行者（3.0.0 起是小组长）最终答复最后一行写
   `STATUS: progress|waiting|ready|blocked|failed|dropped`；**推进状态由小组长**用
   `commander_ticket_update` 回报（3.0.0 门禁：指挥官自己报 `progress` / `waiting` / `ready` /
   `blocked` / `failed` 会被拒绝——工单状态会投影到共享任务板，绕道同样算改进度）。
5. **验收后结算**：指挥者在验收通过后用 `commander_ticket_update` `status=done`
   （或 `cancelled` 写 `reason`）——`done` / `cancelled` 仍是指挥官的验收动作。

**确定性门禁**（`tools/pre-execute`，不是提示词）：

- 没有有效计划授权就派发新工作 → **拒绝**，理由给出固定问题 id / 选项与下一步；
- 有授权但不带工单 → **拒绝**，列出当前会话的工单并提示先建；
- 工单不存在 / 已结束 / 不属于本会话 / 建立在旧版授权下 → **拒绝**；
- 子代理自己派发、账本服务缺失、身份读不到 → **放行**（宁可漏拦，不可拦死，与执行门禁同一原则）。

**工单看板**（每轮运行时上下文，独立于同步看板）：

```text
【指挥者·工单看板】计划授权：已确认（<计划摘要>）；工单 2 项进行中：t-2[review] …、t-1[working] …
⚠️ t-2 待验收：… → 只读核对产物与验收判据；通过就 commander_ticket_update 标记 done，不通过就补派返工。
```

- 优先级：等你回答 > 受阻 > 失败 > 待验收 > 停滞 > 进行中；最多列 6 项；
- **安静默认**：没有工单且没有授权时不产生任何文本；
- **停滞**是代理指标：派发后超过 `ticketStallMs`（默认 10 分钟）且没有新回报 → 提示"先只读核对，
  再决定问用户 / 补派 / 标记受阻"，**不自动重派或结束**（Super-agent 也承认任务层巡检最难）。
  **3.3.0 起对 Worker Session 另有一条停滞看门狗**：每 60 秒扫描带 `execution` 的未结束工单，
  超过 `ticketStallMs` 且**开工后从未回报**就 `steer` 指挥者（同工单 10 分钟节流），提示它
  可能卡在回合中途——只提醒、不自动改状态（见「Worker Session」与「3.3.0」）。

**账本**：

- 位置：默认 `<DSH_HOME>/commander/<profile>.json`；配置 `stateDir` 可改（相对路径以 `DSH_HOME`
  为基准；`.json` 结尾视为文件，否则视为目录）；
- 原子写（临时文件 + rename）、损坏 JSON 自动备份为 `*.corrupt-<时间戳>` 后用空账本启动、
  按会话隔离、最多保留 `maxTickets` 张（超出裁剪最老的已结束工单）；
- 只存工单/授权/派发/回报这类状态事实；**不存**会话正文或子代理输出（以 DSH 会话日志为准）；
- 写盘失败降级为"内存继续 + warning"，绝不把工具调用弄挂；
- 关掉 `ledger: false` 时退化为 0.5.0 行为（没有工单工具、没有授权门禁、只有同步看板与协议）。

### 异步派工与完成唤醒（0.7.0）

0.4/0.5 的派活是**前台阻塞**：`subagent_<id>` 会一直等到 specialist 结算才把结果返回。任务一长，
指挥者就在空转，用户也只能等。0.7.0 把一次性 specialist 改成**异步**（默认开）：

- **派活即返回**：工具立即返回 childId（`stopReason: started`），指挥者在同一回合可以继续做
  只读核对、规划下一项，或结束回合。
- **完成会自己回来**：插件在后台等待结算（`delivery:'caller'` + 插件作用域持有的 signal，
  不随工具调用中止），拿到结果后：① 解析最后一行 `STATUS: ...`；② 写账本（结算 Assignment +
  Report）；③ 用 `agent.steer()` 发一条「【指挥者·派工完成】」通知（**会唤醒空闲的指挥者**），
  带工单、STATUS、摘要与"下一步"。
- **失败也一样**：结算 reject 时记 `failed` + 一条带错误与工单的通知。
- **容量上限**：`maxAsyncTasks`（3.0.0 起默认 16）在**启动前**检查；超限拒绝并提示等完成或改 Team，
  不会先启动 child 再失败。
- **在飞不重派**：同一工单已有在飞派发时不要重复派同一任务；要追加/纠偏走 Team 的 `send_message`。
- **回退**：`asyncDelegation: false` 回到 0.5.0 的前台阻塞行为。

为什么不用 runtime 的 `delivery:'parent'` 完成通知：它的通知内容与工单映射不可控，而且会多一条
模型可见消息；`delivery:'caller'` + 后台 await + `steer` 让我们完全控制通知格式、去重与账本写入。

### Worker Session（0.8.0；1.0.0 起默认开启）

0.6/0.7 让派活有状态、有通知，但所有执行者仍**共享 cwd**——长任务并行会互相踩文件。
0.8.0 提供第三种执行通道：**每张工单一个独立 DSH Session + 独立目录**。0.8.0 曾默认关闭
（改变执行模型）；0.9.1 在真实 Web profile + 真实模型里跑通全链路后，**1.0.0 起默认开启**。

- **关闭**：在 profile patch 的 `commander-mode` 配置里显式写 `workerSessions: false`（需重载）。
  关闭后不注册四个 `commander_worker_*` 工具、不会出现 worker 会话，派工语义回到 0.7
  （specialist / Team 两条通道）。想改 `workRoot` / `maxWorkers` / `prepareCommand` /
  `workerPermission` 同理。
- **四个工具**：
  - `commander_worker_spawn`：给已有工单开 worker。建目录（`workRoot/<ticket>`，可跑一次
    `prepareCommand`，可用 `DSH_COMMANDER_*` 环境变量）→ `workspaceRegistry.create` →
    `sessionController.create({ sessionId: 'worker-<ticket>', workspaceId })` → 设置权限 →
    重命名 → 账本记录 `execution` → 投递派工消息。
  - `commander_worker_send`：追加指令；`commander_worker_stop`：停止当前回合（记 blocked）；
    `commander_worker_status`：看 session/目录/是否可解析。
- **worker 侧（0.9.1 修正时序）**：spawn 在账本记下 `execution` 之后**显式**装饰 worker
  （不能只靠 `agent/created`：该事件在 `sessionController.create()` 期间就可能触发，那时账本
  还没有 execution 记录，装饰会被静默跳过）。装饰内容：注入「你只负责这张工单」人设 +
  目录/验收判据、静态 `tools.restrict({allow: WORKER_TOOLS})`（模型少看到无关工具）、
  `tools.guard` 白名单兜底（restrict 在 agent 组装早期可能抛"unknown global tool"）、
  注册 `commander_report`，并加"工单已结束"guard。结束前必须 `commander_report`
  （status + summary；blocked/failed 用 question）；汇报会写账本并 `steer` 唤醒指挥者。
  **两种兜底分工（3.3.0 补齐）**：**idle 兜底**只在 `agent/status = idle`（回合已结束却没汇报）
  时每 10 分钟提醒一次；**停滞看门狗**（每 60 秒扫一次）覆盖"回合中途卡住、永远不 idle"的情况
  ——带 `execution` 的未结束工单，若 `now - startedAt >= ticketStallMs`（默认 10 分钟）且
  开工后**从未回报**，就 `steer` 指挥者（同工单 10 分钟节流），提示它可能卡在回合中途，
  给出三步处置（追问 / `commander_worker_stop` 后补派 / 标记 blocked）。看门狗**只提醒、
  不自动改状态**。
- **槽位与恢复**：`maxWorkers`（默认 3）在启动前检查；DSH 重启后，指挥者会话创建时会为
  open 工单的 worker 投递恢复提示（先检查目录/产物再继续）并标记 `resumedAt`。
- **边界**：worker 目录与工具收敛**不是安全边界**（worker 仍以操作员身份执行，默认
  `danger-full-access`，可用 `workerPermission` 改）；没有 worktree/文件锁；prepare 命令来自
  用户配置、按用户 shell 执行。
- **端到端已验证（0.9.1）**：真实 Web profile + 真实模型走完
  `commander_ticket_create → commander_worker_spawn → worker 在自己目录直接写文件 →
  commander_report → steer 唤醒 → commander_ticket_update(done)`，见「验证过什么」。
  默认仍关闭：是否默认开启（1.0.0）是**产品决定**，需要先决定 worker 会话在会话列表里
  如何呈现（目前会直接出现 `执行 <ticket>：<标题>`）。

**两次"必须问用户"**是这个模式的核心要求，都写进了协议：

1. **规划/拆分完成后**——必须停下来用 `ask_user_question` 把计划摆给用户，问是否有问题、
   是否需要调整。**用户确认之前不派任何活。**
2. **出现分歧或不确定时**——小组长之间结论冲突、需求有歧义、必须做取舍、
   要动高风险的东西、小组长报回 BLOCKER，都交回用户选。

## 3.0.0 团队模型：指挥官 → 小组长 → 子智能体

3.0.0 起，本模式按**三层指挥链**工作。2.x 只有两层（指挥者 → 子代理），指挥者可以绕过
队友直接派一次性 specialist；3.0.0 把中间那层固定下来：**指挥官只和小组长打交道**。

### 三层职责

- **L0 指挥官**（主会话 / Lead）：目标、拆分、派单、验收、与用户沟通。它不执行操作，也不越过
  小组长去派一次性子智能体。
- **L1 小组长**（`spawn_teammate` 建出的具名队友）：各背**一个团队任务**，可以**自己执行**
  （它继承同一 preset scope，有写文件与跑命令的能力），也可以把子任务交给**下级子智能体**；
  **任务进展与排期由它写**。
- **L2 子智能体**（小组长派出的 `subagent_<id>` / `subagent` / `workflow` 子代理）：只负责执行，
  **不再向下派**（运行时递归深度上限 2）。

### 用户 2026-11-11 的五条规则

1. **持续接单**：主会话作为指挥官持续接收用户输入并调整团队目标，把新内容与已有内容一起
   纳入团队排期；描述不清时由小组长反馈指挥官、指挥官与用户交底后再回给小组长。
   **一个团队一个小任务，多个团队一个大任务。**
2. **使用运行时的「子智能体」限制**：最大递归深度 2、并行数量上限 16。
3. **一项任务下发给一个小组长**：小组长可以自己执行，也可以交给下级子智能体执行。
4. **只有小组长可以修改智能体团队的任务进展并做排期**（`claim` / `release` / `complete` /
   `reopen` / `set_dependencies`）；指挥官只建任务、`reassign` 指派 owner、读板与验收。
5. **只有一个模式（5.0.0）**：原「项目经理模式」已并入，协议正文只有 `lib/protocol.js` 一份。

这五条在实现里落成 `lib/team-model.js` 的**七条规则**（hierarchy / runtime-limits /
one-team-one-task / continuous-intake / ambiguity-chain / leader-owns-board /
leader-may-execute）；指挥官协议与项目经理协议都拼接同一份正文，不会出现两套说法。

### 运行限制：深度 2 / 并行 16（来自运行时，插件不再压低）

- **最大递归深度 2**：`subagent.maxDepth = 2`。小组长是 L1、子智能体是 L2；L2 再向下派会被
  运行时拒绝，硬试只是白烧轮次。
- **并行上限 16**：`subagent.maxActiveSubagents = 16`、`agent-team.maxMembers = 16`。互不依赖
  的工作流各开一个小组长并行推进；**真到上限才排队或复用**，不要因为"怕撞上限"提前串行化。
- 插件**不再自己压低**这两个数字：`maxTeammates` / `maxAsyncTasks` 的默认值与上限都改成 16，
  与运行时一致（见「配置」）。2.x 里 `maxTeammates` 默认 4 / 8 的"建议并行度"是历史包袱，
  会让模型提前串行化。
- 这两个数字写在协议正文里（模型读不到运行时配置）：文本与运行时不一致时以本节口径为准。

### 确定性门禁：三条「谁来做」

协议是概率性的，3.0.0 把三条最容易被绕过的边界做成 `tools/pre-execute` 门禁（`lib/guard.js`），
**只拦指挥官本人**：小组长 / 子智能体（`isDelegatedAgent` 命中）与身份读不出来的调用一律放行。

> **例外是「禁止等待」门禁**（3.2.0）：它**不按身份放行**——指挥官、小组长、子智能体与
> 身份读不到的调用一律拒绝（等待不是完成工作必需的动作）。见「禁止等待子智能体」一节。

- **任务板写入**（`evaluateBoardWrite`）：`team_task_update` 的 `claim` / `release` / `complete` /
  `reopen` / `set_dependencies` 由小组长做；指挥官做会被拒，拒因会告诉它「用 `send_message`
  让 owner 结算，或 `reassign` 改派」。`reassign` / `edit` / `delete` 仍由指挥官做。
- **工单推进状态**（`evaluateTicketWrite`）：`commander_ticket_update` 的 `progress` / `waiting` /
  `ready` / `blocked` / `failed` 只允许小组长回报——工单会投影到共享任务板，只拦任务板的话
  指挥官仍能绕道工单间接改进度。`done` / `cancelled` 仍是指挥官的验收动作。
- **子智能体派发**（`evaluateSpecialistDispatch`）：`subagent_<id>` / `subagent` / `subagent_fork`
  被拒（团队活交给小组长，一次性专家由小组长自己调用）。`workflow` **不在**拦截范围——它是
  编排，不产生"某个子智能体在执行"的层级派发。
- 三条都受新配置 `delegationHierarchy` 控制（默认 `true`）；设成 `false` 时门禁全部关闭，
  回到 2.x 的"只靠协议"行为（文本仍在，但没有硬拦截）。

### 3.0.0 破坏性变更与迁移

大版本：对外契约有结构性变化，"指挥者直接派 specialist、自己改进度"的旧用法不再被允许。

1. **指挥官不再直接调用 `subagent_<id>` / `subagent` / `subagent_fork`**：团队活一律
   `spawn_teammate` 建小组长 + `send_message` 派活；直调会被确定性拒绝（见上）。一次性专家
   仍可用，但只由**小组长**调用。
2. **任务板进度与排期写入权从指挥官移到小组长**：`team_task_update` 的
   `claim` / `release` / `complete` / `reopen` / `set_dependencies`，以及
   `commander_ticket_update` 的 `progress` / `waiting` / `ready` / `blocked` / `failed` 只允许
   小组长做。指挥官只做：`team_task_create` 建任务、`team_task_update` `action:"reassign"`
   指派 owner、`team_task_list` / `team_task_get` 读板，以及验收后的工单 `done` / `cancelled`。
3. **六位专家改为「专家小组长」**：每个任务先 `spawn_teammate` 建一位专家小组长
   （如 `architect-lead`），再 `send_message` 派该段任务；专家小组长可以自己执行，也可以把
   子任务交给下级 `subagent_<id>`。项目经理**不直接调** `subagent_<id>`。
4. **新配置 `delegationHierarchy`**（默认 `true`）：关闭后回到 2.x 的"只靠协议"行为，适合
   暂时不想让门禁拦住旧流程的部署；协议文本仍是 3.0.0 的三层模型。

**用户要做什么**：重新安装 / 重启 DSH（preset 与协议文本都在启动时确定）。旧习惯（指挥官自己
`claim` / `complete`、直接调 `subagent_<id>`）会收到拒绝与纠正指令，按拒因改走小组长即可；
确实要回退硬门禁就设 `delegationHierarchy: false`。

## 指挥者模式（含项目经理职责，5.0.0 合并）

输入框模式菜单里**唯一**的模式（`preset.commander`，`order: 7`）。它同时承担原先两个模式的
职责：既回答「**谁来做**」（接单、拆解、派活、验收），也回答「**怎么拆分、每段怎么验收**」。

**5.0.0：六段工作流不再是模式差异。** 3.6.0 起六段流水线已降级为可选 skill（真实会话
`session-137678b5` 里，"读交接文档 + 打安装包发版"被拆成六段串行，架构段先开工）；
5.0.0 又把「按任务形状拆分」「验收与收口」两节并入本模式的协议。于是原先的
「项目经理模式」只剩一个空壳——它的独有能力都已按需化，所以合并成同一个模式：

| 原先的区别 | 现在 |
|---|---|
| 专家团 | **按需**：六位专家是名册里的专家小组长，按任务形状选用，不是每单派满 |
| 六段工作流 | **按需**：`skill` 加载 `project-dev-workflow`，可只取其中一段，不是每单必走 |
| 工单账本 / 计划授权 | **可选严格流程**：工具都在（`ledger: true`），但 `requireMandate` / `requireTicket` **默认关**；打开即回到旧版指挥者的严格流程 |
| 验收判据 / 落盘证据 / 独立验证 | 并入本模式协议（每个任务都要过） |

**3.0.0 起：六位专家 = 六位专家小组长**（团队模型 L1）。每个任务先 `spawn_teammate` 建一位
专家小组长、`send_message` 派该任务；专家小组长可以自己执行，也可以把子任务交给下级
子智能体（`subagent_<id>`）。指挥者**不直接调用** `subagent_<id>` / `subagent` /
`subagent_fork`——直调会被门禁拒绝（见「3.0.0 团队模型」）。建议的小组长名字：
`architect-lead`、`implementer-lead`、`reviewer-lead`、`tester-lead`、`security-lead`、
`doc-writer-lead`（`security-auditor` 的小组长名是 `security-lead`）。

### 一个模式的内部结构

preset 在 DSH 里是**完整组合**，不是全局工具集上的叠加层。5.0.0 起只有一个 preset，
它的 `plugins` 由 `lib/preset-plugins.js` 从 `lib/capabilities.js` 单一来源拼装
（能力行 18 行 + 模式行 + 可选工作流行，共 20 行）：

| 组成 | 内容 | 落在哪 |
|---|---|---|
| **能力行** | 与 `@deepseek-ai/dsh-preset-standard` 对齐的 18 行（读 / 写 / shell / skill / 压缩 / 编排 …），**只有一份**（3.7.0 起 `cordis.patch.yml` 不再写它） | `lib/capabilities.js`、`lib/preset-plugins.js` |
| **模式行** | 指挥者协议 + 门禁 + 专家安装（`commander-mode-agent`） | `agent.js`、`lib/protocol.js` |
| **可选工作流** | 只注册 skill `project-dev-workflow`（按需加载，不注入常驻 prompt） | `workflow.js`、`lib/workflow.js` |
| **配置行** | profile 顶层行（`commander-mode`）：`Config`、`commanderSettings` 服务、设置页 | `index.js`、`lib/config.js`、`client.js` |

> 为什么声明器要自带一份：插件页「包含的组件」每一行的标题由**该行的模块名**决定
> （Host 的 `declaredRows()` 调 `pluginPackages.metaOf(row.name, base)` 读该模块的
> `locale/*.json`）。用随附的 `@deepseek-ai/dsh-agent-preset` 时标题会显示成通用的
> 「Agent 预设定义」。自带一份后标题显示**「指挥者模式」**。语义与随附声明器一致
> （`register(config)` + 卸载释放），差异只有「不设 `EntryGroup`」这一点，见「已知边界」。

**按任务形状拆分（3.6.0 起，不再预设流水线）**：指挥者先判断"这次要交付什么、需要哪些
能力、任务之间有没有真实依赖"，再拆任务。常见形状：

- **打安装包 / 发版 / 出交付物** → 一位发布小组长（加载 `app-packaging` 方法）+ 必要时一位
  **独立**验证小组长；不需要架构、审查、测试、安全、文档五段；
- **交接 / 接手存量项目** → 一位接手小组长产出"接手结论 + 后续事项 + 缺口证据"；
- **单点缺陷 / 小改动** → 实现任务 + **独立**验证任务；
- **排障 / 诊断** → 先只读侦察定位，再派修复；
- **从零开发 / 大改造 / 需要完整交付链** → 可选六段工作流（见下）。

**无论什么形状都成立的硬要求**：每个任务有**可观察的验收判据**、完成必须有**落盘证据**、
需要独立审查或独立测试的必须派**独立于实现者**的小组长、**不为了走流程制造依赖**
（不要为了"顺序"给每张任务加 `blocked_by`）。

**可选六段工作流**（`skill` 加载 `project-dev-workflow`，可只取其中一段；每段写清输入、
产出、验收判据、不通过怎么办）：

1. **架构**（专家小组长 `architect-lead`，需要时由它交给下级 `subagent_architect`）：需求 → 方案 + 任务拆分（写作用域、验收判据、依赖）。
2. **实现**（专家小组长 `implementer-lead`，可交下级 `subagent_implementer`）：按方案产出可运行改动 + 自检证据。
3. **审查**（专家小组长 `reviewer-lead`，**必须独立于实现者**）：按严重程度给可定位意见。
4. **测试**（专家小组长 `tester-lead`，**必须独立于实现者**）：真实执行用例并保留原始输出。
5. **安全**（专家小组长 `security-lead`，交付链完整时建议保留）：按攻击面排查，带证据与风险等级。
6. **文档**（专家小组长 `doc-writer-lead`，交付链完整时建议保留）：文档与最终实现一致，可直接照做。

**每个任务结束三件事**：git 分类提交（**未提交视为该任务未完成**）、任务板结算（3.0.0 起
由该任务小组长 `complete`，项目经理只核对）、证据归档。
最终汇报要列提交分类与短哈希、是否还有未提交内容。

**开局**：按工作纪律优先建 Team（`spawn_teammate`）与共享任务板（`team_task_create`）；
3.0.0 起每个任务都要先建**专家小组长**再派活（它自己执行或交下级），项目经理不再直接派
`subagent_<id>`。专家工具默认**异步派发**（立即返回 childId，结算时用「【项目经理·派工完成】」
通知唤醒**调用它的小组长**），所以派活后不要等——继续推进其它任务或做只读核对。

**确定性约束**（不靠提示词自觉）：

- 项目经理自己调用 `write` / `edit` / `pwsh` / `bash` / `job_kill` / `plugin_manager`
  会被**直接拒绝**（复用 `lib/guard.js`；子代理必须放行，否则专家干不了活）；
- 3.0.0 起还会拒绝：直接调 `subagent_<id>` / `subagent` / `subagent_fork`、自己
  `team_task_update` 改进度/排期（`claim` / `release` / `complete` / `reopen` /
  `set_dependencies`）、自己 `commander_ticket_update` 报推进状态（`progress` / `waiting` /
  `ready` / `blocked` / `failed`）——这些交给小组长（`delegationHierarchy: false` 可关闭）；
- `wait_agent` 会被**无条件拒绝**（3.1.0 起禁止等待、无开关；3.2.0 起整条链生效，见「禁止等待子智能体」一节）；
- 协议里明确**禁止人日 / 人天 / 工期估算**，用「步骤 + 验收判据 + 依赖」代替；
- 收尾必须写经验教训，并额外回答「这个模式本身哪一步形式化了、哪一步产物无法验收、
  哪条纪律没被协议覆盖」。

**专家名册只有一份（5.0.0）**：六位专家小组长共用同一个 `commanderSettings` 服务，
名册改动对新会话生效；当前会话保持启动时的名册。专家 preset 的 id 由
`specialistPresetId()` 复算，重复注册时只补 `subagent_<id>` 工具，不会丢掉专家通道。

## 项目开发工作流（2.0.0；3.6.0 起拆成按需组件）

本模式附带的可选组件（`dsh-commander-mode/workflow`）。**3.6.0 起它只注册一个
skill（`project-dev-workflow`），不再注入常驻 prompt section**：3.5.0 及以前它带着
`order: 640` 的 section 每轮注入模式，配合协议里"六段必须走完"的写法，把发版打包、
交接这类任务也逼成六段串行。现在它是**可选执行手册**：指挥者与专家小组长都可以用
`skill` 工具按需加载，**也可以只读需要的那一段**；不加载也能正常干活。

手册内容：每段的**目的 / 必做动作 / 必须落盘的产物 / 验收判据 / 失败返工规则 /
对应专家与团队用法**。

3.0.0 起每段的「对应专家」是**专家小组长**：组件里写清该段用哪位小组长（如 `architect-lead`）、
它可以把哪些子任务交给下级子智能体（如 `subagent_architect`）、以及**任务板由该段小组长
结算**（`team_task_update` `complete`）——指挥者只核对 owner 与证据，不自己改状态。

它同时是 **20 个方法 skill 的阶段索引**——这些 skill 在本包 `skills/` 目录里，由本模式的
`skill-filesystem.config.customSkillDirs` 加载：

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

## 禁止等待子智能体（3.1.0 起无开关；3.2.0 起整条链生效）

历史会话里 `wait_agent` 被当成了"挂机等子代理"：会话 5d9b3002 里 39 次等待合计 **231 分钟**、
单次最长 **127.5 分钟**；会话 3b342fc5 里 101 次合计 **667.5 分钟**（11.1 小时），其中 6 次
直接等满 1800000ms。用户复盘时的要求是：**等子代理不要一直等**。

2.0.0 曾用 `maxWaitMs` 限制单次等待时长（默认 120s，配 `0` 可关闭）。**3.1.0 起这条不再
"限制"，而是"禁止"**——用户 2026-11-11 的补充要求是「禁止等待子智能体，且不设开关」；
**3.2.0 又追加一句「不要等」**，于是禁令从"只拦指挥官"扩到**整条指挥链**：

- `lib/guard.js` 的 `evaluateWaitForbidden()` 在 `tools/pre-execute` 上对 `wait_agent`
  调用**无条件拒绝**，拒绝理由就是纠正指令（读状态 / 追问 / 汇报收尾）；
- **没有任何配置项可以放开**：`maxWaitMs` 已整体移除（schema / 读取器 / patch / 文档全删），
  也**不受** `delegationHierarchy`、`blockedTools` 影响——`wait_agent` 不是"可配置的门禁"，
  而是一个被硬禁用的工具；
- **3.2.0 起不按身份放行（整条链都不许等）**：指挥官、小组长（teammate）、子智能体一律
  拒绝——**不要等下级，也不要等上级**；身份读不到也**拒绝**（这与其它门禁"宁可漏拦"的
  方向相反，理由是**等待不是完成工作所必需的动作**：拦错的代价只是少一条捷径，放过的代价
  是把"挂机"重新引回来）；
- 传什么 `timeout_ms` 都没用：不存在"短等"，也不存在"超时"这个动作。

**不等之后靠什么**（拒因里也这么写）：

1. **完成通知会自己回来**：下级结算时用「【派工完成】」通知**主动唤醒**它的调用者
   （`agent.steer()`），不需要等；
2. **要看状态**：`list_agents` / `team_task_list` / `team_task_get`（读状态，不挂起）；
3. **要推进**：`send_message` 追问或追加指令；疑似停滞用 `interrupt_agent` 纠偏或换人；
4. **没有可推进的事**：给用户（或上级）一句话阶段汇报并**结束回合**，等完成通知唤醒。

**派活时要把这条写进 prompt**：小组长也不许等它的下级——明确要求「不要等下级，靠完成
通知与读状态推进」。不写这句，小组长会按默认习惯挂机等，整条链的禁令在它那一层就等于没生效。

历史数据说明"限制时长"不够：只要还能等，模型就会把"等"当成默认动作；只要还能配，部署里
就会出现"这次先关掉"。所以 3.1.0 把开关一起删掉了；3.2.0 又把"只拦指挥官"这个残留的
放行面也删掉了。配置项里已不存在 `maxWaitMs`（见「配置」一节）。

## 开箱预置的专家（按主流软件开发流程）

0.2.0 参考 [ToxicantX/dsh-multi-model-orchestrator](https://github.com/ToxicantX/dsh-multi-model-orchestrator)
加了第二条派发通道：**名册里的每个 specialist 是一个独立工具**。

> **3.0.0 起这些专家由小组长使用**：指挥官的通道只剩 Team（`spawn_teammate` 建小组长），
> 一次性 `subagent_<id>` 归小组长调用；指挥官直调会被门禁拒绝。见「3.0.0 团队模型」。

0.3.0 起**开箱就带一套按主流软件开发生命周期划分的专家**，装好即可派活，不用先配置：

| id | 定位 |
|---|---|
| `architect` | 系统架构与拆分：需求拆解、技术方案、接口与数据模型设计（不直接写实现） |
| `implementer` | 代码实现：按既定方案写/改代码，补齐边界处理，产出可运行改动与自检结果 |
| `reviewer` | 代码审查：正确性、可维护性、风格一致性与潜在缺陷，按严重程度给意见 |
| `tester` | 测试：设计并补齐覆盖改动的测试，运行验证并报告明细，复现缺陷给最小步骤 |
| `security-auditor` | 安全审计：依赖漏洞、注入与越权、密钥与敏感信息泄漏、不安全默认值 |
| `doc-writer` | 文档：README、API 说明、使用与迁移文档 |

预置专家的 `provider` / `model` 是**空的**，语义是**继承指挥者（父会话）的模型**——不同
部署可用的模型完全不同，预置名册不能硬编码任何模型 id，否则在别人的部署里就是坏配置。
想给某个专家绑定专属模型时，在设置页把两栏都填上即可（两栏必须同时填或同时留空）。

> **这些专家不会出现在模式菜单里。** 每位专家内部需要一份独立 agent preset 来承载人设
> （0.3.x 的子代理接口不再接受 `persona` 参数），而注册的 preset 默认会出现在模式选择
> 菜单 —— 所以本插件把 `commander-specialist-*` 从目录读取（`agentPresets.remoteExportList`）
> 里过滤掉了。**只隐藏目录条目，注册与挂载不变**：专家仍按 id 挂载、人设照常生效，
> 诊断通道（`list()` / `compositionInventory()`）也仍能看到它们。见 `lib/preset-catalog.js`。

预设清单在 `lib/presets.js`（`DEFAULT_SPECIALISTS`）。设置页里的**「恢复预置名册」**按钮
把草稿恢复成这份出厂清单——**只改草稿，仍需点「保存」才落盘**，点「放弃」可还原。

### 在设置页里调整名册

「设置 → 插件 → 指挥者专家名册」。**专家行默认折叠**（只显示 `id` + 摘要：模型路由与职责），
点击标题栏展开编辑、再点收起 —— 六个预置专家全部展开会铺满好几屏，折叠后一屏就能看全名册。
新增行会自动展开；点保存时若某行校验失败，出错行也会自动展开。

展开后每行：

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9_-]{0,47}$`，名册内唯一；工具名就是 `subagent_<id>` |
| `provider` / `model` | 否 | 该专家的模型路由；**两栏都空 = 继承指挥者的模型**（要么都填、要么都空） |
| `description` | 是 | 展示给指挥者的职责摘要（= 定位），用来选人 |
| `persona` | 否 | 追加到该专家人设末尾的专属提示词（预置项都有） |
| `reasoningEffort` | 否 | 该模型支持的推理等级 |
| `maxTokens` | 否 | 该专家的输出上限 |

保存后：**新会话**立刻拿到新的 `subagent_<id>` 工具（工具清单在启动时确定；3.0.0 起这些工具
由小组长使用，指挥官直调会被门禁拒绝）；已打开的会话保持启动时的名册 —— 设置页里也这么写。

于是同一个会话里，小组长可以把"实现"交给跑在小模型上的 `subagent_implementer`、把"审查"交给
跑在强模型上的 `subagent_reviewer`，而不是所有子代理都继承父会话的模型。

### 派发通道怎么选（3.0.0：指挥官只走 Team）

| 通道 | 工具 | 谁用 | 适合 |
|---|---|---|---|
| **智能体团队** | `spawn_teammate` / `send_message` / `team_task_*`（`wait_agent` 硬禁用：3.1.0 起无开关、3.2.0 起整条链生效） | **指挥官（唯一通道）** | 长期存在的具名小组长、持续对话、共享任务板、后台并行 |
| **多模型 specialist** | `subagent_<id>`（前台，结果直接返回） | **小组长**（L1） | 独立模型/专门职责、一次性的实现/审查/分析 |

3.0.0 起指挥官的通道只剩 Team：直调 `subagent_<id>` / `subagent` / `subagent_fork` 会被门禁
拒绝，一次性 specialist 由小组长自己调用（`workflow` 不在拦截范围）。两条通道可混用；
同一批文件不要同时交给两条通道。名册为空时协议里不会出现 specialist 相关文字。

**没有「智能体团队」的部署会自动降级**：一次性子智能体成为指挥官**唯一**的派活通道
（门禁同步降级放行），协议里会显式写明"本部署没有 Team 工具、小组长这一层建不起来"——
**不是静默降级**，见「3.4.0：门禁交叉冲突排查与降级放行」一节。

### 派活前必须做「定位匹配」

每个执行者都有**固定定位**：小组长的定位写在它的 `description` 与 `prompt` 里；它派出的
一次性 specialist 的定位写在名册那一行的**职责描述**里（工具描述里也写着同一句）。派一个
任务之前，先拿任务性质去对：**领域、产出类型、需要的技能**。

| 情况 | 做法 |
|---|---|
| 任务落在定位内 | 用对应的小组长，正常派活 |
| **差距大**（跨领域 / 不同产出 / 另一套技能） | **不要硬派**：先换一个匹配的小组长；没有就**开一个新的小组长**（3.0.0 起"开新子智能体"= `spawn_teammate`） |
| 一个任务里混着两种定位的工作 | 拆成两个任务，分别派 |
| 找不到任何匹配定位 | 把任务与候选定位写进正文，问用户 |

**"开一个新的小组长"怎么做**（3.0.0：开新子智能体 = 开新小组长）：

- **`spawn_teammate` 就是入口** — 名字、`description`、`prompt` 都由指挥者写，
  所以可以按这次任务的定位新建一个小组长（例：现有 `reviewer-lead` 做代码审查，这次要"依赖
  漏洞扫描" → spawn 一个 `security-lead`，把定位写进它的 description 与 prompt）。
- **名册不能由指挥者改**（那是用户在设置页配的，决定小组长能派哪些 `subagent_<id>`）。
  若这个新定位以后会反复用，指挥者会用 `ask_user_question` 建议把它加进名册 —— 下次小组长
  就能直接复用，还能绑定专属模型。
- **判断口径**："顺带多做一点同领域的小事"可以接受；**"这是另一类工作"必须换人**。
  硬塞的代价是双向的：它要么硬做出低质量结果，要么回来报范围冲突，指挥者都得再来一轮。
- **执行者侧也有兜底**：specialist 的人设要求它在收到明显超出定位的任务时先报"任务与我的
  定位不符"，而不是硬做或沉默地按自己的理解做。

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

装好后在模式菜单里会出现「指挥者模式」（`order: 7`，5.0.0 起是唯一的模式）。
模式在**新会话**里选择，已有会话的 preset 在第一轮之前就已绑定。

> **声明方式：本包自带声明器**。模式由 `preset-commander` 子路径模块注册（实现见
> `lib/preset-declaration.js`，语义等价于随附的 `@deepseek-ai/dsh-agent-preset`），
> 只依赖随附的 `agentPresets` 服务。
> **随附的「Agent 预设定义」那一行被禁用 / 缺失时，本包的模式照常出现**——
> 2.1.0 起就不再依赖它了（2.0.x 时代才是依赖）。
>
> **`skills/` 目录**：本包 `skills/` 下的 20 个方法 skill 由本模式的
> `skill-filesystem.config.customSkillDirs` 加载（按包名定位包目录，不写死绝对路径）。
> `dsh plugin add` 用 `link:` 安装，目录随包在工作区里，不需要额外构建步骤。

## 它怎么保证"指挥者不执行操作"

两道保障，一道是概率性的、一道是确定性的：

1. **协议**（system-prompt section，`order: 650`，每轮重新求值）——告诉模型它是指挥者，
   该派活。它不会被遗忘，也不会被上下文压缩掉。
2. **门禁**（`tools/pre-execute` waterfall）——指挥者自己调用执行类工具会被**直接拒绝**，
   拒绝理由就是纠正指令（"先用 `ask_user_question` 确认计划 → 派给小组长"）。

门禁挂在 preset scope 上，所以**只对指挥者模式下的 agent 生效**，别的模式完全不受影响。

3.0.0 起还多三条「谁来做」门禁（任务板写入 / 工单推进状态 / 子智能体派发），同样是
`tools/pre-execute` 上的确定性拒绝，见「3.0.0 团队模型」一节。

### 执行边界：什么算「执行操作」（2.2.0 起补齐）

判据不是"是不是本地文件操作"，而是**"会不会改变工作区 / 宿主 / 外部系统的状态"**。
默认拦截 **48 项**，按类别：

| 类别 | 工具 |
|---|---|
| 本地 | `write` `edit` `pwsh` `bash` `job_kill` `plugin_manager` |
| 远程执行 | `ssh_exec` `ssh_job` `ssh_upload` `ssh_download` `ssh_fetch` |
| 桌面注入 | `desktop_mouse_move/click/drag/scroll` `desktop_key_press` `desktop_type_text` `desktop_ui_invoke` `desktop_ui_set_value` `desktop_window_focus` |
| 浏览器改动 | `browser_connect/disconnect/navigate/click/type/fill/press_key/hover/drag/upload_file/handle_dialog/evaluate/close_page` |
| 模拟器控制 | `android_avd_create` `android_emulator_start/stop` `android_apk_install` `android_app_launch/stop` `android_ui_tap/swipe/input/key` |
| 持久终端 | `terminal_open` `terminal_send` `terminal_signal` `terminal_close` |
| 仓库状态 | `create_worktree` |

**只读侦察不受限**（这些不在清单里）：`read` / `glob` / `grep` / `read_image` / `web_*` /
`skill` / `session_*`、`ssh_host`、`desktop_screenshot` / `desktop_screen_info` /
`desktop_ui_dump` / `desktop_windows_list`、`browser_status` / `browser_snapshot` /
`browser_screenshot` / `browser_console` / `browser_network` / `browser_list_pages` /
`browser_ping` / `browser_wait_for`、`android_status` / `android_screenshot` /
`android_ui_dump` / `android_ui_wait` / `android_logcat`、`terminal_read` / `terminal_list`、
`job_output` / `job_list`、以及全部调度工具。

> **为什么补这一刀**：session-a0c0b646（2026-11-09）是旧的项目经理模式（现已并入），Lead 本地
> `write`/`edit`/`pwsh` **0 次**（代码活确实派出去了），但它自己跑了 **51 次 `ssh_exec`**
> + 2 次 `ssh_upload` + 1 次 `ssh_job`，在远程 PC 上 dir/ver/powershell 一路操作 —— 用户
> 看到的就是"指挥者亲力亲为"。根因就是判据只盯着本地六个工具。

### 为什么不干脆把 `write` 从 preset 里裁掉

因为裁不掉，这是硬约束：子代理通过 `agentPresets.composeFrom()` 加入**父会话的同一个
preset scope**（`bindScopeParent(childKey, generation.key)`），而 per-child 的工具限制
只能**收紧**、不能扩展。一旦把 `tool-fs` / `tool-pwsh` 从 preset 里删掉，teammate 也会
一起失去这些能力，模式就彻底干不了活了。

所以能力行必须保留，边界落在"**谁可以调用**"这一层——这也正是 `tools/pre-execute` 存在的
意义。

### specialist 为什么不受门禁影响

specialist 跑在**自己的独立 preset** 里（`commander-specialist-<id>-<hash>`），组合里
**没有** `commander-mode` 这一行 —— 所以它看不到指挥者协议、也不经过这条门禁。它的人设由
`dsh-commander-mode/specialist` 行注入（职责、边界、可靠性要求）。

### 判错方向的代价是不对称的

门禁最怕的不是漏拦，而是**拦到子代理**。所以 `lib/guard.js` 里每一个"拿不准"的分支都
走放行：

- 读不出 agent 身份（没有 `session.header`）→ 当作子代理，放行；
- 判定过程抛错 → 放行，并让工具调用继续；
- 这个部署里一个派发工具都没有（用户关掉了「智能体团队」、名册也为空）→ 放行（否则死锁）。

> **唯一的例外是「禁止等待」门禁**（3.2.0）：它**不按身份判定、也不"拿不准就放行"**——
> 指挥官、小组长、子智能体与身份读不到的调用一律拒绝。理由是等待不是完成工作所必需的
> 动作：拦错的代价只是少一条捷径，放过的代价是把"挂机"重新引回来（见「禁止等待子智能体」）。

身份判别的三个证据都来自 `childSessionMeta()`：`header.parentSession`、
`header.origin === 'subagent'`、`header.delegationDepth > 0`。

## 依赖：智能体团队

3.0.0 起 Team 是**指挥官唯一的天然通道**：没有它就建不出小组长，三层指挥链退化为协议
（见「已知边界」）。

Team 通道用的是 `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」）
提供的九个 Team 工具：`spawn_teammate`、`send_message`、`wait_agent`、`list_agents`、
`interrupt_agent`、`team_task_create/list/get/update`。其中 `wait_agent` 在 3.1.0 起硬禁用
（无开关）、**3.2.0 起整条链生效**（指挥官、小组长、子智能体都不许等，见「禁止等待子智能体」
一节）；它仍留在 Team 组合包的工具清单里，但本插件的 preset scope 会确定性拒绝它。

它们注册在每个 Team 成员 agent **自己的 ctx** 上（Lead 是隐式 Team 的 Lead，因此也是成员），
所以**本插件的 patch 不需要、也不该重复声明它们**。那个组合包同时禁用了旧的
`tool-subagent*` 控件（0.2.2 起是 `tool-subagent-control` / `tool-subagent` /
`tool-subagent-fork` 三行；`list-agents` 子路径导出已移除、`list_agents` 并进主入口），
因此本插件的 preset **有意不镜像** standard 的 delegation 组里那三个 subagent 行——
重新声明它们会让指挥者同时拿到两套 `send_message` / `list_agents` / `interrupt_agent`。

preset 里只保留 `workflow-ptc` + `tool-workflow` 作为互补的编排通道（一次性扇出多个 fresh
子代理）。

> **specialist 工具与 Team 工具为什么不冲突**：specialist 工具是本插件用
> `ctx.tools.register()` 注册的 `subagent_<id>`，工具名与 Team 的九个工具完全不同；
> 它也不声明 `tool-subagent` 那一族随附控件，所以两套通道可以并存。

## 共享任务板投影（1.2.0）

**解决的问题**：工单账本在磁盘上，用户在「智能体团队」面板里看不见；而任务板又只有
4 个状态，替代不了账本。1.2.0 的做法是**单向投影**：账本继续当唯一权威，任务板当它的
可见层。

```
工单账本（JSON，跨会话，门禁的同步数据源）
   │  每次状态迁移（工具 + 后台结算）
   ▼
team-board-bridge（best-effort，永不抛错）
   │  ctx.get('agentTeams')：createTask / updateTask / getTask / listTasks
   ▼
Lead 会话日志 → agentTeam 投影 → Agent Teams 面板
```

**投影出来的任务长这样**（描述前三行是机器 marker）：

```text
[commander:ticket=t-17]
[commander:channel=team]
[commander:status=working]

<intent>
## 验收判据
- ...
## 执行者
Team 通道：owner 由插件自动绑定
```

| 工单状态 | 任务 status | 说明 |
|---|---|---|
| `open` | `pending` | 无 owner |
| `working`（Team 通道） | `in_progress` | `spawn_teammate` 结算后 owner = 队友 |
| `working`（specialist / worker） | `pending` | 一次性执行者不是 Team 成员，板上无主 |
| `waiting` / `review` / `blocked` / `failed` | 保持原 status | 板上无法表达，真实状态见 `[commander:status=...]` |
| `done` | `completed` | pending 时 Lead 先 claim 再 complete |
| `cancelled` | `deleted` | 删除墓碑 |

**三条纪律**（也写进了协议 section，装团队时出现）：

1. **板上的投影任务不要重复创建**；模型自己建的旧任务会被**收养**（marker 插入描述最前），
   不会出现两份。
2. 任务板只有 4 个状态，`review / blocked / failed` 以描述 marker 与「指挥者·工单看板」为准。
3. **改进度用 `commander_ticket_update`**；直接改投影任务会被下次同步覆盖。

**Team 通道自动绑定（D）**：`spawn_teammate` 成功后，插件把这张工单的投影任务
`reassign` 给该队友（Lead 权限），所以"建板必有主"不再依赖模型自觉。派发门禁额外要求
Team 通道的工单必须有有效投影（`requireTeamTask`，没有 Agent Teams 时自动跳过）。
**3.3.0 起缺投影会自愈**：门禁先让插件自己补建（`ensureTeamTask`），补建成功直接放行；
只有补建失败才拒绝，且拒因只给当前实现允许的动作（见「3.3.0」一节）。

**writeScopes 清洗规则（3.3.0）**：工单的 `scope` 会经 `sanitizeWriteScopes()` 清洗后才进
任务板 `writeScopes`——**只接受工作区相对路径**（如 `src/app`、`docs/README.md`）；绝对路径
（`E:\repo\src`、`/home/user/src`）、空段、`.` / `..` 段一律**丢弃**，`\` 统一成 `/`、去掉
前导 `./` 与尾随 `/`、去重保序、最多 40 条。理由：运行时 `agentTeams.createTask()` 的
`writeScope()` 会拒绝这些值并抛 `TEAM_INVALID_WRITE_SCOPE`，原样透传会让整次投影失败
（会话 `def6609d` 就是这么死锁的）。后果与边界：`writeScopes` 只是 advisory（板上"写作用域
重叠"提示），**丢弃不影响派发**；工单本身保留完整 `scope`，任务描述里也有背景说明。

**降级**：没有 `agentTeams` 服务 / 当前 agent 不是 Team 成员 / 方法缺失 → 全部 no-op，
行为与 1.1.x 逐字一致（协议文本都不变，有测试钉住）。

## 3.3.0：门禁死锁修复 + Worker 停滞看门狗

3.3.0 修的是**一个真实会话（`session-def6609d`）最后静默挂死**的问题。它不是单个 bug，而是
"投影 → 派发门禁 → 层级门禁 → Worker 兜底"四层叠起来的死锁。

### 根因链（六步）

1. **工单 `scope` 是 Windows 绝对路径**（`E:\repo\tools\...`）；
2. **投影器把它们原样塞进任务板 `writeScopes`**，而运行时 `agentTeams.createTask()` 的
   `writeScope()` **拒绝绝对路径**——盘符开头（`^[a-z]:`）、前导 `/`、空段 / `.` / `..` 段
   都算非法，直接抛 `TEAM_INVALID_WRITE_SCOPE`；
3. **投影失败被静默吞掉**（只记 debug）→ 工单没有 `teamTaskId`；
4. **派发门禁 D-1 拒绝 `spawn_teammate`**，并让模型"更新工单状态（例如 progress）触发投影"；
5. **但 3.0.0 起指挥官改工单推进状态被层级门禁拒绝** → **两条门禁互相矛盾，Team 通道永久
   不可用**（会话里模型自己写下"门禁自相矛盾形成死锁"）；
6. **模型退到 Worker Session**，worker 卡在**回合中途**（长时间无事件、没有 `turn/end`）：
   idle 兜底只在 `agent/status = idle` 触发，worker 永远不 idle、也不 `commander_report` →
   指挥者等不到唤醒，整个会话静默挂死。

### 三条修复

1. **投影层：清洗 `writeScopes` + 失败不再静默。**
   - 新增导出纯函数 `sanitizeWriteScopes()`：按运行时 `writeScope()` 的规则清洗——绝对路径
     （盘符 / 前导 `/`）、空段、`.` / `..` 段一律丢弃；`\` 统一成 `/`、去掉前导 `./` 与
     尾随 `/`、去重保序、最多 40 条。**丢弃是安全的**：`writeScopes` 只是 advisory（板上
     "写作用域重叠"提示），工单本身保留完整 `scope`，任务描述里也有背景说明。
     `projectContent()` 已改用它。
   - 投影失败从 debug **升到 warn**（带错误码，例如 `TEAM_INVALID_WRITE_SCOPE`）：投影失败
     不是无害降级——它会让 Team 通道被派发门禁挡死，必须能在日志里看到。
2. **派发门禁自愈：缺投影时插件自己补建。** `evaluateDispatchGate()` 变成 async，新增
   `ensureTeamTask`：缺投影时走投影器**自己补建**（`teamBoardBridge.createProjection`），
   成功就直接放行；只有补建失败才拒绝，且拒绝理由只给**当前实现允许**的动作——
   用 `commander_ticket_update` **只改描述字段**（title / intent / acceptance / scope，
   **不要带 status**）让投影重建，或改用 `commander_worker_spawn`（Worker Session 不要求
   任务板投影）；并明确写「不要用 status 触发投影，会被层级门禁拒绝」。
3. **Worker 停滞看门狗**（`lib/worker-sessions.js`）：每 **60 秒**扫描一次；带 `execution`
   的未结束工单，若 `now - startedAt >= ticketStallMs`（默认 10 分钟）且**开工后从未回报**，
   就 `steer` 指挥者（同一张工单 10 分钟节流），提示"可能卡在回合中途（不会触发 idle）"，
   给出三步处置：①有产物在增长 → 追问进度；②完全没动静 → `commander_worker_stop` 停掉后
   补派；③标记 blocked 上报用户。**只提醒，不自动改状态。**

### 用户要做什么

**重启即可**（门禁与看门狗都在启动时装配），**不需要改任何配置**。若之前被这个死锁卡过：
重启后 Team 通道会自愈（缺投影时插件自动补建）；投影失败现在会以 warn 级带错误码出现在日志里。

## 3.4.0：门禁交叉冲突排查与降级放行

用户要求「再检查一下是否还有类似的问题，这种逻辑冲突可能之前在单独开发时没有注意到，
但是完成后可能会相互冲突」。3.4.0 对**门禁 × 门禁、门禁 × 部署能力、门禁 × 配置**做了
系统交叉审计：同类问题（"门禁假设了一个可能不存在的能力"）共 **6 处**——3.3.0 修了 1 处，
3.4.0 修了 **5 处**（最初审计发现 3 处，收尾复核又发现 2 处）。

### 六条冲突（冲突 → 后果 → 修复）

1. **派发门禁 D-1 要求任务板投影 ↔ 层级门禁禁止指挥官改工单状态**（投影只能由状态更新触发）
   → Team 通道永久不可用 → **3.3.0 已修**（缺投影时插件自愈补建，见上一节）。
2. **一次性子智能体派发被层级门禁拦 ↔ 该部署没有 Team 工具**（`spawn_teammate` /
   `send_message` 都不在）→ 指挥官既不能自己动手、也不能派活 → **模式死锁**
   → **3.4.0 修**：`evaluateSpecialistDispatch()` 在没有 Team 通道时**降级放行**。
3. **Mandate 门禁要求"用户确认的计划" ↔ 授权只能由 `ask_user_question` 记录，而该部署
   没有这个工具** → 永远拿不到授权 → 所有派发被永久拒绝 → **3.4.0 修**：
   `availableTools` 不含 `ask_user_question` 时**跳过授权门禁**（协议仍要求先把计划讲给用户）。
   **同一类冲突的配置形态**：`confirmPlan: false` 关掉"规划后确认"后，协议不再让模型调用
   `ask_user_question`，授权同样永远记录不到 → `resolveConfig` 检测到
   `confirmPlan: false` 且 `requireMandate: true` 时**自动把 `requireMandate` 视为 false**
   并给一条 warning（两者是同一个决策的两面）。
4. **协议文本写"派活只用 Team" ↔ 该部署没有 Team 工具** → 模型去调不存在的工具
   （0.1.x 踩过的坑）→ **3.4.0 修**：`renderCommanderSection()` 新增 `hasTeamTools`；
   `false` 时渲染**降级通道段** + 顶部**显式覆盖**；`renderModeOpening()` 收尾句同步；
   项目经理协议追加覆盖段。
5. **`teamTaskProjection: false` ↔ `requireTeamTask: true`（配置层同冲突）** → 关掉投影后
   工单不会出现在任务板上，而 D-1 要求 `spawn_teammate` 前工单已有投影 → **Team 通道永远
   派不出去**（与 `def6609d` 同形状）→ **3.4.0 修**：`resolveConfig` 在
   `teamTaskProjection === false && requireTeamTask === true` 时**自动把 `requireTeamTask`
   视为 false** 并 warning；同时 `lib/ticket-tools.js` 现在**真的尊重** `teamTaskProjection`
   （关掉时工单工具不再投影——此前只有 `syncTicketMirror` 尊重它，配置与行为不一致）。
6. **`blockedTools` 把派发工具全禁掉 ↔ 执行边界仍拦 `write`（死锁）** → `canDelegate` 原来
   只看工具视图有没有派发工具、**不看 `blockedTools`**：用户把 `spawn_teammate` /
   `send_message` 写进 `blockedTools` 后，会得出"能派活"的假结论 → 执行边界继续拦 `write`，
   而真正能调用的派发工具全被禁 → 既不能动手也不能派活 → **3.4.0 修**：`lib/guard.js` 新增
   `hasUsableDispatchChannel({ availableTools, blocked, delegationHierarchy })`——按"**真的
   能调用**"算派活通道：Team（未被 block）→ `workflow`（未被 block）→ 一次性子智能体
   （仅在层级门禁关闭或本部署无 Team 时算，且未被 block）；`agent.js` 的执行边界改用它。

### 降级判据（宁严不漏）

降级判据是"**工具视图可读、且确实没有那个能力**"：

- `availableTools` 是数组 → 按实际内容判定（没有 Team 工具 / 没有 `ask_user_question`
  才降级；"能派活"还要再按 `blockedTools` 过滤，见第 6 条）；
- **视图读不到（`undefined`）→ 按"有"处理**：保持原门禁，宁可漏拦也不因为读不到而放宽。

### 确认"不是问题"的四处

- **执行边界门禁的 `canDelegate === false` 逃生门**与降级放行方向一致：没有**真正可用**的
  派发通道时允许指挥官自己动手，避免死锁；
- **Worker Session 复用 `standard` preset、工具集被限制**（无 `team_task_*` / `wait_agent` /
  `subagent_*`），所以"worker 被当成 Lead"不会触发门禁误拦；
- **`ledger:false` / `asyncDelegation:false` / `workerSessions:false`** 时，协议里对应小节
  本来就条件渲染，不存在"教模型调不存在的工具"；
- **工单结束 / 授权变更 / 容量上限**等门禁彼此不矛盾（有测试覆盖）。

### 用户要做什么

**重启即可**（协议文本与门禁在启动时装配），**不需要改任何配置**。没有「智能体团队」的
部署会自动改走一次性子智能体；没有 `ask_user_question` 的部署不再被授权门禁卡死；
关掉投影或误禁派发工具的配置也会被自动纠正（并给 warning），不会死锁。

## 配置

配置挂在**顶层行 `commander-mode`**（`dsh-commander-mode/host`）上，
`cordis.patch.yml` 里已写好默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `confirmPlan` | `true` | 是否强制"规划/拆分完成后先让用户确认"。3.4.0：设成 `false` 时 `requireMandate` 会被自动视为 `false`（否则授权永远记录不到，派发全被拒） |
| `escalateOnConflict` | `true` | 是否强制"子代理之间有分歧时交回用户" |
| `maxTeammates` | `16` | 写进协议的建议并行子代理上限（1–16）。3.0.0：8 → 16，与运行时 `subagent.maxActiveSubagents` / `agent-team.maxMembers` 一致；插件不再自己压低 |
| `delegationHierarchy` | `true` | 3.0.0：三层指挥链的三条确定性门禁（任务板写入 / 工单推进状态 / 子智能体派发）；`false` = 只留协议（2.x 行为） |
| `syncGuard` | `true` | 结算同步看板（每轮运行时上下文）+ 回合结束前的同步兜底；关掉只去掉这两样，协议里的同步要求仍在 |
| `blockedTools` | 48 项（本地执行 + 远程 / 桌面 / 浏览器 / 模拟器 / 终端 / worktree，见「执行边界」） | 指挥者不许自己调用的工具；传 `[]` 可只留协议约束。⚠️ 别把**唯一的派发通道**一起禁掉（`spawn_teammate` / `send_message` / `workflow` 等）；即使禁掉也不会死锁——3.4.0 起"能派活"按真的能调用计算，没有可用通道时执行边界会放行你自己动手 |
| `registerSkill` | `true` | 是否把长文协议注册成 `commander-mode` skill |
| `ledger` | `true` | 工单账本（`commander_ticket_*` + 看板 + 计划授权门禁）；关掉退化为 0.5.0 行为 |
| `stateDir` | `''` | 账本位置；空 = `<DSH_HOME>/commander/<profile>.json`。相对路径以 `DSH_HOME` 为基准 |
| `requireMandate` | `true` | 派发新工作前必须有用户确认的计划授权（`commander-plan`）。3.4.0：`confirmPlan: false` 时自动视为 `false`；没有 `ask_user_question` 的部署门禁也会跳过 |
| `requireTicket` | `true` | 每次派发必须带工单（specialist 的 `ticket` 参数 / Team 的 `[ticket:t-N]`） |
| `teamTaskProjection` | `true` | 1.2.0：工单自动投影到 Agent Teams 共享任务板（B）；没有团队服务时自动 no-op。3.4.0：设为 `false` 时 `requireTeamTask` 自动视为 `false`（否则 Team 通道永远派不出去），且工单工具真的不再投影 |
| `requireTeamTask` | `true` | 1.2.0：Team 通道派发要求工单有有效投影（D-1）；没有团队服务时自动跳过。3.4.0：`teamTaskProjection: false` 时自动视为 `false` |
| `requireTeamTaskMarker` | `false` | 1.2.0：Team 通道派发要求 prompt 带 `[task:task-N]` 且与投影一致（D-2） |
| `asyncDelegation` | `true` | 一次性 specialist 异步派发：工具立即返回，完成通知唤醒指挥者；关掉回退前台阻塞 |
| `maxAsyncTasks` | `16` | 同一会话同时在飞的一次性 specialist 上限（1–16）。3.0.0：8 → 16，与运行时并行上限对齐 |
| `workerSessions` | `true` | 每工单独立 Worker Session + 独立目录（1.0.0 起默认开启；`false` 回退到 specialist/Team） |
| `workRoot` | `''` | Worker 目录根；空 = `<DSH_HOME>/commander/work`。相对路径以 `DSH_HOME` 为基准 |
| `maxWorkers` | `6` | 每个指挥者会话同时最多几个 Worker Session（1–12）。2.4.0：3 → 6 |
| `prepareCommand` | `''` | 建 worker 目录后执行一次的 prepare 命令（可用 `DSH_COMMANDER_*` 环境变量） |
| `workerPermission` | `danger-full-access` | Worker Session 的权限预设；目录不是安全边界 |
| `ticketStallMs` | `600000` | 派发后多久没有新回报算"疑似停滞"（只进看板，不自动处理） |
| `maxTickets` | `100` | 账本最多保留工单数（超出裁剪最老的已结束工单） |
| `eventInbox` | `true` | 外部事件投递（1.1.0）：轮询 `events/inbox/` 并 `steer` 对应指挥者会话；关掉不轮询 |
| `eventPollMs` | `15000` | 外部事件轮询间隔（ms，≥1000） |
| `specialists` | 出厂预置名册（**volatile**） | 多模型 specialist 名册，由设置页编辑；默认 6 个按开发流程划分的专家 |
| `maxSpecialists` | `20` | 名册条数上限（每项 = 一个 preset + 一个工具） |

只有 `specialists` 是 volatile：设置页保存后 Loader 热更新运行中的引用（不重载行），
配置行通过 `commanderSettings` 服务广播，模式行据此重建 specialist preset 与工具。
其余字段是加载期配置（含 0.6.0 的 ledger / requireMandate 等），改它们要改 profile patch 并重载。

profile 层覆盖时注意：按 id 定向的 patch 会**整块替换** `config`，所以覆盖
`preset-commander` 必须重述 `id` / `name` / `description` / `order` 和整个 `plugins`
列表；覆盖 `commander-mode`（配置行）必须重述全部 config 键。

## 已知边界

- **投影是单向且尽力而为的。** 任务板上的改动不会回写工单；投影任何一步失败只记 debug 日志，
  工单、门禁、派发照常工作。任务板被用户手动改坏时，下一次工单变更会把它同步回来。
- **投影任务表达不了 4 个以上状态。** `review / blocked / failed / waiting` 在板上显示为
  `in_progress` 或 `pending`，真实状态在描述里的 `[commander:status=...]`；完整视图看
  「指挥者·工单看板」。
- **specialist / worker 的投影任务没有 owner。** 一次性执行者不是 Team 成员，板上的任务
  只能保持 `pending`（描述里标明通道）。Team 通道的任务由插件自动绑定 owner。
- **投影任务不参与同步看板的告警。** 「团队闲置」「孤儿任务」只看**非投影**任务，避免
  投影的 specialist 工单被误判；投影进度由工单看板负责。
- **名册改动对新会话生效。** 已打开的会话保持它启动时的工具清单；旧工具执行时会检查名册，
  发现 specialist 已被移除就给出可执行的错误（提示重新规划），而不是静默派给旧配置。
- **specialist 是"前台一次性"通道。** 它没有 Team 的持续对话、任务板、后台通知；要那些
  语义就用 Team 通道。`subagent_<id>` 会阻塞到该 specialist 结算，然后把最终答复返回。
- **specialist 没有"问用户"的通道。** 它遇到需要用户决定的事只能报回指挥者。
- **安装失败只降级。** 某个 specialist 的 preset/工具注册失败时，插件记 warning 并把它从
  协议里剔除（避免点名不存在的工具）；其余 specialist 与整个模式照常工作。
- **`inactive` ≠ 做完了。** teammate 的 `inactive` 只表示"当前没有轮次在执行"。判断结果
  要看它报回来的内容与验收判据——协议里写明了，但这是模型行为，不是代码保证。
- **同步看板依赖「智能体团队」。** 没有 `agentTeams` 服务（用户关掉「智能体团队」、或这个
  部署没装）时，看板与回合同步兜底都**不产生任何文本**，协议自动切到"看一遍状态、不要轮询"
  的说法；`todo_write` 的计划清单仍会被记录，但没有任务板可对照。
- **同步兜底最多每回合提醒一次。** 模型若坚持不同步，回合会正常结束（不会卡住），下一次
  有新未同步项时才会再提醒。看板只报告**证据充分**的未同步（结算发生在清单更新之后、
  或清单说全完成但板还有未结算任务），读不到的一律按"未知"处理，不误报。
- **同一步先结算再写清单不算未同步。** 写清单时会先把当时的任务板记成新基线——否则
  "先 `team_task_update` 再 `todo_write`"会被误判成清单落后。
- **协议 section 不再注入给 teammate（0.4.0）。** 之前执行者会被灌整份指挥者协议；现在
  子级返回空串。副作用：teammate 也看不到「结算同步」等条款——它们不需要，指挥者负责。
- **孤儿任务与团队闲置是"提示"，不是强拦（0.5.0）。** 孤儿任务（无人认领 / 主人已停手超过
  10 分钟）每条会话只**强制兜底提醒一次**，之后只留在看板里；团队闲置（最近 3 次派活全是
  一次性 specialist 且有未结算任务）**不拦回合**，只在看板里常驻。阈值都写死在
  `lib/sync.js`（`STALE_OPEN_GRACE_MS`、最近 3 次），有单测覆盖。
- **派发配比只统计指挥者自己的派活动作。** `spawn_teammate` / `send_message` 记 Team；
  `subagent_<id>` / `subagent` / `subagent_fork` / `workflow` 记一次性。
  `wait_agent`（硬禁用：3.1.0 起无开关、3.2.0 起整条链生效）/ `list_agents` / `team_task_*` 不计入（它们是读状态与建板，不是派活）。
  重启会重置计数（账本是进程内的），重启后第一次派发的配比从零开始。
  3.0.0 起指挥官只能走 Team，所以这条配比对它恒为 Team；看板保留它是为了历史会话与
  `delegationHierarchy: false` 的回退配置。
- **工单门禁只覆盖 DSH 工具调用（0.6.0）。** 与执行门禁同一边界：如果某个插件通过别的途径
  派活（例如自定义工具自己起子代理），本插件的 `tools/pre-execute` 看不到。
- **工单是"状态"不是"锁"（0.6.0）。** 工单的 `scope`（写作用域）只是提示；执行环境仍共享
  cwd，没有 worktree / 文件锁。真正的执行隔离需要给每个工单独立 Session + 目录
  （Worker Session），属于后续版本方向，不在 0.6.0 内。
- **停滞只是代理指标（0.6.0）。** "派发后 N 分钟没有新回报"不等于任务没进展，也不等于失败；
  看板只提示"先只读核对产物，再决定问用户 / 补派 / 标记受阻"，**不自动重派或结束**。
- **账本是单进程文件（0.6.0）。** 同一 profile 下多进程写同一 `stateDir` 没有锁；正常部署只有
  一个桌面进程，不构成问题。账本损坏时自动备份并用空账本启动，工单会"丢"（历史仍在会话日志里）。
- **没有计划授权也能建工单（0.6.0）。** `commander_ticket_create` 不要求授权；门禁在**派发**时
  检查。这样规划阶段可以先建工单，但"建了工单≠可以派活"。
- **工单工具依赖配置行的账本服务（0.6.0）。** 账本初始化失败 / `ledger:false` 时工具不可用或
  报可执行错误，模式其余部分（门禁、看板降级）仍工作。
- **异步完成通知依赖指挥者 agent 仍存活（0.7.0）。** 会话关闭后再结算：账本仍会写入，但 `steer`
  投递失败（只记 warning），通知丢失——该工单属于旧会话，新会话的看板看不到它。这是"会话内
  模式"的边界，不是队列；要跨会话必须等 1.0 的 Worker Session / 常驻服务。
- **进程重启会清空"在飞"表（0.7.0）。** 重启后未结算的 Assignment 不会自动恢复；工单会以
  "派发后没有新回报"出现在看板（停滞提示），需要指挥者只读核对后补派或标记受阻。真正的恢复
  属于 1.0 的 Worker Session。
- **`maxAsyncTasks` 只限制一次性 specialist（0.7.0）。** Team 通道不受这个上限约束。
- **完成通知≠验收（0.7.0）。** 通知只把结果与 `STATUS:` 送到眼前；是否完成仍要指挥者按验收
  判据核对，再 `commander_ticket_update`。没有 STATUS 的结算按 progress 记录，不能当完成。
- **Worker 会话会出现在会话列表（0.8.0；1.0.0 默认开启后更常见）。** 名字是
  `执行 <ticket>：<标题>`，没有 UI 过滤；它们各自落在 `workRoot/<ticket>` 对应的 workspace 里
  （不是默认工作区）。不想要这类会话就把 `workerSessions: false`，worker 通道与四个工具一起
  消失，派工回到 specialist / Team。
- **Worker 工具收敛不是安全边界（0.9.1）。** 静态 `tools.restrict({allow})` 让模型少看到
  无关工具；但装饰发生在 agent 组装早期，restrict 可能因"未知全局工具"抛错，所以再加
  `tools.guard` 白名单——非工作工具的调用会被确定性拒绝。0.9.1 的真机 E2E 曾经把这条做错：
  按 `tools.get()` 过滤 allow，组装未完成时得到空数组，worker 连 `write` 都没有（只能开子
  代理代写文件）。
- **Worker 恢复是"提示"，不是队列（0.8.0）。** 重启后只有指挥者会话再次创建时才会为 open
  工单的 worker 投递恢复提示；进程内没人触发就不会自动恢复。`worker-<ticket>` Session 依赖
  DSH 自己的会话持久化，会话被删就只剩账本记录（看板按停滞提示）。
- **`prepareCommand` 按用户 shell 执行（0.8.0）。** 它在 `workRoot` 的父目录下跑，超时 10 分钟；
  失败会让 spawn 抛错（带 stderr 摘要），不会反复重试同一条命令。
- **共享工作目录。** 所有 specialist / teammate 观察同一个 cwd，改文件立即可见；本模式不
  提供 worktree 隔离或文件锁。协议要求"写作用域不重叠"，但 `writeScopes` 只是**提示**——
  Bash、formatter、代码生成器与直接外部写入都能绕过它。最终 diff 仍需人（或指挥者的
  只读核对）来看。
- **门禁只覆盖工具调用。** 它拦的是 DSH 工具（`write` / `edit` / `pwsh` / `ssh_*` / `desktop_*` /
  `browser_*` / `android_*` / `terminal_*` …，完整清单见「执行边界」）。如果指挥者
  通过别的途径（例如某个插件的自定义工具）改文件或操作外部系统，门禁不管；`blockedTools`
  可用来补。2.2.0 之前的默认清单只含本地六个工具，导致 `ssh_exec` 这类"远程跑命令"漏拦
  （session-a0c0b646 的 51 次 `ssh_exec` 就是这么来的）。
- **关掉「智能体团队」+ 空名册 = 模式降级。** 那时指挥者没有可用的派发工具，门禁会自动
  放行（避免死锁），模式退化成"只会做协议的普通 agent"。
- **协议是概率性的。** "规划后先确认"与"分歧上报"由协议保证，模型偶尔可能跳过。门禁只兜住
  "不执行操作"这一条——那一条是确定性的。
- **`commander-status` 只读账本，不做恢复（0.9.0）。** 它不会重启 dsh、不会重派/结算工单，
  也不会备份损坏文件（损坏时退出 3）。真正的"恢复动作"仍要由人或下一次会话完成。
- **外部事件需要 dsh 进程在跑（1.1.0）。** 事件是**文件队列**，不是守护进程：进程不在时
  事件只会积压（`commander-status` 的 `events_pending` 可见），不会有人投递。它只投递给
  **已存在 / 可恢复**的会话，不会新建会话或工单；目标会话被删掉时事件会一直留在 inbox。
- **外部事件不做鉴权（1.1.0）。** 能写 `events/inbox/` 就等于能给指挥者发指令级通知；
  单机场景可接受，多用户/共享目录部署要自己限制目录权限。格式坏的事件进 `rejected/`，
  不会无限重试；投递成功进 `delivered/`（各保留最近 200 条）。
- **外部事件的投递是"尽力而为"，不是事务（1.1.0）。** 投递后归档失败时，进程内用事件 id
  去重；跨进程重启后同一个 id 仍可能被投递第二次（至少一次语义），事件正文本身应幂等。
- **preset 声明器是自带的等效实现（2.1.0）。** 组件行标题由**模块名**决定
  （`declaredRows` → `metaOf(row.name, base)` 读该模块的 `locale/*.json`），若用随附声明器
  随附的 `@deepseek-ai/dsh-agent-preset`，标题必然是通用的「Agent 预设定义」。所以本包
  自带一份声明器（`lib/preset-declaration.js`，语义与随附一致：把本行 config 交给
  `ctx.agentPresets.register()`、卸载时释放），行是
  `dsh-commander-mode/preset-commander`，带自己的 locale 与
  icon，于是标题显示「指挥者模式」。
  代价（有意接受）：本行**没有** `EntryGroup` 标记，因此 Loader 会在加载期递归求值
  `plugins` 里的 `!!js`（子行拿到的是已求值的布尔/字符串，而不是惰性表达式）；
  随附声明器则把它们留给子行自己求值。对本包的能力行（平台二选一、`customSkillDirs`）
  两者等价——平台在进程生命周期内不变，`baseUrl` 在加载期同样可用。若将来 DSH 给声明器
  增加新字段，`PresetDeclarationConfig`（`z.object`）需要跟着补；这是刻意的：宁可显式报错，
  也不要静默丢字段。
- **禁止等待覆盖整条链（3.1.0 起硬禁用、无开关；3.2.0 起不按身份放行）。**
  `evaluateWaitForbidden()` 对 `wait_agent` 一律拒绝：指挥官、小组长、子智能体与身份读不到
  的调用**都拒**（与其它门禁"宁可漏拦"的方向相反，理由见「禁止等待子智能体」）。门禁
  **不读任何配置**：`delegationHierarchy`、`blockedTools` 都改不了它，`maxWaitMs` 已整体移除。
- **`wait_agent` 是被硬禁用的工具，不是"配置成很短"（3.1.0）。** 它不在 `blockedTools`
  清单里（那份清单给 `evaluatePreExecute` 用），而是由独立门禁无条件拒绝；因此也不存在
  "DSH 允许 10000–3600000ms"这类下限交叉问题——在这个 preset scope 里这个调用直接不成立。
  传任何 `timeout_ms`（含字符串、缺省）结果都一样：拒绝。
- **工单 / 计划授权默认不强制（5.0.0）。** 合并成单模式后，`commander_ticket_*` 与 Mandate
  门禁的工具都在（`ledger: true`），但 `requireMandate` / `requireTicket` **默认关**：
  工单是可选记账工具，不是每次派活的门槛。要旧版指挥者的严格流程就把这两个开关打开
  （协议会同步切回强制口径）。进度权威仍是**共享任务板 + 每个任务落盘证据**。
- **专家名册只有一份（5.0.0）。** 六位专家小组长共用同一个 `commanderSettings` 服务，
  名册改动对新会话生效（当前会话保持启动时的名册）。
- **协议按名册渲染，不点名不存在的工具。** 名册为空 / 服务缺失时协议走降级段：让小组长
  自己执行，或改用 Team 通道按同样定位新开队友，不要硬调不存在的工具。
- **`skills/` 目录由本模式加载（5.0.0）。** 通过 `skill-filesystem.config.customSkillDirs`
  加载本包 20 个方法 skill；目录缺失或 skill 文件损坏时只影响 skill 加载，不影响协议
  section 与门禁。`skill` 只是方法入口，验收仍看产物与证据。
- **三条「谁来做」门禁只拦指挥官本人（3.0.0）。** `evaluateBoardWrite` / `evaluateTicketWrite` /
  `evaluateSpecialistDispatch` 只对 Lead 生效：小组长 / 子智能体（`isDelegatedAgent` 命中）
  与身份读不出来的调用一律放行（宁可漏拦，不可拦死）。`delegationHierarchy: false` 时三条
  全部关闭，只剩协议约束。**禁止等待门禁不在这一组里**：3.2.0 起它不按身份放行（见下条）。
- **没有「智能体团队」时三层指挥链退化为协议（3.0.0）。** 没有 `spawn_teammate` /
  `send_message` 就建不出小组长：门禁按"宁可漏拦"放行（否则会话死锁），协议里的 Team 通道
  自动降级为"把任务连同验收判据写进正文，请用户决定"。此时"只有小组长改进度"没有执行者，
  规则 4 实际不生效。
- **深度 2 是运行时限制，不是插件限制（3.0.0）。** 插件只把 `subagent.maxDepth=2` 写进协议
  文本；L2 再向下派由运行时拒绝。想加深要改运行时「子智能体」设置，插件不会（也不能）绕过它。
- **任务板写入权只判断"调用者是不是 Lead"（3.0.0）。** 门禁不校验 owner 归属：指挥官
  `reassign` 给某个 teammate 后，那个 teammate 就能 claim / complete。owner 指错人（例如
  指给不存在的成员）时进度会卡在"无人结算"——看板会提示，门禁不会替你修。
- **`workflow` 不在子智能体派发门禁内（3.0.0）。** `evaluateSpecialistDispatch` 只拦
  `subagent` / `subagent_fork` / `subagent_<id>`；`workflow` 是编排工具（一次性扇出 fresh
  子代理），不产生"某个小组长背任务"的层级，所以仍可由指挥官调用——它适合无状态扇出，
  不适合需要排期与验收的长任务。
- **投影失败现在会 warn（3.3.0）。** 以前只记 debug，投影失败看起来"无害"；现在失败会以
  warn 级带**错误码**（例如 `TEAM_INVALID_WRITE_SCOPE`）出现在日志里——因为投影失败会让
  Team 通道被派发门禁挡死。看到这个错误码先查工单 `scope` 里有没有绝对路径。
- **writeScopes 里的绝对路径会被丢弃（3.3.0）。** `sanitizeWriteScopes()` 只把合法的工作区
  相对路径交给任务板；绝对路径 / 空段 / `.` / `..` 段直接丢弃。**任务板不会因此失败**，
  但"写作用域重叠"提示会少几条——`writeScopes` 只是 advisory，工单的完整 `scope` 仍在账本里。
- **停滞看门狗只提醒、不自动改状态（3.3.0）。** 它每 60 秒扫一次，超过 `ticketStallMs`
  且开工后从未回报才 `steer` 指挥者（同工单 10 分钟节流）；是追问、停掉补派还是标 blocked，
  由指挥者判断。阈值与节流都写死在 `lib/worker-sessions.js`，有单测覆盖。
- **idle 兜底 vs 停滞看门狗（3.3.0）。** idle 兜底覆盖"worker 回合已结束却没汇报"（
  `agent/status = idle` 触发，10 分钟节流）；停滞看门狗覆盖"worker 卡在回合中途、永远不
  idle"（定时扫描，`ticketStallMs` 阈值）。两者互不替代：会话 `def6609d` 的现场属于后者，
  当时只有前者，所以指挥者永远等不到唤醒。

- **没有「智能体团队」的部署：一次性子智能体是唯一通道（3.4.0）。** 这时 `evaluateSpecialistDispatch()`
  **降级放行**指挥官直调 `subagent_<id>` / `subagent` / `subagent_fork`（否则"不能自己动手
  也不能派活"就是死锁）；协议也**显式覆盖**成"本部署没有 Team 工具、小组长建不起来，改走
  一次性子智能体"，不是静默降级。
- **没有 `ask_user_question` 的部署：计划授权门禁自动跳过（3.4.0）。** Mandate 只能由
  `ask_user_question` 的确认结果记录，没有它时授权永远拿不到，若仍拒绝派发整个模式会死锁；
  所以门禁跳过（协议仍要求先把计划讲给用户）。
- **降级判据是"工具视图可读且确实没有"（3.4.0）。** 两条降级都只在 `availableTools` 是数组、
  且确实不含对应工具时生效；**视图读不到（`undefined`）时按"有"处理**——保持原门禁，
  宁可漏拦也不因为读不到而放宽。

- **`confirmPlan: false` 会自动关掉计划授权门禁（3.4.0）。** 关掉"规划后确认"后，协议不再
  让模型调用 `ask_user_question`，Mandate 永远记录不到 → 若仍要求授权，所有派发会被永久
  拒绝。所以 `resolveConfig` 检测到 `confirmPlan: false` 且 `requireMandate: true` 时自动把
  `requireMandate` 视为 false，并给一条 warning（想显式表达就两个都写成 `false`，不会告警）。

- **`teamTaskProjection: false` 会自动关掉 D-1 的投影要求（3.4.0）。** 关掉投影后工单不会
  出现在任务板上，而 D-1 要求"派发前已有投影"→ Team 通道永远派不出去。所以 `resolveConfig`
  在 `teamTaskProjection: false` 且 `requireTeamTask: true` 时自动把 `requireTeamTask` 视为
  false 并 warning；同时工单工具**真的尊重**这个开关（关掉时不再投影，此前只有
  `syncTicketMirror` 尊重它，配置与行为不一致）。
- **"能派活"的判据是"真的能调用"，不是"视图里有"（3.4.0）。** 执行边界的 `canDelegate` 由
  `hasUsableDispatchChannel()` 计算：Team / `workflow` / 一次性子智能体都要**没被
  `blockedTools` 禁掉**才算数（一次性子智能体还要求层级门禁关闭或本部署无 Team）。
  所以把 `spawn_teammate` / `send_message` 写进 `blockedTools` 不会造成死锁——门禁会判定
  "没有可用派活通道"，从而放行你自己动手；读不到工具视图时按"有"处理（宁严不漏）。

## 运维：外部巡检（0.9.0）

账本是文件，所以可以在**指挥者进程之外**巡检——这是 Super-agent "外部 Watchdog" 的最小可用
形态（基础设施层；任务层"有没有实质进展"仍靠看板的停滞提示）。

### `commander-status`

```powershell
node <本插件目录>\bin\commander-status.mjs --profile desktop
# 或指定账本文件：--ledger <path>；机器可读：--json；停滞阈值：--stall-minutes 10
```

| 退出码 | 含义 |
|---|---|
| `0` | 没有未结束工单（空闲） |
| `1` | 有未结束工单，但没有待人工项（在跑） |
| `2` | 有待人工项（待验收 / 受阻 / 失败 / 等回答 / 停滞）——需要人 |
| `3` | 账本不可读（损坏 / 读失败 / schema 不支持）——需要人检查 |

**只读**：不写账本、不清理、不备份损坏文件。它适合被 schedule / 任务计划程序 / CI cron 调用，
按退出码决定"沉默 / 提醒 / 报告"。

### 定时巡检配方（可选，不自动改状态）

在**你日常用的 dsh profile**（不是指挥者会话）里建一个定时任务，提示词示例：

```text
检查指挥者账本：运行
node <本插件目录>/bin/commander-status.mjs --profile desktop --json
退出码 0：什么都不说。
退出码 1：只说一句"指挥者在做 N 项"。
退出码 2：把 attention 明细逐条列出来提醒我。
退出码 3：报告账本损坏，让我检查（不要自己改账本）。
不要自动重启 dsh，不要修改或删除账本。
```

Windows 可用「任务计划程序」跑同一条命令；它不依赖 tmux/ps（与 Super-agent 原型的 POSIX
脚本不同）。**不要把巡检放进被监督的指挥者进程**：进程挂掉时它也不会跑。

## 外部事件接入（1.1.0）

0.9.0 的巡检是"人去看状态"；1.1.0 补上**反向通道**：外部系统（CI、告警、Issue 评论、
定时巡检结果）可以把事件**推进**指挥者会话——空闲的指挥者会被唤醒，不需要人先说话。
这是 Super-agent "事件驱动"在**会话内模式**下的最小形态：只做"事件 → 唤醒会话"，
不引入 Source/Trigger/评估器那套框架。

### 一条命令写事件

```powershell
node <本插件目录>\bin\commander-event.mjs --profile desktop `
  --ticket t-3 --kind ci-failed `
  --summary "build #42 失败：test/auth 3 个用例" `
  --detail "https://ci.example.com/builds/42" --source github-actions
```

路由用 `--ticket`（反查该工单所属的指挥者会话）或 `--session`（直接指定会话，优先）。
`--id` 可指定事件 id，让"至少一次投递"的外部系统重试时保持幂等（重复写入只算成功、不覆盖）。
`--list` 列出待投递事件；`--json` 机器可读。退出码：`0` 已写入/列出，`2` 用法错误，
`1` 写盘失败。

事件落到 `<账本所在目录>/events/inbox/<id>.json`（空 `stateDir` 时 =
`<DSH_HOME>/commander/events/`）。插件每 `eventPollMs`（默认 15 秒）扫一次：能路由到会话
就投递（`steer`，空闲会话会被唤醒），成功移进 `delivered/`；格式坏了移进 `rejected/`；
目标会话暂时不在就**留在 inbox 等下次重试**——不会静默丢事件，`commander-status` 的
`events_pending` 能看到积压。

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

### 配方（外部系统怎么接）

- **CI**：在失败分支跑一条 `commander-event`（GitHub Actions / GitLab CI / Jenkins 都只是
  "跑一条命令"）。没有 dsh 凭据时它也能跑——事件只是文件。
- **Windows 任务计划程序**：定时检查某个健康端点，失败时写一条 `kind: alert` 的事件。
- **dsh 自己的 schedule**：在**日常 profile** 里定时跑一条命令/提示词，把结果写成事件；
  同样不要把巡检放进被监督的指挥者进程。
- **人工补投**：事件文件放在 `events/inbox/` 就算投递，重启 dsh 后会补上（只要会话还能恢复）。

**边界**：投递需要 dsh 进程在跑（文件是队列，不是守护进程）；只投递给**已存在/可恢复**的
会话，不会新建会话或工单；不做鉴权（能写这个目录就等于能指挥，单机场景可接受）；
`eventInbox: false` 可整体关闭。

## 开发

```powershell
cd <本插件目录>
pnpm install      # 只为 @deepseek-ai/schemastery
node --test "test/**/*.test.mjs"
```

| 文件 | 职责 |
|---|---|
| `index.js` | **配置行**（profile 顶层）：导出 `Config`、提供 `commanderSettings` / `commanderLedger` 服务、关掉自动设置页 |
| `agent.js` | **指挥者模式行**（preset 内）：协议 section、执行门禁、派发/计划授权门禁、工单工具、skill、specialist 安装与重建 |
| `workflow.js` | **项目开发工作流组件**（preset 内）：**只注册 skill**（`project-dev-workflow`，3.6.0 起不再注入常驻 section），手册正文在 `lib/workflow.js` |
| `lib/workflow.js` | 项目开发工作流文本（每段六件套 + 20 个 skill 的阶段索引 + 六段角色常量） |
| `lib/discipline.js` | 五条工作纪律的**唯一真源**（Team 优先 / 禁止等待 / 禁人日 / git 分类提交 / 经验教训），由指挥者协议 import 拼接 |
| `lib/settings-service.js` | 配置行与模式行之间的桥：读配置/名册、广播 volatile 变化 |
| `lib/protocol.js` | 指挥者协议（紧凑版注入 system prompt，长文注册成 skill；5.0.0 起含「按任务形状拆」「验收与收口」两节） |
| `lib/sync.js` | 结算同步状态机：账本、未同步判定、同步看板与兜底提醒的渲染（纯函数） |
| `lib/tickets.js` | 工单状态机：六态回报 → 工单状态/阶段、停滞判定、计划授权判定、`STATUS:` 解析、工单看板渲染（纯函数） |
| `lib/ledger.js` | 账本存储层：原子写、损坏备份、schema 清洗、路径解析 |
| `lib/ledger-service.js` | `commanderLedger` 服务：会话隔离的工单/授权/派发/回报读写与裁剪 |
| `lib/dispatch-gate.js` | 派发门禁：没有计划授权 / 不带工单 → 确定性拒绝；子代理/缺服务/身份不明一律放行 |
| `lib/ticket-tools.js` | 三个工单工具（create / update / list）的 schema、执行与错误文案 |
| `lib/guard.js` | 执行边界的纯函数：身份判别、执行门禁、**禁止等待门禁**（`evaluateWaitForbidden`）、拒绝理由 |
| `lib/config.js` | schemastery `Config`、默认值、宽容读取器（`maxWaitMs` 已于 3.1.0 移除） |
| `lib/specialists.js` | 名册清洗、人设渲染、specialist preset 定义、`subagent_<id>` 工具的自实现 |
| `lib/capabilities.js` | **能力行唯一真源**（`CAPABILITY_ROWS` + `capabilityEntries()`）：模式的 preset 与每个 specialist preset 都从这里展开 |
| `lib/preset-plugins.js` | 模式的**完整 plugins 组合**（能力行 + 模式行 + 可选工作流行），由 `preset-commander.js` 在 `apply()` 里注入 |
| `specialist.js` | specialist preset 里的人设行（`dsh-commander-mode/specialist`） |
| `client.js` | 设置页（手写 ModuleLoader bundle，无构建） |
| `cordis.patch.yml` | 配置行 + 唯一 preset 的**声明元数据**（`id / name / description / order`；`plugins` 由 JS 注入，3.7.0 起） |

### 为什么 specialist 工具是自实现的

实测（2026-10，dsh 0.2.1-rc.2）：profile 插件的模块内部 ESM `import` 从**真实目录**向上
解析，真实 profile 的 `profiles/node_modules` 拦截层不在解析链上，所以
`import '@deepseek-ai/dsh-tool-subagent'` 会 `ERR_MODULE_NOT_FOUND`。要 import 就得
`pnpm add` 29 个随附包（还带第二份 cordis），并与 dsh 版本强绑定。

所以 `lib/specialists.js` 用 `ctx.tools.register()`（编译后的 JSON Schema）+ 
`ctx.subagents.startActivation({ delivery: 'caller' })` 自己实现前台委派，保持
**零随附包依赖**：

```js
request = { prompt: [{type:'text', text}], parent, agentPreset, agentOptions, maxDepth }
const started = await subagents.startActivation({ provider:'spawn', request, signal, delivery:'caller' })
const settled = await started.result   // { output: blocks[], stopReason, structured? }
```

而每个 specialist 的**人设**必须由独立 preset 承载（0.2.x 的 tool-subagent 已不再接受
`persona` 参数）：`lib/capabilities.js` 提供完整能力行，`specialist.js` 提供人设 section。

### 验证过什么

- **5.0.0 第二十六轮（两个模式合并成一个）**：
  - **协议实测（真实模块）**：`renderCommanderSection()` 默认 9983 字符 / 141 行、
    启用名册 11308 / 171 行、开场 10137 / 147 行（预算提到 12000 字符 / 180 行）。
    含「项目经理模式已并入本模式」「按任务形状拆工作」「验收与收口」三处新内容；
    六位专家 id（`architect` … `doc-writer`）与六位小组长建议名都在场。
  - **工单口径按开关渲染**：默认（`requireMandate`/`requireTicket` 均 false）→
    `TICKET_RULES_OPTIONAL`（"工单账本是可选工具"），不含"每次派发都带工单"；
    显式打开任一开关 → 严格 `TICKET_RULES`（含 `commander-plan` / `[ticket:t-N]`）；
    `ledger: false` → 整节消失、不点名 `commander_ticket_*`。
  - **单一 preset 实测**：`commanderPresetPlugins()` → **20 行**（18 能力 + `commander-mode-agent`
    + `project-dev-workflow`）；`skill-filesystem` 带本包真实 `skills/` 目录。
  - **YAML 实测**：`cordis.patch.yml` 只插入两行（`commander-mode` + `preset-commander`），
    两个 preset 的 config 都能通过 `PresetDeclarationConfig`（等价于真实 Loader 的加载前校验）。
  - **配置默认值实测**：`resolveConfig({})` → `requireMandate: false` / `requireTicket: false`；
    显式 `requireMandate: true` 仍生效；`confirmPlan: false + requireMandate: true` 仍会自动
    降级并告警（3.4.0 的死锁修复保留）。
  - **`node --test "test/**/*.test.mjs"`** → **637 / 637 通过、0 失败**。
  - **真实 Loader 回归**：devkit 沙箱装 5.0.0 → `compose` 567 行（比 4.0.0 少 9 行，
    正好是删掉的第二个 preset 行），exit 0。
- **4.0.0 第二十五轮（preset 组合搬进 JS，能力行只剩一份）**：
  - **YAML 体积实测**：`cordis.patch.yml` 487 → 299 行（删除两份能力行块共 196 行），
    文件里 `- id:` 只剩三条：`commander-mode` / `preset-commander` / `preset-project-manager`；
    不再有 `plugins:` 键、不再有 `CAPABILITIES` 标记。
  - **拼装结果实测（真实模块、非 mock）**：`commanderPresetPlugins()` → **19 行**
    （18 能力 + `commander-mode-agent`），`projectManagerPresetPlugins()` → **20 行**
    （18 能力 + `project-manager-agent` + `project-dev-workflow`）；
    两者能力行逐字相同，唯一差异是 PM 的 `skill-filesystem.config.customSkillDirs`
    = 本包真实 `skills/` 绝对路径（`packageSkillsDir()` 实测返回
    `E:\dsh-plugins\dsh-commander-mode\skills\`）。
  - **声明器 schema 实测**：`PresetDeclarationConfig({id,name,description,order})` 通过
    （`plugins` 可选，schemastery 补 `[]`），`plugins: 'nope'` 被拒；
    `preset-declaration.test.mjs` 逐行解析 YAML 的两个 preset config 跑一遍 schema ——
    等价于真实 Loader 在 apply 前的校验。
  - **注入链路实测**：两个声明模块的 `apply()` 各自把 `plugins` 注入后交给
    `agentPresets.register()`；`ctx.effect` 仍挂一个 disposer、注册失败只 warn（既有断言不变）。
  - **`node --test "test/**/*.test.mjs"`** → **663 / 663 通过、0 失败**。
  - **真实 Loader 回归**：devkit 沙箱装 4.0.0 → `compose` 正常合成，两个 preset 行只剩
    声明元数据（`plugins` 由运行时注入，不再出现在合成树里 —— 这正是本次改动的预期）。
- **3.6.0 第二十四轮（六段流水线降级为可选组件）**：
  - **病根复现（真实会话 `session-137678b5`）**：任务本身是"读交接文档 + 打安装包发版"，
    PM 却建了六张串行任务（架构 → 实现 → 审查 → 测试 → 安全 → 文档，每张 `blocked_by`
    前一张）。对照源码：`lib/project-manager.js` 原第二节标题即「六段流水线（每段都必须
    走完，顺序固定）」；`workflow.js` 原 `SECTION_ORDER = 640` 的 section 每轮注入整本手册。
  - **组件已拆成按需 skill（接线实测）**：`workflow.js` 的 `apply(ctx)` 现在
    `record.sections.length === 0`（不再注入常驻 section）、`record.skills.length === 1`
    （`project-dev-workflow`，`source: 'runtime'`，`invocation: { modelInvocable: true,
    userInvocable: true }`）——模型与用户都能加载，**小组长也能**（没有任何
    `isDelegatedAgent` 判断挡它）。
  - **协议口径实测（文本断言）**：PM 协议不再包含「每段都必须走完 / 顺序固定 / 不得省略 /
    不允许进入下一段」；包含「按任务形状拆 / 可选项 / 不是强制流程 / project-dev-workflow /
    不为了走流程制造依赖」与六种任务形状示例（打安装包、发版、交接、单点缺陷、排障、从零开发）。
    工作流正文包含「可选执行手册 / 不是强制流程 / 不是门禁 / 推荐顺序 / 按需加载 /
    只读对应那一段」与"什么时候值得用、什么时候不用"。
  - **顺手修掉的等待矛盾**：异步结算通知原写「等待其它下级时用 ≤60000ms 的短等待」，
    与 `wait_agent` 整条链硬禁用冲突；现改为"不要等待，靠完成通知与读状态推进"。
  - **locale 事故修复 + 守卫**：3.5.0 的 `locale/en.json` 因未转义双引号成为非法 JSON
    （已实测 `JSON.parse` 抛错并修复）；新增测试「所有 locale JSON 可解析，且中英键完全一致」
    （遍历 `locale/`、`preset-commander/locale/`、`preset-project-manager/locale/`）。
  - **`node --test "test/**/*.test.mjs"`** → **659 / 659 通过、0 失败**。
- **3.5.0 第二十三轮（小组长交下级判据 + 过期继承叙事纠正）**：
  - **判据三处落地**（源码审阅 + 文本断言，非 mock）：
    - `lib/team-model.js` 的 `leader-may-execute` 规则正文：含「什么时候该交下级」判据、
      单点 → `subagent_<id>`、扇出 → `workflow`、多阶段 / 要持续对话 → 自己执行，
      并写明"一次性子智能体没有任务板、没有后台通知、每次调用都是新 child"。
    - `lib/protocol.js` 紧凑 section 的「通道选择」：同口径判据三行（单点 → `subagent_<id>`；
      扇出 → `workflow`；多阶段 → 自己执行）。
    - `lib/protocol.js` 长文「通道 A」定义：补「单点任务」判据与一次性子智能体的三条硬约束。
  - **两个模式都覆盖**：`TEAM_MODEL` 同时拼进指挥官协议与项目经理协议（`lib/project-manager.js`
    原样拼接），所以判据在两个模式里都生效，不需要各写一份。
  - **过期叙事纠正的可验证事实**：`grep` 全仓库确认代码层**没有任何**对
    `@deepseek-ai/dsh-agent-preset` 的 import / 依赖（只有注释与文档提到它）；
    两个 preset 行在 `cordis.patch.yml` 里的 `name` 是本包子路径模块
    （`dsh-commander-mode/preset-commander` / `preset-project-manager`），
    实测 `plugin_manager list_bundles` 返回的 rows 也是这两条 + 配置行。
  - **`node --test "test/**/*.test.mjs"`** → **659 / 659 通过、0 失败**（连跑 2 次稳定）。
    新增 2 条：`protocol.test.mjs`「3.5.0：通道选择给出小组长什么时候交下级的判据」与
    「3.5.0：长文通道 A 定义里写明交下级判据」；`team-model.test.mjs` 的
    `leader-may-execute` 断言补判据关键词 + 方向正则（单点 → `subagent_<id>`、
    多阶段 → 自己执行）。
- **3.4.0 第二十二轮（门禁交叉冲突排查 + 降级放行）**：
  - **冲突矩阵**（四种工具视图 × 派发 / 执行边界 / 一次性派发 / `wait_agent` / 协议文本；
    真实模块、非 mock 手动验证）：
    - `evaluateSpecialistDispatch`：**有** Team 工具 → **DENY**；**没有** Team 工具 →
      **ALLOW**（降级放行）；视图 `undefined` → **DENY**（宁严不漏）。
    - `evaluateDispatchGate`（无有效授权）：**有** `ask_user_question` → **DENY**（要求先确认
      计划）；**没有** → **ALLOW**（跳过授权门禁）；视图 `undefined` → **DENY**。
    - `renderCommanderSection({ hasTeamTools: false })`：含顶部显式覆盖「本部署没有智能体团队」
      与降级通道段（"一次性子智能体就是**唯一**的派活通道"）；`hasTeamTools: true` 时**不含**
      降级段、仍渲染「通道 B」。
    - `renderModeOpening({ hasTeamTools: false })`：收尾句改成"用一次性子智能体派活"，
      不再教模型去 `spawn_teammate`。
    - **执行边界门禁的 `canDelegate === false` 逃生门**方向一致（源码审阅 + 既有用例）：
      没有派发通道时允许指挥官自己动手，避免死锁。
    - **配置层同冲突（`teamTaskProjection`）**：`resolveConfig({ teamTaskProjection: false })`
      → `requireTeamTask` 自动变 `false` 且给一条 warning；两者都 `false` → 无 warning；
      默认（都 `true`）→ 均不变、无 warning。工单工具实测（fake ledger + 计数 bridge）：
      `teamTaskProjection: false` → bridge **调用 0 次**、`teamTaskId` 为 `null`；
      `true` → 调用 1 次并 `attachTeamTask`。
    - **`hasUsableDispatchChannel` 八种组合**：①Team 可用 → `true`；②Team 被 block 但
      `workflow` 在 → `true`；③Team 被 block、无 workflow、无 specialist → `false`；
      ④Team 被 block + specialist 在、层级门禁开（specialist 不可用）→ `false`；⑤同上但
      层级门禁关 → `true`；⑥无 Team 工具 + specialist（降级）→ `true`；⑦全部被 block →
      `false`；⑧视图读不到（`undefined`）→ `undefined`（按"有"处理）。
  - **反向断言**：有 Team 时**仍然拦**一次性子智能体派发（加降级不能把原门禁放松）；
    有 `ask_user_question` 时**仍然要求**计划授权（同理）。
  - **`node --test "test/**/*.test.mjs"`** → **657 / 657 通过、0 失败**（3.4.0 契约同步后：
    `guard-hierarchy` 新增「无 Team 通道降级放行 / 有 Team 仍然拦 / 只影响 Lead」+「可用派活
    通道判定」（Team 被 block 但 `workflow` 在 → 仍算能派活、无任何通道 → false 等）；
    `dispatch-gate` 新增「无 ask_user_question 放行 / 降级不是跳过所有校验 / 视图读不到仍拒」；
    `protocol` 新增「hasTeamTools:false + 名册 → 一次性子智能体是唯一通道 / 无名册 → 逃生段 /
    顶部覆盖在绝对边界之前 / renderModeOpening 收尾句」；`config` 新增「confirmPlan:false
    自动关掉 requireMandate / teamTaskProjection:false 自动关掉 requireTeamTask（均告警，
    显式两者 false 不告警）」；`ticket-tools` 新增「teamTaskProjection:false 时工单工具真的
    不投影（配置与行为一致）」；`project-manager` 新增「无 Team 时 PM 协议追加覆盖段」；
    `plugin` 新增接线层「没有 Team 工具的 Lead 调 `subagent_*` 降级放行 / 有 Team 时仍拒」）。
- **3.3.0 第二十一轮（门禁死锁修复 + Worker 停滞看门狗）**：
  - **根因用运行时源码确认**：从桌面版 `app.asar` 里读出 `writeScope()` 的实现——`\` 换 `/`、
    去掉前导 `./` 与尾随 `/` 后，若以 `/` 开头、`^[a-z]:` 盘符开头、或含空段 / `.` / `..`
    段，就抛 `TEAM_INVALID_WRITE_SCOPE`；`sanitizeWriteScopes()` 的拒绝条件与它**逐条对齐**。
  - **`sanitizeWriteScopes` 对 def6609d 实际 scope 的输出为空**：
    `['E:\repo\tools\render','E:\repo\src']` → `[]`（这正是死锁起点）；
    混合 `['E:\repo\src','src/app','/etc/passwd','docs']` → `['src/app','docs']`；
    `['./src/app/','src/lib/']` → `['src/app','src/lib']`；
    `['src/./app','src/../lib']` → `[]`；`projectContent()` 的 `writeScopes` 同样为空。
  - **门禁自愈两种情形**（真实模块 + fake ledger/teamBoard）：
    `ensureTeamTask` 返回 `task-7` → **放行**；返回 `undefined` → **拒绝**，且拒因同时含
    「只改描述字段」「不要用 status」「commander_worker_spawn」「progress 会被层级门禁拒绝」
    四条纠正口径；没有 `ensureTeamTask` 且缺投影时同样拒绝。
  - **看门狗四情形**（真实 `CommanderWorkers.scanStalls()`，注入假时钟与 steer）：
    A 超阈值且开工后从未回报 → **提醒**（steer 1 次，文案含「疑似停滞」）；B 10 分钟内
    重复扫描 → **节流**（0 次）；C 开工后回报过 → **不提醒**；D 未到阈值 → **不提醒**。
  - **`node --test "test/**/*.test.mjs"`** → **625 / 625 通过、0 失败**（3.3.0 契约同步后：
    新增 `sanitizeWriteScopes` 用例、D-1 自愈四种分支（成功 / 失败 / 未提供 / 已有投影不重复建）
    与 8 条停滞看门狗用例（定时器与 unref、超阈值提醒、已回报不提醒、未到阈值不提醒、
    10 分钟节流、关闭 workerSessions 不扫描、终态不提醒、多工单只提醒真正停滞的那张））。
- **3.2.0 第二十轮（禁止等待扩到整条指挥链）**：
  - **门禁手动验证**（真实模块、非 mock：`node -e` 直接 import `lib/guard.js`）：
    `evaluateWaitForbidden` 对**四种身份全部 deny** —— Lead / teammate（`isDelegatedAgent`
    命中的小组长）/ subagent（子智能体）/ 身份读不到（`undefined`）；拒因原文第二行是
    「**整条链都不许等**：指挥官、小组长、子智能体都一样——不要等下级，也不要等上级」。
    读状态 / 追问工具（`list_agents` / `send_message`）照常放行。
  - **两个模式接线**：`agent.js` 与 `project-manager.js` 都是
    `evaluateWaitForbidden({ name: toolName })`——**不传 agent**（3.2.0 起身份不参与判定），
    且在 `delegationHierarchy` 分支**之外**无条件调用；`blockedTools` / `delegationHierarchy`
    都改不了它。
  - **配置无变化**：`maxWaitMs` 仍不存在（`resolveConfig` 26 个键 / `KNOWN_CONFIG_KEYS`
    27 个，与 3.1.0 相同）；用户无需改任何配置。
  - **`node --test "test/**/*.test.mjs"`** → **604 / 604 通过、0 失败**（3.2.0 契约同步后：
    `guard-wait` 新增「整条链一致」用例——Lead / teammate / subagent / 身份读不到四种身份
    一条覆盖、全部拒绝；并把拒因断言改成必须含「整条链都不许等」与三种角色名）。
- **3.1.0 第十九轮（禁止等待子智能体：硬禁用、无开关）**：
  > 历史记录：本轮只拦指挥官（teammate / 身份读不到放行）；**3.2.0 起改为整条链生效、
  > 不再放行**，见上一条。
  - **门禁手动验证**（真实模块、非 mock：`node -e` 直接 import `lib/guard.js`）：
    Lead + `wait_agent` → **deny**（拒因原文：「指挥官**不允许** `wait_agent`（本模式硬禁用，
    **没有开关**，不要重试）」）；Lead + `list_agents` / `team_task_list` / `send_message`
    → 放行（读状态 / 追问不受影响）；teammate（`isDelegatedAgent` 命中）+ `wait_agent`
    → 放行；身份读不到（`null`）→ 放行。
  - **"无开关"的结构性证据**：3.1.0 时 `evaluateWaitForbidden` 的签名是 `{ agent, name }`
    但**不读任何配置**；`agent.js` / `project-manager.js` 里它在 `delegationHierarchy` 判断
    **之外**无条件调用——所以 `delegationHierarchy: false` 时它仍然拒绝，`blockedTools`
    也改不了它（3.2.0 起签名进一步收成 `{ name }`，见上一条）。
  - **配置事实**：`resolveConfig({}).options` **26 个键**、`KNOWN_CONFIG_KEYS` 27 个
    （含 `specialists`），两者都**没有** `maxWaitMs`；`Config({})` 27 个键、无 `maxWaitMs`；
    `cordis.patch.yml` 里也已删掉这个键（留着会被报成未知配置键）。
  - **`node --test "test/**/*.test.mjs"`** → **601 / 601 通过、0 失败**（3.1.0 契约同步后；
    删除 2.0.0 等待门禁相关用例，新增 `guard-wait` 的「禁止等待」用例：Lead 拒 / teammate 放 /
    身份未知放 / 读状态工具放 / `delegationHierarchy: false` 仍拒）。
- **3.0.0 第十八轮（三层指挥链：指挥官 → 小组长 → 子智能体）**：
  - `node --test "test/**/*.test.mjs"` → **602 / 602 通过、0 失败**（2.4.1 基线 553，净增 49：
    `team-model` / `guard-hierarchy` / `hierarchy-wiring` 三个新文件 + 既有文件按新契约校准）。
    连跑 3 次稳定。新增覆盖里最关键的三条是：①层级开启时 `write` 的拒绝理由**不得出现
    `subagent_`**、必须指向 `spawn_teammate`+`send_message`+小组长（P2 回归）；②被层级门禁
    拒绝的 `subagent_*` 尝试**不计入**派发通道统计（P3 回归）；③`agent.js` 必须把
    `delegationHierarchy` 真的传给 `evaluatePreExecute()`（接线漏传会立刻红）。
  - **真实 Loader（devkit web 沙箱 `commander-web`，本插件 `link:` 安装）**：
    启动日志与页面清单确认 `dsh-commander-mode@3.0.0` 已加载、client 半在页面 manifest 里、
    **0 条 console error**；`devkit_sandbox_compose` 里三行齐全（`dsh-commander-mode` 配置行、
    `preset-commander`、`preset-project-manager`，以及 `agent` / `project-manager` / `workflow`
    三个子行）。headless 沙箱 `commander-regress` 也能正常启动，只有两行 preset 声明报
    `pending (waiting for service: agentPresets)` —— 那是 **headless 模板不含 `agentPresets`
    的已知边界**，不是加载失败。两个沙箱用完即 destroy。
  - **门禁手动验证**（真实模块、非 mock）：Lead + `team_task_update` `claim` / `complete` /
    `set_dependencies` → deny；`reassign` / `edit` / `delete` → 放行；Lead +
    `subagent_architect` / `subagent` / `subagent_fork` → deny（`workflow` 不拦）；Lead +
    `commander_ticket_update` `progress` / `blocked` → deny，`done` / `cancelled` / 只改
    acceptance → 放行；teammate（`isDelegatedAgent` 命中）全部放行；身份读不到放行；
    `delegationHierarchy: false` 时以上九条全部放行。拒绝理由的文案也按
    `availableTools` 生成，不点名对方没有的工具。
  - **P2 自相矛盾修复的证据**：修复前，指挥者调 `write` 的拒绝理由会让它去调
    `subagent_architect`（随后被层级门禁拒），一轮白烧；修复后默认（层级开启）第 2 步只给
    Team 通道、正文不含 `subagent_`，显式 `delegationHierarchy: false` 才恢复 2.x 的
    specialist 指引 —— 两种语义都有测试钉住。
  - **未覆盖的边界（如实记录）**：web 沙箱没有凭据，登录弹窗挡住 composer，所以
    **没有在沙箱 UI 里点选两个模式跑真实回合**；模式是否出现在选择器里，依据是
    `agentPresets` 声明行加载成功 + compose 树 + 真实 profile 的 `preset_audit`（2.4.1 时
    审计过 `commander` 22 行/116 工具、`project-manager` 23 行/112 工具，3.0.0 未增删 preset
    行，只改文本与门禁）。下次有凭据时补一次真实回合更稳。

#### 3.0.0 的经验教训

- **现象**：2.x 的协议写「指挥者不执行操作」，但没说"派给谁"的层级；于是指挥者既可以直接
  调 `subagent_<id>`，也可以开 teammate，两条通道并存，用户在长会话里看到的是"指挥者自己
  在改任务板、自己直接派一次性专家"，与"一个团队一个小组长"的预期不一致。
  **根因**：**只有禁令、没有层级**。协议把"不自己做"写死了，却没定义"谁来做"的中间层，
  模型就会挑最省事的那条通道（一次性工具），任务板上于是没有 owner、没有排期。
  **正确做法**：把层级写成**唯一正文来源**（`lib/team-model.js`），两个模式都拼接它；
  再用**确定性门禁**把"谁能写什么"钉住（任务板进展/排期、工单推进状态、子智能体派发），
  最后才用协议解释"为什么"。**反例**：把层级只写进协议、门禁照旧 —— 模型第一次顺手
  `team_task_update` 成功，后面就再也劝不住了（本插件 2.x 的历史就是"劝"）。
- **现象**：新门禁上线后，W4 发现"执行边界"的拒绝理由仍在教模型去调 `subagent_<id>`，
  而这条通道刚被新门禁封死 —— 两条规则各自正确，组合起来自相矛盾。
  **根因**：**门禁与提示词没有一起改**。拒因是一段模型会照着做的指令，它必须知道当前
  门禁状态；否则"拒绝 A 并建议 B"会变成"拒绝 A 并建议另一个会被拒的 B"。
  **正确做法**：让拒因生成函数接收 `delegationHierarchy`（与门禁同一个开关），
  开启时只给合法通道；两种状态都写测试。**反例**：只测"门禁会拒绝"，不测"拒绝之后模型
  被指到哪" —— 后者才是真正决定下一轮是否白烧的地方。
- **现象**：新门禁把 `observeDelegation` 挤到了后面，被拒绝的派发尝试仍被记成"真实派活"，
  看板误报"团队闲置 / 派活全走一次性 specialist"。
  **根因**：**统计口径与门禁顺序耦合**，但没人把"被拒的尝试"当成一个状态。
  **正确做法**：门禁判定放在观测之前（拒绝即返回、不记账），并加一条"被拒尝试不计入配比"
  的回归测试。**反例**：只看"看板数字变了"，不看数字里混进了什么。

- **1.3.1 第十六轮（DSH 0.2.2-rc.1 · 智能体团队通道针对性实测）**：
  0.2.2 改了 `@deepseek-ai/dsh-experimental-agent-team` 的实现（`TeamService` 的投影注册移进
  异步 `[Service.init]` 并 await `sessionProjections.register`）与 `agent-team-profile` 的 patch
  （删掉已不存在的 `tool-subagent-list-agents` 禁用行），而本插件 1.2.0 的「工单投影到共享任务板」
  正是依赖 `ctx.agentTeams`。逐项核对 + 真实回合实测结论：**API 未变、无需改代码**。
  - **API 核对**：`TeamService` 公开方法 `createTask` / `getTask` / `listTasks` / `updateTask` /
    `listMembers` / `spawnTeammate` / `sendMessage` / `waitForChange` / `interrupt` 全在；
    `lib/team-board-bridge.js` 的 `available()` 要求四方法齐全（`createTask/getTask/listTasks/updateTask`）
    → 通过。`TeamTaskView`（`revision`/`status`/`ready`/`ownerName`/`blockedBy`/`writeScopes`/
    `writeScopeWarnings`）与 `TeamMemberView.status`（`running|inactive|provisioning|failed`）
    形状未变；9 个 Team 工具名在 0.2.1-rc.5 与 0.2.2-rc.1 之间**完全一致**。
  - **真实回合**（devkit **web** 沙箱 `commander-team-e2e`：`dsh-base` + `dsh-web-app` +
    本插件 + `@deepseek-ai/dsh-experimental-agent-team-profile`，真实模型 `deepseek-flash`，
    沙箱内临时 `.credentials.yaml`，用完 destroy）：
    ① 会话默认 preset = `commander`（页面 chip 显示「指挥者模式」）；让模型调用
    `team_task_list` → 原始返回 `{"tasks":[]}`，**回合 2 秒完成、0 console error** ——
    证明 0.2.2 下 Team 工具在指挥者模式里确实可用（它们注册在 agent 自己的 ctx，不在 preset scope）。
    ② 让模型调用 `commander_ticket_create` 建工单 → 返回
    `{"ticket":{"id":"t-1",...,"team_task_id":"task-1"},...}`，会话日志出现
    `team/task`（version 2，`task.id=task-1`、`revision=1`、`status=pending`，
    description 带 `[commander:ticket=t-1]` 标记）—— **工单确实写进了 0.2.2 的共享任务板**。
    ③ 该工单建立后的下一步，运行时上下文里新增 section `commander:sync-board`，原文逐字：
    「【指挥者·工单看板】计划授权：**未确认**；工单 1 项进行中：t-1[queued] 团队通道联调。」
    （工单建立**之前**这一 section 不存在：`renderSyncBoard`/`renderLedgerBoard` 在空态返回
    空串，`systemPrompt.context` 不下发空文本——**这是设计，不是桥接失效**）。
    ④ 门禁未被削弱：工单返回里仍是 `mandate_pending: true` + 「派发前先用 ask_user_question
    确认计划」的提示。
  - 仓库内对应回归：`node --test` 475/475（本轮未改代码，仅补此记录）。
- **1.1.1 第十五轮（测试隔离修复 + 桌面版安装）**：
  - 安装桌面版时发现真实账本 `~/.dsh/commander/desktop.json` 里有 15 张标题 `x`、
    会话 `s-1` 的工单——全是**单测夹具**，不是真实会话。复现：跑 `test/host.test.mjs`
    前后对比真实账本 hash，确认是它改写的（根因：`host.test.mjs` 用默认 `stateDir: ''`，
    `apply()` 于是解析到**真实** `<DSH_HOME>/commander/<profile>.json`；0.6.0 起潜伏）。
  - 修复：该测试文件统一用 `mkdtemp` 的临时 `stateDir`，并在文件末清理；事件相关用例显式
    `stateDir: ''` 落到临时 DSH_HOME。验证：全量测试前后对 `~/.dsh/commander` 做文件 hash
    快照，**零变化**。`node --test` 432/432。
  - 真实账本已备份（`.scratch/real-ledger-desktop-pollution-backup.json`）后删除；空的
    `events/` 目录一并清掉，用户首次启动是干净状态。
  - 桌面版 profile 的插件副本从 0.5.0 同步为 1.1.0（`link:./plugins/dsh-commander-mode`，
    保留 `node_modules`），需要重启桌面版加载——宿主侧实时的 `Config` schema 仍是 0.5.0
    的旧键，这就是"没重载"的直接证据。
- **1.1.0 第十四轮（外部事件接入）**：
  - **`node --test` 432/432 通过**（407 → 432，+25）：新增 `test/events.test.mjs`（路径解析 /
    字段校验 / 缺省与截断 / 渲染文本 / 文件名安全）、`test/event-inbox.test.mjs`（按 ticket
    或 session 路由、`steer` 唤醒、目标会话不在时留队重试、坏格式进 `rejected/`、同 id 不重复
    投递、轮询间隔与释放、只读 `--list`、归档裁剪）、`test/event-cli.test.mjs`（真实子进程：
    写入格式、`--id` 幂等、`--list`、用法错误退出码 2）、`test/status-cli.test.mjs` 增
    `events_pending`；`config/patch/host` 增新键与 `commanderEvents` 服务断言。
  - **真实 Loader（web 沙箱 `commander-110-web` + 真实模型 `deepseek-flash`）**：
    ① 在页面里选「指挥者模式」，让它只建一张工单（t-1「事件唤醒验证」）后**结束回合**；
    ② 用 `bin/commander-event.mjs --ledger <沙箱账本> --ticket t-1 --kind ci-failed
    --summary "build #42 失败：test/auth 3 个用例" --detail … --source github-actions`
    写事件（退出 0，写入 `events/inbox/evt-…json`；`commander-status` 显示
    `events_pending: 1`）；
    ③ 轮询（沙箱里压到 1 秒）后事件被取走：inbox 空、`delivered/evt-….json` 出现、
    `events_pending` 回到 **0**；会话日志在 `seq 25` 出现一条 `source.kind =
    dsh-commander-mode` 的用户消息，正文逐字为「【指挥者·外部事件】ci-failed … 这是外部
    系统推送的事件，不是用户消息 …」——**空闲会话被唤醒并开始新回合**；
    ④ 指挥者按协议先只读核对（glob / commander_tickets / web_fetch），再
    `commander_ticket_update(t-1, blocked)` + 结构化提问；账本落盘 `status: blocked`、
    `lastReport.question` 写明"域名不可解析、工作区为空、无产物，请决定"。
    （复用 0.9.1 的 web E2E 配方；沙箱与临时凭据已销毁。）
  - 反例：事件目标会话不存在时文件**留在 inbox**（`events_pending` 保持 1），不会被丢弃。
- **1.0.0 第十三轮（默认开启的 Loader 回归）**：
  - `node --test` **407/407 通过**；新增/改写的用例钉住新默认值：`config`（`workerSessions`
    默认 `true`、显式 `false` 仍可关）、`patch`（`cordis.patch.yml` 写 `workerSessions: true`
    且注释写明"1.0.0 起默认开启 / 显式写 false"）、`host`（默认提供 `commanderWorkers` 服务）、
    `plugin`（默认注册四个 `commander_worker_*` 工具；显式 `false` 时不注册）。
  - **真实 Loader（headless 沙箱 `commander-100`）**：`compose` 里
    `workerSessions: true` 来自插件 patch 的默认值；用 `--patch` 只挂「配置行 + 模式行」且
    **不写 `workerSessions`**，真实模型回合里 `commander_worker_spawn` 确实存在并返回可执行
    错误——逐字：`Error: 这个部署缺少宿主服务：sessionController、workspaceRegistry，
    Worker Session 不可用（headless 模板不含这些行；桌面版 / Web profile 才有）。改用
    specialist 或 Team。` 这证明 1.0.0 的默认值在真实 Loader 里生效（工具注册 + 缺服务时
    精确降级），而不是只在 schema 里改了数字。沙箱已 destroy。
  - 真实 worker 回合的全链路证据仍来自 0.9.1 第十二轮（Web profile + 真实模型）。
- **0.9.1 第十二轮（真实 Web profile + 真实模型：Worker Session 端到端，抓到 3 个真 bug）**：
  这是 0.8.0 欠下的那次验证。环境：devkit **web** 沙箱（`commander-100-web`，profile 由
  `dsh-web-app` 模板生成，含 `sessionController` / `workspaceRegistry` / `agentPresets` /
  `permissionPresets`）+ 真实模型 `deepseek-flash`（provider `sub2api`），用
  `devkit_ui_open` 起真实 Web 服务器与 headless Chrome，在页面里选「指挥者模式」、输入任务、
  发真实回合。**注意**：devkit 的 web 服务器启动时**不注入凭据**（只有
  `devkit_sandbox_run` 注入），所以沙箱自己的 `.credentials.yaml` 里临时放了一个
  `SUB2API_API_KEY`（仅这一个 ref，沙箱用完即 `destroy`）。
  - **第一轮（0.9.0 代码）抓到 bug A**：worker 一汇报，`commander_ticket_update` /
    `commander_tickets` / `commander_worker_status` 全部报
    `tool "... " returned invalid output: value is not lossless JSON`。根因：
    `ticketView()` 对空问题返回 `question: undefined`，而 dsh-tools 的
    `snapshotJsonValue()` 认定 `undefined` 不是 lossless JSON → 整个工具失败。用真实账本
    跑诊断脚本，精确到 `ticketView(t-1).last_report.question = undefined`。
  - **第一轮同时抓到 bug B（更严重）**：worker Session 的工具清单里**没有
    `commander_report`**，system prompt 里也没有 Worker 人设——worker 做完任务就静默结束，
    指挥者只好自己只读核对产物。根因：`agent/created` 在 `sessionController.create()`
    期间（早于 `ledger.setExecution()`）触发，`decorate()` 里
    `findByWorkerSession()` 找不到工单 → 装饰被静默跳过。
  - **第二轮（修 A/B 后）**：worker 拿到人设与 `commander_report`，并真的调用了两次
    （`status: ready` + hello.txt 绝对路径）。但它的工具清单**只剩
    `commander_report` + `subagent`**：`decorate()` 用 `tools.get()` 过滤 `allow`，而装饰
    发生在 agent 组装早期、全局工具还没就绪，过滤结果是空数组 → `restrict({allow: []})`
    把**所有**工作工具屏蔽了，worker 只能用子代理代写文件（bug C）。
  - **第三轮（修 C 后，最终证据）**：worker 工具清单 **32 个**，含 `write` / `read` /
    `pwsh` / `commander_report`；它**直接**在自己目录写出 `hello.txt`、`read` 回读确认、
    `commander_report(status: ready, summary=绝对路径)`；汇报通知 steer 唤醒空闲指挥者，
    指挥者只读核验后 `commander_ticket_update(status: done)` 成功——原始返回里
    `"last_report": {..., "question": null}`（修复后的形状）、`"status": "done"`、
    `"stage": "ended"`。账本落盘 `status: done`；`bin/commander-status.mjs --ledger <该账本>`
    退出码 **0**（无未结束工单）；`work/<ticket>/hello.txt` 在 worker 目录、指挥者工作目录
    没有该文件，**目录隔离成立**。`commander_worker_spawn` 的 assignment
    `started_at → ended_at` 差 **56 ms**（不阻塞回合）。
  - **`node --test` 403 → 407 通过**：新增 `test/tool-output.test.mjs`——按 dsh-tools 的
    判定口径递归扫描**每个工具的原始返回值**（`undefined` / `NaN` / `±Infinity` / `-0` /
    函数 / symbol / 非普通对象 / 环全部拒绝），覆盖工单三工具与 worker 四工具；新增
    `worker-sessions.test.mjs` 用例：spawn 后立即装饰、restrict 用静态 allow、工具白名单
    guard 拒绝 `subagent`、放行 `write`。**先红后绿**：把 `lib/` 回退到 0.9.0 后这 4 个新
    用例全部失败，再恢复修复后全绿。
  - 修复：`lib/tickets.js`（空 question → `null`）、`lib/worker-sessions.js`（spawn 在
    `setExecution` 后显式 `decorate()`；restrict 改静态 allow + `tools.guard` 兜底）。
  - 沙箱已 `devkit_ui_close` + `devkit_sandbox_destroy`（凭据文件随沙箱删除）。
- **0.9.0 第十一轮（运维 status CLI）**：
  - **`node --test` 403/403 通过**（397 → 403）：新增 `test/status-cli.test.mjs`，用真实子进程
    跑 `bin/commander-status.mjs`，覆盖退出码 0/1/2/3、`--json` 输出、人类可读输出、`--help`，
    以及**只读性**：损坏账本返回 3 且目录里没有 `.corrupt-*` 备份。
  - 顺手修复：`lib/ledger.js` 新增 `backupCorrupt:false` 选项供只读巡检用；并把内部
    `backupCorrupt` 函数改名，避免参数遮蔽（测试抓到的 TypeError）。
  - **真实 Loader（headless 沙箱 `commander-090`）**：`compose` 出现 `commander-mode` /
    `preset-commander` / `commander-mode-agent` 三行；真实模型回合里 `commander_ticket_create`
    返回 `t-1` 的完整 JSON 并落盘 `<DSH_HOME>/commander/default.json`；随后用
    `bin/commander-status.mjs --ledger <该文件>` 读同一账本——人类可读输出
    `- t-1 [queued] 0.9.0 巡检验证`、退出码 **1**，`--json` 的 `open: 1 / concerns: 0`
    与账本事实一致。沙箱已 destroy（`preset-commander … pending (waiting for service:
    agentPresets)` 是 headless 模板的已知限制，不是 0.9.0 回归）。
  - 范围说明：`bin/` 脚本由 Node 直接运行、不参与 Loader 组合；这一轮的沙箱回归验证的是
    "插件运行时写出的账本 → 外部只读巡检读得懂"这条跨进程链路。
- **0.8.1 第十轮（真实模型 E2E 探针 + 修复）**：
  - **真实 Loader + 真实模型 + 注入凭据**（headless 沙箱 `commander-e2e`，用 `--patch` 把配置行/
    模式行临时挂到顶层，并关闭 `requireMandate`）：模型自然调用 `commander_ticket_create`
    成功（返回 `t-1` 的完整 JSON，含 `mandate_pending`/`mandate_required`/`note`）；
    `commander_worker_spawn` 在 headless 不可用——但修复后错误**精确点名**
    `缺少宿主服务：sessionController、workspaceRegistry（headless 模板不含这些行；桌面版 /
    Web profile 才有）`。这证明 0.6/0.8 的工单/工具接线在真实模型回合里是通的，且降级是
    可执行的，不是崩溃。
  - **E2E 抓到的两个真实 bug（已修）**：① `index.js` 在 `apply()` 里 `ctx.provide(账本)`
    之后**同 tick** 用 `ctx.get()` 回读返回 `undefined`，导致 worker 服务被误判"没有账本"而
    静默不发布 → 改为本地变量传递账本（`index.js`）；② 派发工具报错后工单停在 `working`
    幽灵状态（Assignment 已记、无 Report）→ 新增 `reportDispatchFailure`（`agent.js`）：
    post-execute 遇到"新工作工具 + isError + 有未结算 Assignment + 无更新 Report"时结算
    Assignment 并记 `failed` + 一个待用户决定的问题。
  - **测试 392 → 397**：新增 host 用例（`workerSessions:true` 时同一 apply 内提供
    `commanderWorkers` 且账本仍提供；spawn 缺服务精确点名）、worker 单测（缺服务点名）、
    plugin 用例（派发报错记 failed、已有更新回报不被迟到错误覆盖）。
  - **仍受环境限制**：headless 没有 `sessionController`/`workspaceRegistry`，Worker Session
    的真实 spawn/目录/汇报无法在该模板跑；需要桌面版或 Web profile + 模型凭据才能完成
    0.8.0 的端到端（见「已知边界」）。
- **0.8.0 第九轮（Worker Session，opt-in）**：
  - **`node --test` 392/392 通过**（375 → 392，+17）：新增 `test/worker-sessions.test.mjs`——
    `resolveWorkRoot`、disabled 拒绝、spawn（目录/workspace/独立 Session/权限/重命名/账本
    `execution`/派工消息）、同一工单只能一个 worker、`maxWorkers` 上限、装饰（人设 section /
    `tools.restrict` / `commander_report` / 结束 guard）、report 写账本 + steer 指挥者、
    send/status/stop、重启恢复提示、idle 未汇报兜底与节流、worker 工具契约；
    `config/patch/protocol/host/plugin` 增 Worker 配置、契约与接线断言（默认关闭不注册工具、
    `workerSessions:true` 注册四个工具并委托服务、服务缺失给可执行错误）。
  - **本轮抓到的两个实现 bug**：① `commander_report` 的 `execute` 用 `this.ledger`，
    工具以 `tool.execute()` 调用时 `this` 是工具对象 → 改为闭包捕获服务与账本；
    ② 测试把首次派工当成 `followup`，实际 `deliver` 优先 `steer`（新会话需要唤醒）→ 修正测试口径。
  - **真实 Loader（headless 沙箱 `commander-080`）**：`compose` 出现 `workerSessions: false`、
    `workRoot: ''`、`maxWorkers: 3`、`prepareCommand: ''`、`workerPermission:
    danger-full-access` 与三行；headless 缺 `agentPresets` 的已知限制不变。沙箱已销毁。
  - **未验证（不当作已完成）**：真实会话里"模型自然 spawn worker → worker 在独立目录执行 →
    commander_report 唤醒指挥者 → 指挥者验收"的端到端；`sessionController.create`/
    `workspaceRegistry.create` 在桌面 profile 的真实行为（代码已做特性探测与降级，但没有
    真实运行证据）；`prepareCommand` 在 Windows 含空格路径下的表现。需要一次桌面手动会话：
    开启 `workerSessions` → 建工单 → `commander_worker_spawn` → 看 worker 会话与目录 →
    等汇报通知 → 验收。
- **0.7.0 第八轮（异步派工 / 完成唤醒）**：
  - **`node --test` 375/375 通过**（366 → 375，+9）：新增异步接线用例——工具立即返回
    `started`（不阻塞）、完成后写账本（`ready` + Assignment 结算 + childId）并 `steer` 一条
    「【指挥者·派工完成】」通知、结算失败记 `failed` 并通知、容量超限在启动前拒绝（不会先
    启动 child）、异步受理结果不会被 `post-execute` 提前结算 Assignment；另有
    `protocol`（异步契约出现/关闭、规则不点名 specialist）、`config`（异步默认值与读取）、
    `patch`（新配置键）断言。
  - **本轮抓到的两个问题**：① 配置键原名 `maxAsyncSpecialists` 会被渲染进协议，触发既有的
    "空名册 section 不得出现 specialist"回归 → 改名 `maxAsyncTasks`；② 既有同步 specialist
    用例在默认异步后语义不再成立 → 测试显式 `asyncDelegation:false` 区分同步/异步两条路径，
    并把夹具默认值对齐真实默认（异步开）。
  - **真实 Loader**：headless 沙箱重新 `compose`，确认 `asyncDelegation` / `maxAsyncTasks`
    出现在合成配置、三行仍在；`preset-commander` 仍因模板缺 `agentPresets` 停在 pending
    （已知限制）。web 沙箱在 0.6.0 已验 preset 注册/绑定，本轮未重复跑 UI（无模型凭据，
    跑不了异步端到端）。
  - **未验证**：真实会话里"异步完成通知真的唤醒空闲指挥者、指挥者不再轮询"的端到端。单元/
    接线测试用可控 Promise + `steer` spy 覆盖了逻辑，但**不等于真实 runtime**；需要一次
    桌面手动会话（选指挥者模式 → 派 specialist → 结束回合 → 等通知到达）。不当作已验证。
- **0.6.0 第七轮（工单 / 计划授权 / 注意力看板）**：
  - **`node --test` 366/366 通过**（285 → 366，+81）：新增 `test/tickets.test.mjs`（状态迁移、
    六态映射、停滞、计划确认、`STATUS:` 解析、看板渲染）、`test/ledger.test.mjs`（路径解析、
    原子写回读、损坏备份、schema 清洗、会话隔离、授权生命周期、裁剪、写盘失败降级、真实文件
    重启回读）、`test/dispatch-gate.test.mjs`（识别、放行、五类拒绝）、`test/ticket-tools.test.mjs`
    （schema、缺账本/子代理拒绝、建单/更新/列表）；`plugin.test.mjs` 增接线用例（门禁拒绝/放行、
    计划确认记账、`STATUS:` 回报、缺格式按 progress 记、看板、`ledger:false` 降级）；
    `config/host/patch/protocol` 增新配置键与契约断言。
  - **本轮的四个实现缺陷（测试先红后绿）**：① `attentionOf` 原先把"受阻"排在结构化问题之前，
    导致"等你回答"被显示成"受阻" → 改为问题优先；② `parseReportStatus` 不容忍
    `STATUS:**`（markdown 冒号后置）→ 修正正则；③ 派发门禁在"已有工单但不带工单"分支里没点名
    `commander_ticket_create`，模型不知道下一步 → 补上；④ 285 例既有接线测试按"工具总数/首工具"
    断言，被新增的工单工具打破 → 改为按 `subagent_` 前缀取 specialist 工具（合法演进）。
  - **真实 Loader（headless 沙箱 `commander-060`）**：`devkit_sandbox_create/install/compose`
    三行（`commander-mode` / `preset-commander` / `commander-mode-agent`）与 6 个新配置键都
    出现在合成树里；`devkit_sandbox_run` 的 stderr 原文
    `preset-commander … pending (waiting for service: agentPresets)` —— **headless 模板没有
    `agentPresets`，preset 类插件在该模板无法激活**（与 0.5.0 记录的限制一致，不是 0.6.0 回归）；
    该会话里也没有工单工具（预期）。
  - **真实 Loader（web 沙箱 `commander-060-web`）**：client 半进入页面清单；
    `POST /api/agentPresets/list` 返回 `{id:"commander", name:"指挥者模式", order:7}`；
    选中模式后 `POST /api/session/list` 的 projection 为 `agentPreset:"commander"`、
    `agentAvailable:true`；`POST /api/settings/describe` 里有 `commander-mode` 命名空间与
    6 位预置专家 → **preset 注册、模式绑定、配置命名空间在真实 web Loader 里成立**。
  - **未验证**：真实模式里"模型自然调用 `commander_ticket_*` / 被门禁拒绝后改走确认流程"的
    端到端。web 沙箱 UI 没有模型凭据（模型目录为空，页面显示"暂无可用模型"），无法发起模型
    回合；桌面版手动会话仍未跑。与 0.5.0 的未验证项同类，**不当作已验证**。
  - 两个沙箱已 `devkit_sandbox_destroy`，零残留。
- **0.5.0 第六轮（Team 优先 / 通道配比 / 孤儿任务）**：
  - **`node --test` 285/285 通过**：新增通道配比（`recordDelegation` / `channel-drift`）、
    孤儿任务（`board-stale-open`：宽限期、依赖未满足、主人 running vs inactive、结算后消失）、
    `consumeStaleNudge`（每条会话只强提醒一次）、以及接线用例（`tools/pre-execute` 观测派发、
    `syncGuard: false` 不记账、teammate 自己的派发不计入指挥者账本）。
  - **依据来自真实会话审计**（`session-7064696b`，1374 个事件）：按 seq 分段统计出
    `Team 118 次 → 13 次 → 0 次` 与 `一次性 specialist 0 → 13 → 2` 的漂移曲线，
    以及最终 **6/14 未结算**（3 项 unowned、3 项 owner inactive）。这条曲线是 0.5.0 的设计输入，
    已写进 `README` 与 skill 长文（测试钉住数字，防止以后被悄悄删掉）。
  - **真实 Loader 端到端（headless 沙箱，真实 `agentTeams` 服务）**：让模型
    ① `team_task_create` 建一个未结算任务；② 连续做 3 次**一次性派发**；③ 复述下一步的
    运行时上下文。模型逐字贴出的看板原文：
    ```text
    【指挥者·同步看板】任务板 0/1 已结算（未结算 1 项：task-1 pending）；计划清单：未建立；团队：**无 teammate**（重启后旧队友不会自动复活，需要人时用 spawn_teammate 补）；派发通道：Team 0 次 / 一次性 specialist 3 次。
    ⚠️ 最近 3 次派活都走一次性 specialist，而任务板还有 1 项未结算（task-1） → 长任务 / 多阶段工作改用 Team 通道（spawn_teammate + team_task_*，续做用 send_message），一次性 specialist 只用于"前台等一会就拿到结果"的单点任务。
    ```
    中间轮次的计数依次为 `一次性 specialist 1 次 → 2 次 → 3 次`，第 3 次触发告警 —— 说明
    "派发观测 → 账本 → 看板提示"这条链路在真实运行时是通的。
  - **该沙箱里的 specialist 通道不可用（harness 限制，非回归）**：headless 模板没有
    `agentPresets` 服务（stderr 原文 `preset-commander … pending (waiting for service:
    agentPresets)`），而模式行的 specialist 安装要 `inject(['tools','subagents','agentPresets',
    'commanderSettings'])`，缺一个回调就不执行 → 没有 `subagent_<id>` 工具。所以上面那三次
    一次性派发是用 `workflow` 执行的（0.5.0 账本里 `workflow` 同样记 one-shot），
    **不是**用 specialist 工具；真实部署里 specialist 通道由 preset 组合提供，0.2.0 起的
    四轮回归已单独验证过。
  - **未验证的**：真实会话里"看板提示真的把人拉回 Team 通道"的长期效果（需要多次真实使用才能
    观察）；`channel-drift` 的 3 次阈值也只是基于该会话的先验选择（不是 A/B 结果）。
- **0.4.0 第五轮（结算同步 / a2a 效率，真实 Loader 端到端）**，证据全部来自 headless 沙箱
  真跑（`dsh --profile <sandbox>`，把模式行临时挂到 profile 顶层——headless 的一次性 runner
  拒绝"已绑定 preset"的会话，见 `dsh-headless/lib/index.js`）：
  - **`node --test` 265/265 通过**：新增 `test/sync.test.mjs`（账本 / 判定 / 渲染 / 宽容入参）
    与 plugin.test.mjs 的接线用例（看板、post-execute 记录、turn-stopping 兜底、teammate 隔离）。
  - **系统提示注入**：模型从自己的系统提示里**逐字**复述出新 section 的内容 ——
    `- **每次结算都做三同步**：任务一进入终态（completed / 失败 / 取消 / 删除）…` 与
    `### a2a 效率（派活、等待、汇报 — 每条都能省掉一整轮）`。
  - **同步看板（真实 `agentTeams`）**：模型调用 `team_task_create` 建出 task-1 后，**下一步**的
    运行时上下文里逐字出现：
    `【指挥者·同步看板】任务板 0/1 已结算（未结算 1 项：task-1 pending）；计划清单：未建立。
    状态以此为准，不要用 list_agents / team_task_list 轮询。`
  - **未同步判定 + 回合结束兜底**：写计划清单 → 结算任务 → 模型被要求"直接结束回合"。模型
    自述收到 `⚠️`（"current runtime context has an ⚠️ warning telling me to todo_write"），
    并在回合结束前收到注入的 `【指挥者·结算同步】` 提醒；补完同步后按约定给出 1–2 行回执，
    看板变为 `任务板 1/1 已结算（无未结算）；计划清单 1/1 已完成`。
  - **沙箱回归脚手架**：`devkit_sandbox_create/install/compose/run/destroy` 全绿；
    `compose` 里可见 `commander-mode` / `preset-commander` / `commander-mode-agent` 三行，
    配置含 `syncGuard: true`；跑完删除沙箱，零残留。
  - **仍未验证的**：桌面版 GUI 里点「指挥者模式」那个入口动作（沿用 0.1.x 的真实 preset 会话
    证据；0.4.0 的变更都在模型看得到的文本与钩子上，没有改 UI 入口）。
- **0.2.2-rc.1 适配回归（1.3.0，devkit 沙箱 `commander-regress`，web profile + 真实 Web UI）**：
  - `devkit_sandbox_compose` 合成树含 `- id: commander-mode`（顶层配置行）、
    `- id: preset-commander`（`id: commander`）与 `- id: commander-mode-agent` 子行，
    没有 broken 行；
  - `devkit_ui_open` notes：**“dsh-commander-mode@1.3.0 is loaded: its client half is in
    the page's manifest”**，控制台错误 0 条；
  - 真实浏览器里模式选择器列出 `标准模式 / PTC 模式 / 极简模式 / 创造模式 / **指挥者模式**`，
    点选成功（chip 变为「指挥者模式」，preset 真的 mount）；
  - 插件页出现「指挥者专家名册」卡片，点进去名册编辑器完整渲染（6 位预置专家、继承模型、
    添加专家 / 删除 / 恢复预置名册 / 保存）；
  - 证据截图：`.scratch/preset-smith/evidence/{commander-mode-menu,commander-mode-selected,
    commander-plugins-page,commander-specialist-roster}.png`；跑完 `devkit_sandbox_destroy` 零残留；
  - 能力行镜像与 0.2.2 随附 `standard.patch.yml` 机械比对：18 行顶层里除 `delegation`
    组（有意只留 `workflow-ptc` + `tool-workflow`）外每一行（含 config）逐字节相同，
    排除项恰为 `persona` / `planning` / `tool-plugin-manager` / `tool-plugin-market`；
  - `node --test` 475/475 通过。
- **`node --test` 全绿**（201 个用例，0.2.0 时点），覆盖：门禁判定与身份放行、协议文本与
  可靠性语义、patch 结构（含 config 键与名册默认值）、名册清洗、specialist preset/工具契约、
  volatile 重建、设置页契约与纯逻辑模块（config / capabilities）。
- **`preset_audit` 审计 `commander`**（0.1.2 时点）：20 个子行全部 `ACTIVE`、无 `broken`。
- **真实 preset 会话端到端**（0.1.2 时点，用 `@deepseek-ai/dsh-webhook` 的进程内
  `dispatch()` 起一个 `agentPreset: "commander"` 的 root agent）：preset 绑定、协议注入、
  规划确认、派发、验收核对、门禁拒绝都观察到了。
- **0.2.0 沙箱回归（三轮，真实 Loader）**：
  1. **specialist 链路 4/4 通过** —— preset 行内注册 specialist preset（`broken:null`）、
     `subagent_<id>` 进入 commander preset 的 scope（host 看不到）、execute 直调起子 agent、
     **子会话实际使用名册里的模型**（descriptor 与 request header 三处一致；换到另一个模型
     时上游 429 也证明路由真的变了）。
  2. **抓到第一个架构性缺陷**：`Config` 声明在 preset 子行上时设置页不可达（preset 子行
     不进 Loader entry 树 → `settings.describe()` 没有该命名空间 → `configForms.whileServed()`
     永假 → 卡片静默消失）。修复：配置搬到 profile 顶层行，模式行通过服务读。
  3. **修好后 Host 侧设置投影全部通过**（`status:'schema'`、`specialists` 带
     `x-cordis.volatile`、`settings.update` 写入 profile patch 并回读生效），**又抓到第二个
     缺陷**：顶层行 `name` 含 `/` 时 client 半不进页面清单（`dsh-client-modules` 的
     `exactPackageSpecifier()` 拒绝含 `/` 的说明符）。修复：配置行用裸包名、模式行改用
     `./agent` 子路径出口。
  4. 装法注意：`dsh plugin add` 用 `link:` 时 client 半可能不进 UI manifest；把包真实复制进
     `profiles/<p>/node_modules` 并在目标目录 `pnpm install` 可复现（否则 schemastery 找不到
     cosmokit → 行 never started）。
  5. **修复后第三轮全绿**：client 半进入页面清单（`__DSH_BOOT__.entries` 含
     `dsh-commander-mode`），插件页出现「指挥者专家名册」卡片，点进去名册编辑器完整渲染
     （空态文案、添加专家、六个字段、删除/保存）；保存链路闭环 —— UI 保存 → profile
     `cordis.patch.yml` 顶层行 `specialists` 落盘 → Loader 热更新 →
     `settings.describe()` 回读 `valueSpecialists` 就是刚保存的那一项。
  6. **0.3.0 第四轮（预置名册 / 空路由 / 重置）全绿**，真实 Loader 原文：
     - compose 里 `specialists` **没有**被 patch 覆盖（只有 `maxSpecialists: 20`），默认名册生效；
     - 不做任何配置，`acquireScope('commander')` 的工具集里就有
       `subagent_architect / implementer / reviewer / tester / security-auditor / doc-writer`
       六个工具（host scope 只有 base 自带的 `subagent_fork`），6 个 specialist preset 全部
       `broken: null`；
     - **空路由真的继承父模型**：`subagent_architect` 执行后，子会话
       `[subagent/descriptor]` 与 `[request/header].config` 的 provider/model 与父 agent
       完全一致（`sub2api/deepseek-flash`），不是只在记录里写了个默认值；
     - 设置页开箱 6 行、「恢复预置名册」按钮初始禁用；删一行后按钮可用，点重置 → 6 行回到
       草稿并提示"需保存"；保存后 profile patch 里 `specialists` 变成 5 项（再重置+保存回到
       6 项），且空路由以 `provider: '' / model: ''` 原样写回，不会被固化成父模型。
- **仍未验证的**：桌面版 GUI 里手动选中「指挥者模式」那个入口动作（模式绑定、协议注入、
  门禁、派发在 0.1.x 的真实 preset 会话里验证过；specialist 通道在沙箱里以
  「scope 工具集 + execute 直调」验证过，未跑「模型自然调用」）；半填路由在 UI 的
  `partialRoute` 提示（Host 侧 `normalizeRoster` 跳过告警有单测覆盖）。

## 版本

- **5.0.0** —— **两个模式合并成一个：只剩「指挥者模式」**（用户 2026-11-12：「重新进行规划，
  把指挥官模式和项目经理模式改成同一个模式吧，反正是按需加载 专家团和工作流」）。
  ① **理由**：3.6.0 起六段工作流已是可选 skill、专家团本来就是按需选人，两个模式的差别
  只剩"有没有工单账本"与两段协议文本——不值得用两个 preset 表达。合并后切换成本为零。
  ② **协议合并**：`lib/protocol.js` 新增两节——「按任务形状拆工作」（4 条：先判断形状、
  常见形状的拆法、四条硬要求、六段工作流是可选 skill）与「验收与收口」（5 条：每任务三件事、
  验收门禁、方向性问题上上报、亲自核对证据、经验教训含模式本身），并在身份段写明
  「项目经理模式已并入」。`TEAM_MODEL` 仍只拼一份。
  ③ **模式行合并**：删除 `project-manager.js`（468 行）、`lib/project-manager.js`（101 行）、
  `preset-project-manager.js` 与 `preset-project-manager/` locale 目录；六段角色常量
  （`PIPELINE_SPECIALISTS` / `PIPELINE_STAGES` / `leaderNameForSpecialist`）迁到
  `lib/workflow.js`。`lib/preset-plugins.js` 只剩一个 builder：
  能力行 + `commander-mode-agent` + `project-dev-workflow`（20 行）。
  ④ **配置默认值变更**：`requireMandate` / `requireTicket` 默认 **true → false**——
  工单工具仍在（`ledger: true`），但"每次派活先拿授权 / 带工单"变成**可选严格流程**；
  协议按开关渲染严格版或按需版 `TICKET_RULES_OPTIONAL`，不会教一个不存在的门禁。
  ⑤ **`skills/` 目录并入唯一模式**：`preset-commander` 现在也注入
  `skill-filesystem.config.customSkillDirs`（六段手册引用的 20 个方法 skill）。
  ⑥ **测试**：删除 `project-manager.test.mjs`（其断言并入 `protocol.test.mjs`：按形状拆、
  验收与收口、六位专家/六段在场）；`config.test.mjs` 按新默认值改写冲突用例；
  `hierarchy-wiring.test.mjs` 去掉重复的 PM 接线用例、门禁顺序用例显式打开 requireMandate；
  `capabilities` / `patch` / `preset-declaration` / `workflow` 同步单模式。
  全量 **637 / 637 通过、0 失败**。
  ⑦ **破坏性变更（用户要做什么）**：模式菜单里不再有「项目经理模式」。**已有的项目经理模式
  会话**升级后找不到该 preset——请新建会话并选「指挥者模式」（它的能力是原来两个模式的并集）。
  原先在 profile patch 里覆盖 `preset-project-manager` 的，删掉那段覆盖即可。
- **4.0.0** —— **preset 组合从 YAML 搬进 JS：能力行只剩一份**（用户 2026-11-12：确认要做
  「两份 preset 的 plugins 改成由 `lib/capabilities.js` 拼装，彻底消掉 YAML 重复」）。
  ① **改动前**：同一份能力行存在**三处**——`lib/capabilities.js`（给 specialist 用）+
  `cordis.patch.yml` 里两份逐字复制的 `CAPABILITIES` 块（各 ~84 行，合计 168 行），靠
  `test/capabilities.test.mjs` 逐行比对防漂移。漂移的故障是静默的：某个模式少一项能力，
  另一个看起来完全正常。
  ② **改动后**：新增 `lib/preset-plugins.js`（`commanderPresetPlugins()` /
  `projectManagerPresetPlugins()`），从 `lib/capabilities.js` 单一来源拼装；
  `preset-commander.js` / `preset-project-manager.js` 在 `apply()` 里注入 `plugins`。
  `cordis.patch.yml` 只保留 `id / name / description / order`（**-196 行**，487 → 299）。
  声明器的 `Config.plugins` 改为**可选**（YAML 不写它也必须能过 schema）。
  ③ **为什么安全**：preset 子行是运行时挂载的 fiber，`plugins` 本来就不进 Loader entry 树
  （settings 页读的是那棵树，所以配置行才必须留顶层）。也就是说 YAML 里的 `plugins` 只是
  "交给 apply 的数据"，换成本模块返回值不影响加载语义。specialist preset 早就走这条路径。
  ④ **能力行差异收窄为一条**：两个模式的能力行逐字相同，唯一例外是 PM 的
  `skill-filesystem.config.customSkillDirs`（本包 `skills/` 目录，按模块位置解析）。
  ⑤ **测试**：`capabilities.test.mjs` 重写为「YAML 里不再有第二份 + 两个 preset 共享同一份
  清单 + 模式行不串味」；`patch.test.mjs` 改为断言 patch 只插入三行、能力行契约查 JS 清单；
  `preset-declaration.test.mjs` 断言模块注入 plugins，并**逐行解析 YAML 的 preset config
  过一遍 schema**（真实 Loader 在 apply 前做的正是这一步，headless 沙箱绑不了 preset）。
  ⑥ **破坏性变更（用户要做什么）**：如果你在自己的 profile patch 里按 id 覆盖过
  `preset-commander` / `preset-project-manager` 并**重述了 `plugins`**，那份 `plugins` 现在
  会被忽略（以 `lib/capabilities.js` 为准）；删掉它即可，其余字段（`id / name /
  description / order`）照常生效。正常用户无需任何操作，重装 / 重启即可。
- **3.6.0** —— **六段流水线降级为可选组件，按需加载**（用户 2026-11-12：项目经理模式
  「不是一定要使用这个工作流，这个工作流拆成一个组件吧，让小组长按需调用」，并给出真实会话
  `session-137678b5`）。
  ① **现象**：那是一个"读交接文档 + 打安装包发版"的任务，PM 却按死顺序建了
  「架构 → 实现 → 审查 → 测试 → 安全 → 文档」六张任务，每张 `blocked_by` 前一张、串成一条
  链，架构段先开工。根因是两处叠加：PM 协议写着「## 二、六段流水线（**每段都必须走完，
  顺序固定**）」+「安全审计与文档**不得省略**，即使用户只说了"把功能做出来"」；工作流组件
  又用 `order: 640` 的 system-prompt section 把整本执行手册**每轮**注入。
  ② **修复（拆成组件）**：`workflow.js` **只注册 skill**（`project-dev-workflow`），
  **不再注入常驻 section**（原 `SECTION_NAME = 'project-workflow:mode'` / `SECTION_ORDER = 640`
  两个导出删除）；`invocation` 同时开放 `modelInvocable` 与 `userInvocable`，所以
  **项目经理与专家小组长都能按需 `skill` 加载，也可以只读其中一段**。
  ③ **修复（协议不再预设流水线）**：PM 协议第二节重写为「按任务形状拆工作」——先判断
  交付物 / 需要的能力 / 真实依赖，再拆任务；给出交接、发版打包、单点缺陷、排障、从零开发
  各自的拆法；六段只在"从零开发 / 大改造 / 需要完整交付链"时作为**可选项**出现。硬要求只剩
  四条：每个任务有可观察的验收判据、完成必须有落盘证据、需要独立验证的换人、
  **不为了走流程制造依赖**（不要为了"顺序"给每张任务加 `blocked_by`）。
  ④ **顺手修掉的矛盾**：异步结算通知里原来写着「等待其它下级时用 ≤60000ms 的短等待」——
  与 3.1.0/3.2.0 的 `wait_agent` 整条链硬禁用直接冲突，改成"不要等待，靠完成通知与读状态
  推进"；`lib/discipline.js` 的经验教训条目从"六段流水线哪一步形式化"改为"这次任务拆分
  哪一步形式化"。
  ⑤ **修掉一个 3.5.0 引入的发布事故**：`locale/en.json` 在 3.5.0 改描述时写进了未转义的
  双引号，文件变成**非法 JSON**（插件页读不到描述），当时没有测试解析 locale。现已修正，
  并新增守卫测试「所有 locale JSON 可解析 + 中英键完全一致」。
  ⑥ **测试**：659 / 659 通过（新增/改写覆盖：PM 协议「按任务形状拆分、不再强制流水线」、
  工作流组件「不再注册 section、只注册 skill、描述含可选/按需」、locale JSON 守卫）。
  **用户要做什么**：重新安装 / 重启桌面版。行为变化：PM 不再默认带六段流水线；需要时让它
  用 `skill` 加载 `project-dev-workflow`（或直接说"按六段工作流做"）。无配置变更。
- **3.5.0** —— 两件事：**补「小组长什么时候该交下级」的判据** + **纠正「项目经理模式 =
  指挥者模式 + Agent 预设定义」的过期叙事**（用户 2026-11-12：「小组长会在什么时候安排子
  智能体给他干活？」「PM 模式只是比指挥官模式多出「Agent 预设定义」+「工作流」，这种情况
  不应该出现」）。
  ① **现象 A（缺判据）**：协议里关于"小组长要不要把子任务交给下级子智能体"只有**授权**
  （"可以自己执行，也可以交给下级"），没有**判据**——于是它可能把该自己干的活（多阶段、
  要持续对话、要中途纠偏）塞给一次性子智能体，把上下文扔掉；也可能反过来什么都自己干，
  白白放弃并行。
  ② **修复 A**：三处正文补同一口径的判据（`lib/team-model.js` 的 `leader-may-execute`
  规则、`lib/protocol.js` 的「通道选择」与长文「通道 A」定义）：**单点、产出明确、前台等
  一会就能拿到结果**（写一个文件 / 跑一次审查 / 做一次分析）→ 交 `subagent_<id>`；
  **一次性扇出多个互不依赖的 fresh 子代理**（并行调研 / 并行审查多个模块）→ `workflow`；
  **多阶段、要持续对话、要中途纠偏、要留任务板进度** → **自己执行**（一次性子智能体没有
  任务板、没有后台通知、每次调用都是新 child）。判据同时说明"为什么"：把要持续对话的活
  塞给一次性子智能体 = 把上下文扔了。
  ③ **现象 B（过期叙事）**：README / 插件卡片描述 / `cordis.patch.yml` 注释 /
  `project-manager.js` 注释里写着「项目经理模式继承自「指挥者模式」+「Agent 预设定义」，
  后者被禁用时两个模式一起消失」。这是 **2.0.x 时代的事实**：当时两个 preset 由随附的
  `@deepseek-ai/dsh-agent-preset` 声明。**2.1.0 起本包自带等效声明器**
  （`lib/preset-declaration.js` + 两个子路径模块），代码里**已无任何对该包的依赖**
  （只有注释/文档还提它），禁用那一行**不会**让两个模式消失。
  ④ **修复 B**：把"继承"叙事整体改成"**并列，不继承**"——preset 是完整组合、不是叠加层，
  两个模式共享同一批模块（能力行清单 `lib/capabilities.js` 单一来源 + `lib/guard.js` /
  `lib/specialists.js` / `lib/discipline.js`），各自只加自己的协议行；声明方式改由本包
  自带声明器负责，**只依赖随附的 `agentPresets` 服务**。同步改了 README 顶部简介、
  「两个模式的关系」一节、「前置条件」两处、`package.json` 的 `description` /
  `meta.description`、`locale/{zh,en}.json` 的插件卡片描述、`cordis.patch.yml` 头部注释、
  `project-manager.js` 模块注释；工作区约定（`dsh-plugin-devkit` 2.1.1）里的同一说法也一并
  修正。
  ⑤ **测试**：657 → **659**（新增 2 条：`protocol.test.mjs` 的「通道选择判据」与「长文通道 A
  判据」；`team-model.test.mjs` 的 `leader-may-execute` 断言补判据关键词）。全量
  **659 / 659 pass / 0 fail**（连跑 2 次稳定）。
  **用户要做什么**：重新安装 / 重启桌面版。纯文本与文档改动，无配置变更、无破坏性接口变更。

- **3.4.0** —— 门禁**交叉冲突**排查与降级放行（用户要求「再检查一下是否还有类似的问题，
  这种逻辑冲突可能之前在单独开发时没有注意到，但是完成后可能会相互冲突」）：
  ① **现象**：每条门禁单独看都正确，组合起来会互相堵死。3.3.0 修了 1 处（D-1 投影 ↔ 层级
  门禁），这次对"门禁 × 门禁、门禁 × 部署能力、门禁 × 配置"做系统审计，找到 **5 处同类问题**
  （"门禁假设了一个可能不存在的能力"）——最初审计 3 处，收尾复核又发现 2 处（配置层投影
  联动、`blockedTools` 误禁派发工具）。
  ② **修复**：**没有 Team 工具**的部署里，`evaluateSpecialistDispatch()` **降级放行**一次性
  子智能体（否则"不能自己动手也不能派活"= 死锁）；**没有 `ask_user_question`** 的部署里，
  派发门禁**跳过计划授权**（授权只能由该工具记录，否则永远拿不到）；协议新增
  `hasTeamTools`——`false` 时渲染**降级通道段 + 顶部显式覆盖**，`renderModeOpening()` 收尾句
  与项目经理协议同步覆盖（不再教模型调不存在的工具）。**配置层**：`teamTaskProjection: false`
  时自动把 `requireTeamTask` 视为 false（且工单工具真的不再投影）、`confirmPlan: false` 时
  自动把 `requireMandate` 视为 false（都带 warning）。**执行边界**：新增
  `hasUsableDispatchChannel()`，按"**真的能调用**"（再过滤 `blockedTools`、考虑层级门禁）
  判定有没有派活通道——误禁派发工具时不会死锁。所有降级判据都是"工具视图可读且确实没有"，
  **视图读不到时按"有"处理**（宁严不漏）。
  ③ **确认不是问题的四处**：执行边界的 `canDelegate` 逃生门、Worker 复用 `standard` preset
  且工具受限、`ledger/asyncDelegation/workerSessions:false` 的条件渲染、工单结束/授权变更/
  容量上限之间的判定。
  **用户要做什么**：重启即可（协议文本与门禁在启动时装配），**不需要改任何配置**。
- **3.3.0** —— 修 `session-def6609d` 的**门禁死锁 + 静默挂死**（用户报告"最后卡死"）：
  ① **现象**：会话最后静默挂死；模型自己在会话里写下"门禁自相矛盾形成死锁"。
  ② **根因（六步）**：工单 `scope` 是 Windows 绝对路径 → 投影器原样塞进任务板
  `writeScopes` → 运行时 `writeScope()` 拒绝绝对路径、抛 `TEAM_INVALID_WRITE_SCOPE` →
  投影失败被静默吞掉（无 `teamTaskId`）→ 派发门禁 D-1 拒绝 `spawn_teammate` 并让模型
  "更新工单状态触发投影"，而 3.0.0 起指挥官改工单推进状态被层级门禁拒绝 → **Team 通道
  永久不可用**；模型退到 Worker Session，worker 卡在回合中途（不 idle、不汇报）→ idle 兜底
  不触发 → 指挥者永远等不到唤醒。
  ③ **修复**：新增 `sanitizeWriteScopes()`（按运行时规则清洗，绝对路径丢弃；`writeScopes`
  只是 advisory，工单保留完整 scope）；投影失败从 debug 升到 **warn**（带错误码）；
  派发门禁**自愈**（`evaluateDispatchGate` 变 async + `ensureTeamTask`，缺投影时插件自己
  补建，成功放行；失败拒因只给当前实现允许的动作，明确"不要用 status 触发"）；
  **Worker 停滞看门狗**（每 60 秒扫描，超过 `ticketStallMs` 且开工后从未回报 → steer
  指挥者，同工单 10 分钟节流，只提醒不自动改状态）。
  **用户要做什么**：重启即可（门禁与看门狗在启动时装配），**不需要改任何配置**；之前被
  这个死锁卡过的会话，重启后 Team 通道会自愈。
- **3.2.0** —— 禁止等待扩到**整条指挥链**（用户 2026-11-11 追加要求「**不要等**」——
  在被问及"是否连小组长也不许等"时明确回答）：
  ① **现象**：3.1.0 只拦了指挥官——小组长（teammate）等自己的下级仍然放行，于是长会话里
  "指挥官不等、小组长挂机等"的形态还在；用户要的是**谁都不等**。
  ② **变更**：`evaluateWaitForbidden()` 删除 `isDelegatedAgent` 放行，**不再按身份判定**——
  指挥官、小组长、子智能体、身份读不到一律拒绝（与其它门禁"宁可漏拦"相反：等待不是完成
  工作必需的动作）；`buildWaitForbiddenReason()` 增加「**整条链都不许等**：指挥官、小组长、
  子智能体都一样——不要等下级，也不要等上级」。两个模式的 `tools/pre-execute` 接线不变
  （`agent.js` / `project-manager.js`，都不传 agent、都在 `delegationHierarchy` 分支之外）。
  协议与工作纪律同步补「派活时明确要求小组长也不许等」。
  ③ **配置无变化**：`maxWaitMs` 仍不存在、没有新开关——这条禁令依旧是硬编码的。
  **用户要做什么**：重启即可（门禁在启动时装配），不需要改任何配置。
- **3.1.0** —— 禁止等待子智能体（用户 2026-11-11 补充要求：**禁止等待，且不设开关**）：
  > 历史条目：本轮只拦指挥官（teammate 放行）；**3.2.0 起改为整条链生效**，见上一条。
  ① **现象**：`wait_agent` 被当成"挂机等子代理"——历史会话里 39 次等待合计 231 分钟、
  单次最长 127.5 分钟；另一个会话 101 次合计 667.5 分钟（11.1 小时）、6 次直接等满
  1800000ms。2.0.0 的 `maxWaitMs` 只限制了单次时长：模型仍把"等"当默认动作，部署仍会
  "这次先关掉"。
  ② **变更**：`wait_agent` 对**指挥官**改为**硬禁用（无开关）**——`lib/guard.js` 新增
  `evaluateWaitForbidden()`（删除 `evaluateWaitCap` / `buildWaitCapReason` /
  `DEFAULT_MAX_WAIT_MS` / `DSH_DEFAULT_WAIT_MS`），在 `tools/pre-execute` 上**无条件拒绝**，
  不读任何配置（`delegationHierarchy` / `blockedTools` 都改不了它）；teammate 放行、身份
  读不到放行。`maxWaitMs` 配置**整体移除**（schema / `KNOWN_CONFIG_KEYS` / `resolveConfig` /
  `readWaitCap` / 上下限常量 / `cordis.patch.yml` 全删）；协议与五条工作纪律里的
  「短等待 ≤60s」全部改成「禁止等待」。
  ③ **不等之后靠**：完成通知唤醒（`agent.steer()`）/ `list_agents` / `team_task_list` 读
  状态 / `send_message` 追问 / 一句话汇报后结束回合。
  **用户要做什么**：重启即可（门禁与配置在启动时确定）。**若 profile patch 里写过
  `maxWaitMs`，请删掉那一行**——schema 已不认这个键，留着会得到"未知配置键"警告。
- **3.0.0** —— 三层指挥链（用户 2026-11-11 的五条规则落地；大版本：对外契约有破坏性变更）：
  ① 新增 `lib/team-model.js` 作为团队模型的**唯一正文来源**（三层职责 + 七条规则 + 深度 2 /
  并行 16），指挥官协议与项目经理协议都拼接它，不再各抄一份；协议新增「持续接单」与
  「歧义链路」（小组长报指挥官、指挥官汇总后一次性问用户）。
  ② 运行限制对齐运行时「子智能体」设置：`maxTeammates` 默认 8 → 16、上限 12 → 16；
  `maxAsyncTasks` 默认 8 → 16、上限 12 → 16；插件不再自己压低并行度。
  ③ **破坏性变更**：指挥官不再直接调用 `subagent_<id>` / `subagent` / `subagent_fork`
  （团队活交给小组长）；`team_task_update` 的 `claim` / `release` / `complete` / `reopen` /
  `set_dependencies` 与 `commander_ticket_update` 的 `progress` / `waiting` / `ready` /
  `blocked` / `failed` 只允许小组长做，指挥官只建任务 / `reassign` / 读板 / 验收 `done`、
  `cancelled`；项目经理模式六位专家改为**专家小组长**（`architect-lead` 等）。
  ④ 三条门禁由新配置 `delegationHierarchy`（默认 `true`）控制，`false` 回到 2.x 的
  "只靠协议"行为；看板与协议文案同步改成"核对小组长是否已结算，未结算就催 owner"。
  **用户要做什么**：重新安装 / 重启 DSH。旧习惯（指挥官自己 `claim` / `complete`、直接调
  `subagent_<id>`）会收到拒绝与纠正指令；要保留 2.x 的软约束行为就把 `delegationHierarchy`
  设为 `false`。
- **2.4.0** —— 放开并发度（用户 2026-11-09 反馈「子智能体数量限制过严，导致效率太低」）：
  ① **Team 成员上限 8 → 16**：随附的 `agent-team-profile` 把 `maxMembers` 显式写成 8
  （包自身默认是 16），在 profile patch 里用 id 定向覆盖回 16（四个键必须全写，整块替换）。
  ② **本包三个并发上限提高**：`maxTeammates` 4 → 8（协议建议并行度，与运行时对齐）、
  `maxAsyncTasks` 4 → 8（一次性 specialist 并发）、`maxWorkers` 3 → 6（Worker Session 并发）。
  ③ **协议补一条并行纪律**：独立工作流（互不依赖、写作用域不重叠）**各开一个 teammate 并行**，
  不要压到同一个队友身上排成串行队列；判断标准是依赖关系，不是"省名额"。旧的
  「复用同一个 teammate」保留为"跟进/修正走同一人"，但不再用来压缩并行度。
  **用户要做什么**：重启 DSH（profile patch 要重新合成）。想再提高团队上限就改
  profile 的 `agent-team.maxMembers`（包支持到 16，更高需要看运行时校验）。
- **2.3.0** —— 位置歧义与能力边界（用户 2026-11-09 指出 session-e1618ace 的「低级错误」）：
  ① 工作纪律新增第 6 条「先对齐位置与能力边界，再用『没有』下结论」：先列候选位置
  （App 容器 / 文件 App / iCloud / 本机 / 远程机），先说明自己**读不到**什么，报告"没找到"
  必须附「查过哪些位置、哪些读不到」，不许用缺失反推用户没做。
  ② 新增 skill `file-location-alignment`（第 20 个）：候选位置多义表 + 各平台能力边界
  （iOS `devicectl` 只读 App 容器、读不到「文件」App 的"我的 iPhone > xxx"；adb、Windows
  APPDATA/LOCALAPPDATA、SSH 家目录）+ 「没有」的正确写法 + 真实反例。
  ③ 工作流阶段索引与 README 表同步；紧凑 section 预算 9000 → 9500。
  测试 543 → 547。
- **2.2.1** —— 等待门禁默认开启的回调（见 2.2.0 之后的用户要求，与 2.2.0 同批发布）。
- **2.2.0** —— 执行边界补齐「远程 / 桌面 / 浏览器 / 模拟器 / 终端」（用户 2026-11-09 指出
  session-a0c0b646「指挥者亲力亲为」）：
  ① 事实：那个会话确实在**项目经理模式**（06:15:47 切过去，系统提示里就是 PM 协议 + 工作流），
  Lead 本地 `write` / `edit` / `pwsh` 都是 **0 次**（代码活确实派出去了：7 个 teammate、
  12 张任务板任务），但它**自己**跑了 **51 次 `ssh_exec` + 2 次 `ssh_upload` + 1 次 `ssh_job`**，
  在远程 PC 上 dir/ver/powershell 一路操作 —— 用户看到的就是"亲力亲为"。
  ② 根因：`blockedTools` 只列了本地六个工具；判据本该是"会不会改变工作区 / 宿主 /
  外部系统的状态"，远程执行、桌面注入、浏览器改动、模拟器控制、持久终端、`create_worktree`
  与 `pwsh` 同类。
  ③ 改法：默认拦截清单 6 → **48 项**，覆盖 `ssh_exec/job/upload/download/fetch`、`desktop_`
  输入类、`browser_` 改动类、`android_` 设备与 UI 控制类、`terminal_open/send/signal/close`、
  `create_worktree`；各插件的**只读半边**（`ssh_host`、`desktop_screenshot/ui_dump/windows_list`、
  `browser_snapshot/screenshot/console/network/status/list_pages`、
  `android_status/screenshot/ui_dump/logcat`、`terminal_read/list`）保持放行。
  ④ 拒因与协议同步改写：指挥者/项目经理协议里"不跑命令"扩成"不只是本地，远程/桌面/浏览器/
  模拟器/终端都算执行操作"；拒因也点名这五类。
  **用户要做什么**：重新安装/重启。若某个部署确实需要指挥者自己操作某类工具（例如没有子代理
  通道），把它从 `blockedTools` 里删掉即可；`canDelegate === false` 时门禁本来就自动放行。
  测试 539 → 543。
- **2.1.0** —— 插件页组件行标题改成**真实身份**（用户 2026-11-09 要求「按照实际身份修改」）：
  ① 组件行标题由**模块名**决定（`declaredRows` → `metaOf(row.name)` 读该模块的
  `locale/*.json`），两个模式共用随附的 `@deepseek-ai/dsh-agent-preset` 时两行标题都是
  「Agent 预设定义」。现在改成两个子路径模块 `preset-commander` /
  `preset-project-manager`，各带 `locale/{zh,en}.json` 与 `icon.svg`，标题显示
  「指挥者模式」「项目经理模式」——即它们的真实身份。
  ② 新增 `lib/preset-declaration.js`：语义等价于随附声明器（`agentPresets.register(config)`
  + 卸载释放 + 注册失败只 warn），并处理「注册未完成就被卸载」的竞态。
  ③ 差异与代价写进「已知边界」：不设 `EntryGroup` → `plugins` 里的 `!!js` 在加载期求值
  （对本包能力行等价）。
  **用户要做什么**：重新安装/重启；插件页「包含的组件」两行会显示成「指挥者模式」
  「项目经理模式」。测试 532 → 539。
- **2.0.4** —— 文档澄清：插件页「包含的组件」里出现两行标题相同（都是「Agent 预设定义」）
  时那不是重复组件，而是两个模式各一行 preset 声明（`preset-commander` /
  `preset-project-manager`），标题相同是因为两行共用同一个随附声明器模块；区分看标题
  下方的 patchId。该展示问题已在 2.1.0 根治（自带声明器 + 子路径 locale）。
  **用户要做什么**：无（纯文档 + 版本号）。
- **2.0.3** —— 文档补「模式继承关系」（用户 2026-11-09 指出）：明确 **项目经理模式 =
  指挥者模式 + Agent 预设定义**。README 新增「继承关系」一节，用表格写清继承了什么
  （能力行逐字节一致、专家名册与 `subagent_<id>`、执行/等待门禁、五条工作纪律、异步派工
  语义；preset 声明与生命周期来自 `@deepseek-ai/dsh-agent-preset`）、故意不继承什么
  （工单账本 / Mandate / dispatch-gate），以及本模式新增什么（六段流水线协议、项目开发
  工作流组件、`skills/` 目录加载）。`project-manager.js` 模块注释与 `cordis.patch.yml`
  头部注释同步写明；顶部简介也加了一句"继承自"。顺带修掉 README 里一处重复行。
  **用户要做什么**：无（文档 + 版本号 + 插件卡片描述多一句继承说明；重启后插件页可见）。
- **2.0.2** —— 等待门禁改回**默认开启**（用户 2026-11-09 先说不需门禁、随后改口要开启）：
  `maxWaitMs` 默认 `120000`（schema / 读取器 / patch 三处一致），超过上限的 `wait_agent`
  会再次被**确定性拒绝**并返回纠正指令；`0` 仍可显式关闭。2.0.1 的其余四项修复保留：
  ① specialist 人设与工具描述补「完成必须有证据」（贴改动后原文 / `git diff` / 哈希 /
  命令输出，只写"已修好"不算完成），并补「写文件被沙箱拒绝（PermissionError / EPERM）时
  改用 pwsh 或上报，不要反复重试」；② 协议新增「同一目标只建一张工单」「派活前核对工单
  状态、stale revision 先重读再重试」「等待参数必须是整数毫秒」；③ Team 优先规则补
  「成员上限 8、inactive 也占名额、先复用再新建」；④ 可靠性纪律新增「'完成'必须有可回查
  证据」。**用户要做什么**：无需配置（默认即开启）；重启/重装后生效。
- **2.0.1** —— 用户 2026-11-09 曾表示"**不需要等待门禁**"（该行为已在 2.0.2 撤回，
  此处保留历史）：
  ① 等待门禁默认关闭：`maxWaitMs` 默认 `0`（schema / 读取器 / patch 三处一致），
  超过上限的 `wait_agent` 只有显式把 `maxWaitMs` 设为正数时才会被拒；短等待改由协议
  纪律约束（单次 ≤60 秒、等待期间继续推进、依赖【派工完成】通知）。
  ② specialist 人设与工具描述补「完成必须有证据」：回报要贴改动后文件路径 + 关键内容
  原文 / `git diff` / 哈希或命令输出，只写"已修好"不算完成；顺带补「写文件被沙箱拒绝
  （PermissionError / EPERM）时改用 pwsh 或上报，不要反复重试」。
  ③ 工单卫生与等待参数：协议新增「同一目标只建一张工单」「派活前核对工单状态、
  stale revision 先重读再重试」「等待参数必须是整数毫秒」三条；Team 优先规则补
  「成员上限 8，inactive 也占名额，先复用」。
  ④ 指挥者可靠性纪律新增「'完成'必须有可回查证据」一条。
- **2.0.0** —— 用户 2026-11-09 复盘四个历史会话后提出的四条要求落地（大版本：新增一个
  agent preset + 一个执行手册组件 + 一道硬门禁，模式菜单与默认行为有结构性变化）：
  ① **项目经理模式**（`preset-project-manager`，`order: 8`）：调用六位开发流程专家
  （架构 / 实现 / 审查 / 测试 / 安全 / 文档）跑一条**六段带门禁的流水线**；每段有输入、
  产出、验收判据与返工规则，实现后必须独立审查与独立测试，每段结束 git 分类提交
  （未提交视为该段未完成），收尾必须写经验教训（含模式本身的问题）；不自己写业务代码
  （确定性拒绝）。
  ② **项目开发工作流组件**（`dsh-commander-mode/workflow`）：六段每段的必做动作、落盘
  产物、验收判据、失败返工、专家与团队用法，以及本包 `skills/` 目录 19 个方法 skill 的
  阶段归位；明确「skill 是工作方法，不替代验收证据」。
  ③ **等待门禁**：`lib/guard.js` 新增 `evaluateWaitCap()`，两个模式的 `tools/pre-execute`
  都调用它——`wait_agent` 的 `timeout_ms` 超过 `maxWaitMs`（默认 120000）时**确定性拒绝**
  并给出纠正指令；只拦超长等待，读状态 / 唤醒队友的工具不受影响。
  ④ **共用的工作纪律**：五条纪律文本收进 `lib/discipline.js` 单一真源，两份协议 import
  拼接（Team 优先 / 短等待 / 禁人日 / git 分类提交 / 经验教训）。
  **用户要做什么**：重新安装/重启即可看到新的「项目经理模式」；等待门禁默认开启（`maxWaitMs: 120000`）。
  测试 475 → 530。
- **1.3.0** —— 适配 DSH 0.2.2-rc.1（中版本，无用户可见行为变化，也不破坏旧用法）：
  ① 能力行镜像对齐 0.2.2 的 `preset-standard`：补进 0.2.1 起随附的 `time-context`
  （每轮时间上下文）与 `tool-schedule`（RRULE 定时任务）两行；`tool-fs` 显式写
  `config.applyPatch: false`（与随附逐字一致）。顶层行从 16 → 18，随附 standard 22 行、
  排除 `persona` / `planning` / `tool-plugin-manager` / `tool-plugin-market` 四行。
  ② `lib/capabilities.js` 同步 —— specialist preset 用的是同一份清单，两边由
  `test/capabilities.test.mjs` 逐行锁住；新增的 `tool-fs` config 也进了这份清单。
  ③ 文档/注释勘误：0.2.2 的 `@deepseek-ai/dsh-tool-subagent-control` 移除了
  `list-agents` 子路径导出（`list_agents` 并进主入口），`agent-team-profile` 因此只禁用
  旧控件三行而不是四行 —— 本插件本来就没声明它们，行为不变，只改注释。
  **用户要做什么**：不需要操作（重新安装/重启即可拿到新能力行）。测试 474 → 475。
  回归证据：devkit 沙箱 web profile + 真实 Web UI，见「已验证」一节的 0.2.2 条目。
- **1.2.0** —— 工单投影到 Agent Teams 共享任务板（B）+ Team 通道自动绑定 owner（D），
  中版本、向后兼容：
  ① 新增 `lib/team-board-bridge.js`：把工单确定性投影成任务板任务（描述前三行 marker、
  状态映射、收养模型自己建的旧任务、CAS 冲突重试一次）；账本新增工单 `teamTaskId` 字段
  （schemaVersion 不变，旧文件读出为 null）。
  ② `commander_ticket_create/update` 变成 async，建单/更新后自动投影并返回 `team_task_id`。
  ③ `agent.js` 在所有工单状态迁移点（派发记账、异步结算、失败回报、worker 回报）同步投影；
  `spawn_teammate` 结算后把投影任务 `reassign` 给队友（D）。
  ④ 派发门禁新增 D-1（Team 通道必须有有效投影）/ D-2（要求 `[task:task-N]`，默认关），
  没有 Agent Teams 时整段跳过。
  ⑤ 协议新增「共享任务板是工单的投影」三条（仅装团队时出现）；同步看板过滤投影任务，
  避免"团队闲置 / 孤儿任务"误报。
  ⑥ 配置新增 `teamTaskProjection` / `requireTeamTask` / `requireTeamTaskMarker`。
  **用户要做什么**：不需要操作（没装 Agent Teams 时行为与 1.1.1 一致）；不想投影就在
  profile patch 里写 `teamTaskProjection: false`。测试 432 → 474。
- **1.1.1** —— 测试隔离修复（无用户可见行为变化）：`test/host.test.mjs` 之前用默认
  `stateDir`，`apply()` 会解析到**真实** `<DSH_HOME>/commander/<profile>.json`，于是每次
  跑单测都会往用户账本里写测试夹具工单（1.1.0 装配时发现真实账本被写进 15 张标题 `x` 的
  记录）。改为临时 stateDir，并加"测试前后真实 commander 目录 hash 不变"的验证。
  测试 432/432。**用户要做什么**：无需操作；被污染的真实账本已备份后清理。
- **1.1.0** —— 外部事件接入（轻量 Trigger，中版本，无破坏性变更）：
  外部系统（CI / 告警 / 定时巡检）用新 CLI `bin/commander-event.mjs` 往
  `<账本目录>/events/inbox/` 写事件；配置行轮询（默认 15 秒）取走并 `steer` 对应指挥者
  会话——**空闲的指挥者会被外部事件唤醒**。按 `--ticket`（反查所属会话）或 `--session`
  路由；`--id` 幂等；`--list` 查看待投递；事件成功投递进 `delivered/`，坏格式进
  `rejected/`，目标会话不在则留队重试。`commander-status` 增加 `events_pending`。
  **用户要做什么**：不需要任何配置（默认开）；想整体关闭写 `eventInbox: false`，
  想改轮询间隔写 `eventPollMs`。README 增「外部事件接入（1.1.0）」章节与 CI / 任务计划
  程序配方。测试 407 → 432；真实 Loader 里验证了"空闲会话被事件唤醒"。
- **1.0.0** —— Worker Session 转正（大版本，**默认行为变化**）：
  `workerSessions` 默认值从 `false` 改为 `true`（`cordis.patch.yml` 同步）。真实 Web profile +
  真实模型已在 0.9.1 跑通 `commander_ticket_create → commander_worker_spawn → worker 在自己
  目录写文件 → commander_report → steer 唤醒 → commander_ticket_update(done)`，
  因此把「每张工单一个独立 DSH Session + 独立目录」从 opt-in 变成默认派工通道。
  **用户要做什么**：不需要改配置即可用；如果不想让会话列表出现 `执行 <ticket>：<标题>`
  这类 worker 会话（或不想让 worker 以操作员身份执行），在 profile patch 的 `commander-mode`
  配置里显式写 `workerSessions: false` 并重载——四个 `commander_worker_*` 工具会一起消失，
  派工回到 specialist / Team。默认上限仍是 `maxWorkers: 3`、权限 `danger-full-access`
  （目录不是安全边界）。测试 407/407 通过。
- **0.9.1** —— 真实 Web profile + 真实模型的 Worker Session 端到端验证抓到的三处修复：
  ① `ticketView()` 空问题返回 `question: undefined`，被 dsh-tools 的 lossless-JSON 校验
  判为 invalid output → 工单三工具（及依赖 `ticketView` 的 worker_status）在有回报后全部失败；
  改为 `null`，并新增 `test/tool-output.test.mjs` 递归守护**所有工具返回值**。
  ② `spawn()` 依赖 `agent/created` 装饰 worker，而该事件早于 `ledger.setExecution()`，
  worker 始终拿不到 `commander_report` 与人设 → 改为 setExecution 后显式 `decorate()`。
  ③ 装饰时用 `tools.get()` 过滤 restrict 的 allow，组装早期得到空数组 → worker 的工作工具
  被全部屏蔽；改为静态 allow + `tools.guard` 白名单兜底。
  测试 403 → 407；真实回合证据（spawn 不阻塞 56 ms、目录隔离、`commander_report` → steer →
  `commander_ticket_update(done)`、status CLI 退出 0）写进「验证过什么」。
  这一版当时**仍默认关闭** workerSessions；1.0.0 起默认开启（见上条）。
- **0.9.0** —— 外部巡检（`bin/commander-status.mjs`，plan 第 4 阶段/1.1 的最小可用形态）：
  只读账本，输出未结束工单 / 待人工项 / 停滞项，退出码 **0 空闲 / 1 在跑 / 2 需要人 / 3
  账本不可读**；支持 `--json` / `--ledger` / `--profile` / `--stall-minutes`；只读巡检
  **不备份**损坏文件（备份仍由插件运行时做）。README 附 schedule / 任务计划程序配方。
  测试 397 → 403（新增 `test/status-cli.test.mjs`，含损坏账本只读验证）。
  说明：原计划把它编为 1.1.0；因 1.0 的"默认开启 Worker Session"仍缺真实 worker 回合验证，
  先把不依赖模型、可独立测试的运维面交付为 0.9.0。
- **0.8.1** —— 真实模型 E2E 探针抓到的修复：① `index.js` 同 tick `ctx.get()` 读不到刚
  `provide` 的账本，导致 Worker 服务静默不发布 → 用本地变量传递（`0.8.0` 的 bug）；② 派发
  工具报错后工单停在 `working` 幽灵状态 → `agent.js` 新增 `reportDispatchFailure`：有未结算
  Assignment 且无更新 Report 时结算并记 `failed`（带错误摘要与待用户决定的问题）；
  ③ `commander_ticket_create` 的提示与 `requireMandate:false` 一致（新增 `mandate_required`
  与"本部署已关闭门禁"文案）；④ Worker spawn 缺宿主服务时精确点名 `sessionController` /
  `workspaceRegistry`（不再笼统"服务不可用"）。测试 392 → 397。
- **0.8.0** —— Worker Session（opt-in）：① 新增 `commanderWorkers` 服务
  （`lib/worker-sessions.js`）：每工单一个独立 DSH Session（`sessionController.create`）+
  独立目录（`workRoot/<ticket>`，可选 `prepareCommand`）+ `maxWorkers` 槽位；② 新增四个工具
  （`lib/worker-tools.js`）：`commander_worker_spawn/send/status/stop`，spawn 受计划授权/工单
  门禁约束；③ worker 侧在 `agent/created` 装饰：人设 section、`tools.restrict` 收紧、
  `commander_report` 工具、工单结束 guard；report 写账本并 `steer` 唤醒指挥者，idle 未汇报
  有 10 分钟节流兜底；④ 重启恢复提示与 `execution.resumedAt`；账本新增工单 `execution`
  字段（Session/目录/权限/恢复时间）；⑤ 配置新增 `workerSessions`（默认 **false**）/
  `workRoot` / `maxWorkers` / `prepareCommand` / `workerPermission`；⑥ 协议新增 Worker 三条
  （仅开启时出现）；⑦ 测试 375 → 392；⑧ **未验证**真实会话里 worker 端到端（见「验证过什么」）。
  为什么不是 1.0.0：1.0 还要求默认开启 + UI + 完整恢复，先以 opt-in 交付、等真实验证。
- **0.7.0** —— 异步派工与完成唤醒：① 一次性 specialist 默认改为**异步**（`lib/specialists.js`：
  工具立即返回 `stopReason:'started'`，后台 `delivery:'caller'` + 插件作用域 signal 等结算）；
  ② `agent.js` 新增异步登记/容量/完成处理：解析 `STATUS:` → 写账本（Assignment 结算 + Report）
  → `agent.steer()` 发「【指挥者·派工完成】」通知唤醒指挥者（失败也发）；③ `post-execute` 区分
  异步受理与真实结算，避免提前结算 Assignment；④ 协议新增「异步派工」四条（派活即返回 /
  完成通知会回来 / 收到先核对再结算 / 在飞不重派）；⑤ 配置新增 `asyncDelegation`（默认 true）
  与 `maxAsyncTasks`（默认 4，启动前检查）；⑥ 测试 366 → 375，新增异步接线用例；
  ⑦ 未验证真实会话里的"通知唤醒 + 不再轮询"端到端（无模型凭据/桌面未跑，见「验证过什么」）。
- **0.6.0** —— 借鉴 DeepSeek Harness 团队 Super-agent 原型的 Ticket / Mandate / Assignment /
  Report 形状（裁剪到指挥者场景），把"派活"变成有状态、可审计、可恢复的工单：① 新增
  `commanderLedger` 服务与账本（`lib/{ledger,ledger-service}.js`，默认
  `<DSH_HOME>/commander/<profile>.json`，原子写、损坏备份、会话隔离、重启不丢）；② 新增工单
  状态机与看板（`lib/tickets.js`：六态回报 → 状态/阶段、停滞判定、计划确认、`STATUS:` 解析、
  「指挥者·工单看板」）；③ 新增三个工具（`commander_ticket_create/update/list`）与**确定性派发
  门禁**（`lib/dispatch-gate.js`：没有计划授权 / 不带工单 / 旧授权工单 → 拒绝）；④ 协议新增
  「工单与计划授权」六条与固定确认格式（问题 id `commander-plan`、选项「确认，开始执行」）；
  ⑤ 新增配置 `ledger` / `stateDir` / `requireMandate` / `requireTicket` / `ticketStallMs` /
  `maxTickets`（默认全开，`ledger:false` 可回退 0.5.0 行为）；⑥ 测试 285 → 366，新增
  tickets/ledger/dispatch-gate/ticket-tools 四个测试文件；⑦ headless（host 行/配置）与 web
  （preset 注册/模式绑定/设置命名空间）真实 Loader 回归，未验证"模型自然调用"的端到端
  （web 沙箱无模型凭据，见「验证过什么」）。
- **0.5.0** —— 解决「Agent Teams 用得太少」（依据 `session-7064696b`：Team 工具调用
  118 → 13 → 0 的漂移曲线，任务板最终 6/14 未结算）：① **决策点提示** —— 每个
  `subagent_<id>` 的工具描述写明"一次性通道，多阶段/长任务改用 Team"；② 协议新增
  **「通道配比：Team 优先，specialist 只做单点」**五条（按任务形状选通道 / 建板必有主 /
  复用同一个 teammate / 重启后先看团队 / teammate 静默结束先查产物），只有两条通道都在时出现；
  ③ 看板新增 **派发通道配比** 与 **孤儿任务** 告警（未结算 + 超过 10 分钟 + 无人认领或主人
  inactive），孤儿任务每条会话强制兜底提醒一次；④ `lib/sync.js` 新增
  `recordDelegation` / `channel-drift` / `board-stale-open` / `consumeStaleNudge`，测试
  265 → 285。
- **0.4.0** —— 修「任务完成后不同步」并优化 a2a 效率（依据 2026-11-02 一次 1111 事件、
  三小时的指挥者会话）：① 新增**结算同步**体系 —— 每轮运行时上下文里的「指挥者·同步看板」
  （任务板 / 计划清单 / 团队状态实时快照 + 未同步项的纠正指令）+ `agent/turn-stopping`
  回合结束兜底（每回合最多一次）；② 协议新增「结算同步」四条与「a2a 效率」四条
  （派活一次写全 / 先约定回报协议 / 超时不是事件 / 回执即成功），`wait_agent` 等轮询
  不再被鼓励；③ 修复 **prompt section 泄漏给 teammate**（执行者不再收到整份指挥者协议，
  每请求省约 4.4 KB）；④ 新增配置 `syncGuard` 与 `lib/sync.js`（纯函数状态机 + 单测）。
- **0.3.5 / 0.3.4** —— 插件图标调整（先 PNG，后改成手绘 SVG，对齐 dsh 官方图标的矢量语言）。
- **0.3.3** —— 把内部 specialist preset 从**模式菜单**隐藏（它们只是指挥者按需调用的专家，
  不该作为可选模式出现）。做法是包装 `agentPresets.remoteExportList()` 过滤
  `commander-specialist-*`，只影响目录读取，注册/挂载/诊断不变。
- **0.3.2** —— 优化设置页界面与介绍：折叠行视觉（等宽 id、模型 badge、弱化删除按钮）、
  展开区 3 列布局与可读 hint、独立空态块、统计行；卡片摘要改成价值句、README 加快速上手。
- **0.3.1** —— 设置页的专家行改为**默认折叠、点击展开编辑**（折叠态显示 id + 模型路由 + 职责摘要）；
  新增行自动展开，保存校验失败时自动展开出错行，重置/保存后收拢。
- **0.3.0** —— 开箱预置名册（按主流软件开发流程 6 个专家：架构 / 实现 / 审查 / 测试 / 安全 /
  文档，模型继承指挥者）、设置页新增**「恢复预置名册」**按钮（只改草稿、保存才落盘）、
  `provider`/`model` 支持留空（空 = 继承指挥者模型，两栏必须同时空或同时填）。
- **0.2.1** —— 派活前必须做「定位匹配」：任务与执行者定位差距大时不硬派，改用匹配的执行者或
  在 Team 通道**开一个新的子智能体**（把这次定位写进它的 description/prompt）；执行者侧同步获得
  "任务与我的定位不符时先报告、不要硬做"的边界。
- **0.2.0** —— 多模型 specialist 名册（设置页 + `subagent_<id>` 前台工具 + 每个 specialist
  独立 preset）、协议吸收可靠性纪律与双通道选择规则、新增**配置行** `commander-mode`
  （profile 顶层，裸包名）以让设置页可达、新增依赖 `@deepseek-ai/schemastery`。
- 0.1.2 —— README 修正；门禁在 web-app 式部署失效的修复；拒绝理由按实际工具生成。
- 0.1.0 —— 首个可用版本：协议 + 门禁 + Agent Teams 派发 + 规划确认。

## 图标

包根 `icon.svg` 按 dsh 官方插件的矢量语言手绘：36×36 透明底、官方 artwork 调色板、一个意象。

同一份图标在**三处界面**生效：

| 位置 | 来源 |
|---|---|
| 插件页卡片 / 详情页头图 / 「包含的组件」行 | `package.json` 的 `"icon": "./icon.svg"`（Host 读包清单，声明即可） |
| 「设置 → 插件 → 内置插件配置」卡片插画 | client 半把同一份字节以 data URI 登记进 `globalThis.__DSH_PLUGIN_ITEM_ARTWORK__['commander-mode']`；**需要** dsh-plugin-devkit 的 `scripts/patch-plugin-item-artwork.mjs --apply` 给随附的插件管理页补一次查询逻辑，否则回落官方默认插画 |

改图标的正确顺序：改 `icon.svg` → `node <devkit>/scripts/embed-plugin-artwork.mjs .`（同步 `client.js` 里的
`ITEM_ARTWORK_URI`）→ 跑本包测试。图标规范全文见 dsh-plugin-devkit 的 skill
`dsh-plugin-development/references/icon-design-language.md`。