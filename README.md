# dsh-commander-mode

DeepSeek Harness（dsh）的**指挥者模式**：接单、分析、规划与拆分，把执行全部派给子代理；
自己不执行操作，规划与分歧都交回用户用选择工具确认。

**一句话**：你只做判断，子代理做执行。

- **指挥者不执行**：`write` / `edit` / `pwsh` 这类调用会被**确定性拒绝**并附上纠正指令
  （不是"靠提示词自觉"）——所以「分析、拆解、派活、验收」是它唯一的工作方式。
- **两条派发通道**：① 开箱六位专家（架构 / 实现 / 审查 / 测试 / 安全 / 文档），每位一个
  `subagent_<id>` 前台工具，可继承你的模型或绑定专属模型；② 「智能体团队」解决长驻队友、
  持续对话、共享任务板与后台并行。
- **两次必须问你**：规划拆分完成后先确认再派活；出现分歧、歧义或取舍时交回你选。
- **结算即同步**：任务一完成就同步**任务板 / 计划清单 / 团队状态**，而不是收尾才补。
  每轮运行时上下文里有「**同步看板**」（任务板、计划清单、团队状态的实时快照，有未同步项
  时直接给纠正指令）；万一还是忘了，回合结束前的兜底钩子会把它拽回来。0.4.0 起生效。
- **a2a 有纪律**：派活一次写全、开工前先约定回报格式、`wait_agent` 超时**不算异常**
  （别紧接着 `list_agents` + `team_task_list` 复查）—— 少一轮就是一个回合。0.4.0 起生效。
- **Team 优先（0.5.0）**：多阶段 / 长任务 / 需要中途追加指令或任务板进度 → 走「智能体团队」
  （`spawn_teammate` + `team_task_*` + `send_message`）；一次性单点任务才用 `subagent_<id>`。
  看板会显示**派发通道配比**并点名**孤儿任务**（没人认领 / 主人已停手），防止"重启后队友没了
  就退化成只用一次性 specialist、任务板留下 6 项没收尾"。
- **工单与计划授权（0.6.0）**：每一件被派出去的活都挂一张**工单**（`commander_ticket_*`），
  派发前必须有用户确认的**计划授权**（`ask_user_question` 的固定问题 id / 选项）。
  没有授权或不带工单的派发会被**确定性拒绝**；每轮看板显示「**指挥者·工单看板**」——
  计划授权状态、进行中工单、待验收 / 受阻 / 停滞 / 等你回答的项与下一步动作。
  账本落在 `<DSH_HOME>/commander/<profile>.json`（原子写、损坏自动备份、重启不丢）。
- **异步派工与完成唤醒（0.7.0）**：一次性 specialist 不再阻塞等待——工具立即返回 childId，
  结算时用一条「【指挥者·派工完成】」通知**唤醒**指挥者（带工单、`STATUS:`、摘要与下一步），
  并同时写账本。派活后可以继续做别的或结束回合，不要 `wait_agent` / `list_agents` 轮询；
  在飞数量有上限（`maxAsyncTasks`，默认 4），`asyncDelegation: false` 可回退前台阻塞行为。

```text
30 秒上手
1) 插件页安装本包，重启桌面版
2) 新建会话，模式菜单选「指挥者模式」
3) 把任务丢给它：它会先只读侦察 → 给你计划 → 你确认 → 建工单 → 派给专家 → 汇总验收
   （想调专家？设置 → 插件 → 指挥者专家名册：增删、改定位、绑模型、一键恢复预置）
```

- 仓库：<https://github.com/lldwb/dsh-commander-mode>（公开）
- 许可：[MIT](./LICENSE)
- 形态：**配置行**（profile 顶层，裸包名 `dsh-commander-mode`）+ 一个 agent preset（模式行
  `dsh-commander-mode/agent`）+ 设置页（Client 半）
