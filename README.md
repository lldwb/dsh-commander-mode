# dsh-commander-mode

DeepSeek Harness（dsh）的**指挥者模式**：接单、分析、规划与拆分，把执行全部派给子代理；
自己不执行操作，规划与分歧都交回用户用选择工具确认。

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
| `wait_agent` 等进展、核对验收判据 | 装插件（`plugin_manager`） |
| 用 `ask_user_question` 让用户确认计划、上报分歧 | 替用户拍板 |

**两次"必须问用户"**是这个模式的核心要求，都写进了协议：

1. **规划/拆分完成后**——必须停下来用 `ask_user_question` 把计划摆给用户，问是否有问题、
   是否需要调整。**用户确认之前不派任何活。**
2. **出现分歧或不确定时**——specialist / 子代理之间结论冲突、需求有歧义、必须做取舍、
   要动高风险的东西、子代理报回 BLOCKER，都交回用户选。

## 0.2 新增：可配置的多模型 specialist 名册

0.2.0 参考 [ToxicantX/dsh-multi-model-orchestrator](https://github.com/ToxicantX/dsh-multi-model-orchestrator)
加了第二条派发通道：**名册里的每个 specialist 是一个独立工具，绑定自己的模型**。

在「设置 → 插件 → 指挥者模式」里配置名册，每行：

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9_-]{0,47}$`，名册内唯一；工具名就是 `subagent_<id>` |
| `provider` / `model` | 是 | 该 specialist 固定使用的模型路由（来自 DSH 已有的 provider/model） |
| `description` | 是 | 展示给指挥者的职责摘要，用来选人 |
| `persona` | 否 | 追加到该 specialist 人设末尾的专属提示词 |
| `reasoningEffort` | 否 | 该模型支持的推理等级 |
| `maxTokens` | 否 | 该 specialist 的输出上限 |

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
| `blockedTools` | `write, edit, pwsh, bash, job_kill, plugin_manager` | 指挥者不许自己调用的工具；传 `[]` 可只留协议约束 |
| `registerSkill` | `true` | 是否把长文协议注册成 `commander-mode` skill |
| `specialists` | `[]`（**volatile**） | 多模型 specialist 名册，由设置页编辑 |
| `maxSpecialists` | `20` | 名册条数上限（每项 = 一个 preset + 一个工具） |

只有 `specialists` 是 volatile：设置页保存后 Loader 热更新运行中的引用（不重载行），
配置行通过 `commanderSettings` 服务广播，模式行据此重建 specialist preset 与工具。
其余字段是加载期配置，改它们要改 profile patch 并重载。

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
| `index.js` | **配置行**（profile 顶层）：导出 `Config`、提供 `commanderSettings` 服务、关掉自动设置页 |
| `agent.js` | **模式行**（preset 内）：协议 section、`tools/pre-execute` 门禁、skill、specialist 安装与重建 |
| `lib/settings-service.js` | 配置行与模式行之间的桥：读配置/名册、广播 volatile 变化 |
| `lib/protocol.js` | 指挥者协议（紧凑版注入 system prompt，长文注册成 skill） |
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
- **仍未验证的**：桌面版 GUI 里手动选中「指挥者模式」那个入口动作（模式绑定、协议注入、
  门禁、派发在 0.1.x 的真实 preset 会话里验证过；0.2.0 的 specialist 通道在沙箱里以
  「scope 工具集 + execute 直调」验证过，未跑「模型自然调用」）。

## 版本

- **0.2.0** —— 多模型 specialist 名册（设置页 + `subagent_<id>` 前台工具 + 每个 specialist
  独立 preset）、协议吸收可靠性纪律与双通道选择规则、新增**配置行** `commander-mode`
  （profile 顶层，`dsh-commander-mode/host`）以让设置页可达、新增依赖
  `@deepseek-ai/schemastery`。
- 0.1.2 —— README 修正；门禁在 web-app 式部署失效的修复；拒绝理由按实际工具生成。
- 0.1.0 —— 首个可用版本：协议 + 门禁 + Agent Teams 派发 + 规划确认。