- 依赖：`@deepseek-ai/schemastery`（声明 `Config` 所需，装进本包 `node_modules`）、
  `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」，可选但推荐）

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
| 建任务板、派发给 specialist 或 teammate | 杀作业（`job_kill`） |
| 结算后三同步：任务板 / 计划清单 / 团队状态 | 装插件（`plugin_manager`） |
| `wait_agent` 等进展、核对验收判据 | 替用户拍板 |
| 用 `ask_user_question` 让用户确认计划、上报分歧 | |

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
   inactive；有未同步项时直接给出 `todo_write` / `team_task_update` 的纠正指令。
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
- **超时不是事件**：`wait_agent` 超时只说明"这段时间没变化"——换更长 timeout 或做独立只读
  核对，别紧接着 `list_agents` + `team_task_list` 复查；同一参数连续重复会被运行时警告；
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
4. **回报必须结构化**：执行者最终答复最后一行写
   `STATUS: progress|waiting|ready|blocked|failed|dropped`；指挥者核对后用
   `commander_ticket_update` 更新工单（`blocked`/`failed` 时用 `question` 写清要用户决定什么）。
5. **验收后结算**：`commander_ticket_update` `status=done`（或 `cancelled` 写 `reason`）。

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
- **容量上限**：`maxAsyncTasks`（默认 4）在**启动前**检查；超限拒绝并提示等完成或改 Team，
  不会先启动 child 再失败。
- **在飞不重派**：同一工单已有在飞派发时不要重复派同一任务；要追加/纠偏走 Team 的 `send_message`。
- **回退**：`asyncDelegation: false` 回到 0.5.0 的前台阻塞行为。

为什么不用 runtime 的 `delivery:'parent'` 完成通知：它的通知内容与工单映射不可控，而且会多一条
模型可见消息；`delivery:'caller'` + 后台 await + `steer` 让我们完全控制通知格式、去重与账本写入。

**两次"必须问用户"**是这个模式的核心要求，都写进了协议：

1. **规划/拆分完成后**——必须停下来用 `ask_user_question` 把计划摆给用户，问是否有问题、
   是否需要调整。**用户确认之前不派任何活。**
2. **出现分歧或不确定时**——specialist / 子代理之间结论冲突、需求有歧义、必须做取舍、
   要动高风险的东西、子代理报回 BLOCKER，都交回用户选。

## 开箱预置的专家（按主流软件开发流程）

0.2.0 参考 [ToxicantX/dsh-multi-model-orchestrator](https://github.com/ToxicantX/dsh-multi-model-orchestrator)
加了第二条派发通道：**名册里的每个 specialist 是一个独立工具**。

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

保存后：**新会话**立刻拿到新的 `subagent_<id>` 工具（工具清单在启动时确定）；
已打开的会话保持启动时的名册 —— 设置页里也这么写。

于是同一个会话里，指挥者可以把"实现"派给跑在小模型上的 `subagent_implementer`、
把"审查"派给跑在强模型上的 `subagent_reviewer`，而不是所有子代理都继承父会话的模型。

### 两条派发通道怎么选

| 通道 | 工具 | 适合 |
|---|---|---|
| **多模型 specialist** | `subagent_<id>`（前台，结果直接返回） | 独立模型/专门职责、一次性的实现/审查/分析 |
| **智能体团队** | `spawn_teammate` / `send_message` / `wait_agent` / `team_task_*` | 长期存在的具名队友、持续对话、共享任务板、后台并行 |

可混用；同一批文件不要同时交给两条通道。名册为空时协议里不会出现 specialist 相关文字。

### 派活前必须做「定位匹配」

每个执行者都有**固定定位**：specialist 的定位写在名册那一行的**职责描述**里（工具描述里也写着
同一句），teammate 的定位写在它的 `description` 与 `prompt` 里。派一个任务之前，先拿任务性质
去对：**领域、产出类型、需要的技能**。

| 情况 | 做法 |
|---|---|
| 任务落在定位内 | 用对应的执行者，正常派活 |
| **差距大**（跨领域 / 不同产出 / 另一套技能） | **不要硬派**：先换一个匹配的执行者；没有就**开一个新的子智能体** |
| 一个任务里混着两种定位的工作 | 拆成两个任务，分别派 |
| 找不到任何匹配定位 | 把任务与候选定位写进正文，问用户 |

**"开一个新的子智能体"怎么做**：

- **通道 B 的 `spawn_teammate` 就是入口** — 名字、`description`、`prompt` 都由指挥者写，
  所以可以按这次任务的定位新建一个执行者（例：现有 `reviewer` 做代码审查，这次要"依赖漏洞
  扫描" → spawn 一个 `security-auditor`，把定位写进它的 description 与 prompt）。
- **通道 A 的名册不能由指挥者改**（那是用户在设置页配的）。若这个新定位以后会反复用，
  指挥者会用 `ask_user_question` 建议把它加进名册 —— 下次就能复用，还能绑定专属模型。
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

装好后在模式菜单里会出现「指挥者模式」（`order: 7`）。
模式在**新会话**里选择，已有会话的 preset 在第一轮之前就已绑定。

## 它怎么保证"指挥者不执行操作"

两道保障，一道是概率性的、一道是确定性的：

1. **协议**（system-prompt section，`order: 650`，每轮重新求值）——告诉模型它是指挥者，
   该派活。它不会被遗忘，也不会被上下文压缩掉。
2. **门禁**（`tools/pre-execute` waterfall）——指挥者自己调用
   `write` / `edit` / `pwsh` / `bash` / `job_kill` / `plugin_manager` 会被**直接拒绝**，
   拒绝理由就是纠正指令（"先用 `ask_user_question` 确认计划 → 派给 specialist / teammate"）。

门禁挂在 preset scope 上，所以**只对指挥者模式下的 agent 生效**，别的模式完全不受影响。

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

身份判别的三个证据都来自 `childSessionMeta()`：`header.parentSession`、
`header.origin === 'subagent'`、`header.delegationDepth > 0`。

## 依赖：智能体团队

Team 通道用的是 `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」）
提供的九个 Team 工具：`spawn_teammate`、`send_message`、`wait_agent`、`list_agents`、
`interrupt_agent`、`team_task_create/list/get/update`。

它们注册在每个 Team 成员 agent **自己的 ctx** 上（Lead 是隐式 Team 的 Lead，因此也是成员），
所以**本插件的 patch 不需要、也不该重复声明它们**。那个组合包同时禁用了旧的
`tool-subagent*` 控件，因此本插件的 preset **有意不镜像** standard 的 delegation 组里那四个
subagent 行——重新声明它们会让指挥者同时拿到两套 `send_message` / `list_agents` /
`interrupt_agent`。

preset 里只保留 `workflow-ptc` + `tool-workflow` 作为互补的编排通道（一次性扇出多个 fresh
子代理）。

> **specialist 工具与 Team 工具为什么不冲突**：specialist 工具是本插件用
> `ctx.tools.register()` 注册的 `subagent_<id>`，工具名与 Team 的九个工具完全不同；
> 它也不声明 `tool-subagent` 那一族随附控件，所以两套通道可以并存。

## 配置

配置挂在**顶层行 `commander-mode`**（`dsh-commander-mode/host`）上，
`cordis.patch.yml` 里已写好默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `confirmPlan` | `true` | 是否强制"规划/拆分完成后先让用户确认" |
| `escalateOnConflict` | `true` | 是否强制"子代理之间有分歧时交回用户" |
| `maxTeammates` | `4` | 写进协议的建议并行子代理上限（1–12） |
| `syncGuard` | `true` | 结算同步看板（每轮运行时上下文）+ 回合结束前的同步兜底；关掉只去掉这两样，协议里的同步要求仍在 |
| `blockedTools` | `write, edit, pwsh, bash, job_kill, plugin_manager` | 指挥者不许自己调用的工具；传 `[]` 可只留协议约束 |
| `registerSkill` | `true` | 是否把长文协议注册成 `commander-mode` skill |
| `ledger` | `true` | 工单账本（`commander_ticket_*` + 看板 + 计划授权门禁）；关掉退化为 0.5.0 行为 |
| `stateDir` | `''` | 账本位置；空 = `<DSH_HOME>/commander/<profile>.json`。相对路径以 `DSH_HOME` 为基准 |
| `requireMandate` | `true` | 派发新工作前必须有用户确认的计划授权（`commander-plan`） |
| `requireTicket` | `true` | 每次派发必须带工单（specialist 的 `ticket` 参数 / Team 的 `[ticket:t-N]`） |
| `asyncDelegation` | `true` | 一次性 specialist 异步派发：工具立即返回，完成通知唤醒指挥者；关掉回退前台阻塞 |
| `maxAsyncTasks` | `4` | 同一会话同时在飞的一次性 specialist 上限（1–12） |
| `ticketStallMs` | `600000` | 派发后多久没有新回报算"疑似停滞"（只进看板，不自动处理） |
| `maxTickets` | `100` | 账本最多保留工单数（超出裁剪最老的已结束工单） |
| `specialists` | 出厂预置名册（**volatile**） | 多模型 specialist 名册，由设置页编辑；默认 6 个按开发流程划分的专家 |
| `maxSpecialists` | `20` | 名册条数上限（每项 = 一个 preset + 一个工具） |

只有 `specialists` 是 volatile：设置页保存后 Loader 热更新运行中的引用（不重载行），
配置行通过 `commanderSettings` 服务广播，模式行据此重建 specialist preset 与工具。
其余字段是加载期配置（含 0.6.0 的 ledger / requireMandate 等），改它们要改 profile patch 并重载。

profile 层覆盖时注意：按 id 定向的 patch 会**整块替换** `config`，所以覆盖
`preset-commander` 必须重述 `id` / `name` / `description` / `order` 和整个 `plugins`
列表；覆盖 `commander-mode`（配置行）必须重述全部 config 键。

## 已知边界

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
  `wait_agent` / `list_agents` / `team_task_*` 不计入（它们是等待、读状态与建板，不是派活）。
  重启会重置计数（账本是进程内的），重启后第一次派发的配比从零开始。
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
- **共享工作目录。** 所有 specialist / teammate 观察同一个 cwd，改文件立即可见；本模式不
  提供 worktree 隔离或文件锁。协议要求"写作用域不重叠"，但 `writeScopes` 只是**提示**——
  Bash、formatter、代码生成器与直接外部写入都能绕过它。最终 diff 仍需人（或指挥者的
  只读核对）来看。
- **门禁只覆盖工具调用。** 它拦的是 DSH 工具（`write` / `edit` / `pwsh` / …）。如果指挥者
  通过别的途径（例如某个插件的自定义工具）改文件，门禁不管；`blockedTools` 可用来补。
- **关掉「智能体团队」+ 空名册 = 模式降级。** 那时指挥者没有可用的派发工具，门禁会自动
  放行（避免死锁），模式退化成"只会做协议的普通 agent"。
- **协议是概率性的。** "规划后先确认"与"分歧上报"由协议保证，模型偶尔可能跳过。门禁只兜住
  "不执行操作"这一条——那一条是确定性的。

## 开发

```powershell
cd <本插件目录>
pnpm install      # 只为 @deepseek-ai/schemastery
node --test "test/**/*.test.mjs"
```

| 文件 | 职责 |
|---|---|
| `index.js` | **配置行**（profile 顶层）：导出 `Config`、提供 `commanderSettings` / `commanderLedger` 服务、关掉自动设置页 |
| `agent.js` | **模式行**（preset 内）：协议 section、执行门禁、派发/计划授权门禁、工单工具、skill、specialist 安装与重建 |
| `lib/settings-service.js` | 配置行与模式行之间的桥：读配置/名册、广播 volatile 变化 |
| `lib/protocol.js` | 指挥者协议（紧凑版注入 system prompt，长文注册成 skill） |
| `lib/sync.js` | 结算同步状态机：账本、未同步判定、同步看板与兜底提醒的渲染（纯函数） |
| `lib/tickets.js` | 工单状态机：六态回报 → 工单状态/阶段、停滞判定、计划授权判定、`STATUS:` 解析、工单看板渲染（纯函数） |
| `lib/ledger.js` | 账本存储层：原子写、损坏备份、schema 清洗、路径解析 |
| `lib/ledger-service.js` | `commanderLedger` 服务：会话隔离的工单/授权/派发/回报读写与裁剪 |
| `lib/dispatch-gate.js` | 派发门禁：没有计划授权 / 不带工单 → 确定性拒绝；子代理/缺服务/身份不明一律放行 |
| `lib/ticket-tools.js` | 三个工单工具（create / update / list）的 schema、执行与错误文案 |
| `lib/guard.js` | 执行边界的纯函数：身份判别、判定、拒绝理由 |
| `lib/config.js` | schemastery `Config`、默认值、宽容读取器 |
| `lib/specialists.js` | 名册清洗、人设渲染、specialist preset 定义、`subagent_<id>` 工具的自实现 |
| `lib/capabilities.js` | specialist preset 的能力行（JS 版，与 `cordis.patch.yml` 逐行对齐，由测试守护） |
| `specialist.js` | specialist preset 里的人设行（`dsh-commander-mode/specialist`） |
| `client.js` | 设置页（手写 ModuleLoader bundle，无构建） |
| `cordis.patch.yml` | 配置行 + preset `commander` 的完整组合（能力行 + 模式行） |

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
