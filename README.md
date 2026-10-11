# dsh-commander-mode

DeepSeek Harness（dsh）的**指挥者模式**：接单、分析、规划与拆分，把执行全部派给子代理；
自己不执行操作，规划与分歧都交回用户用选择工具确认。

- 仓库：<https://github.com/lldwb/dsh-commander-mode>（**私有**，非开源）
- 许可：`UNLICENSED`
- 形态：Host 插件 + 一个 agent preset（模式）
- 依赖：`@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」）

## 它做什么

在输入框上方的模式菜单里选中「指挥者模式」后，当前会话的 agent 变成**指挥者**：

| 它做 | 它不做 |
|---|---|
| 只读侦察（`read` / `glob` / `grep` / `web_search`） | 写文件、改文件（`write` / `edit`） |
| 规划与拆分、维护 `todo_write` | 跑命令（`pwsh` / `bash`） |
| 建任务板、`spawn_teammate` 派活 | 杀作业（`job_kill`） |
| `wait_agent` 等进展、核对验收判据 | 装插件（`plugin_manager`） |
| 用 `ask_user_question` 让用户确认计划、上报分歧 | 替用户拍板 |

**两次"必须问用户"**是这个模式的核心要求，都写进了协议：

1. **规划/拆分完成后**——必须停下来用 `ask_user_question` 把计划摆给用户，问是否有问题、
   是否需要调整。**用户确认之前不 spawn 任何 teammate、不建任何任务板、不派任何活。**
2. **出现分歧或不确定时**——子代理之间结论冲突、需求有歧义、必须做取舍、要动高风险的东西、
   子代理报回 BLOCKER，都交回用户选。

## 安装

```powershell
# 桌面版：用 plugin_manager 工具安装本目录
plugin_manager { action: "install_bundle", target: "E:\dsh-plugins\dsh-commander-mode" }
```

装好后在模式菜单里会出现「指挥者模式」（`order: 7`，排在面试模式之后）。
模式在**新会话**里选择，已有会话的 preset 在第一轮之前就已绑定。

## 它怎么保证"指挥者不执行操作"

两道保障，一道是概率性的、一道是确定性的：

1. **协议**（system-prompt section，`order: 650`，每轮重新求值）——告诉模型它是指挥者，
   该派活。它不会被遗忘，也不会被上下文压缩掉。
2. **门禁**（`tools/pre-execute` waterfall）——指挥者自己调用
   `write` / `edit` / `pwsh` / `bash` / `job_kill` / `plugin_manager` 会被**直接拒绝**，
   拒绝理由就是纠正指令（"先用 `ask_user_question` 确认计划 → 用 `spawn_teammate` +
   `send_message` 派活 → 或用任务板"）。

门禁挂在 preset scope 上，所以**只对指挥者模式下的 agent 生效**，别的模式完全不受影响。

### 为什么不干脆把 `write` 从 preset 里裁掉

因为裁不掉，这是硬约束：子代理通过 `agentPresets.composeFrom()` 加入**父会话的同一个
preset scope**（`bindScopeParent(childKey, generation.key)`），而 per-child 的工具限制
只能**收紧**、不能扩展。一旦把 `tool-fs` / `tool-pwsh` 从 preset 里删掉，**teammate 也会
一起失去这些能力**，模式就彻底干不了活了。

所以能力行必须保留，边界落在"**谁可以调用**"这一层——这也正是 `tools/pre-execute` 存在的
意义。

### 判错方向的代价是不对称的

门禁最怕的不是漏拦，而是**拦到子代理**。所以 `lib/guard.js` 里每一个"拿不准"的分支都
走放行：

- 读不出 agent 身份（没有 `session.header`）→ 当作子代理，放行；
- 判定过程抛错 → 放行，并让工具调用继续；
- 这个部署里一个派发工具都没有（用户关掉了「智能体团队」）→ 放行（否则会话死锁）。

身份判别的三个证据都来自 `childSessionMeta()`：`header.parentSession`、
`header.origin === 'subagent'`、`header.delegationDepth > 0`。

## 依赖：智能体团队

派发通道用的是 `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」）
提供的九个 Team 工具：`spawn_teammate`、`send_message`、`wait_agent`、`list_agents`、
`interrupt_agent`、`team_task_create/list/get/update`。

它们注册在每个 Team 成员 agent **自己的 ctx** 上（Lead 是隐式 Team 的 Lead，因此也是成员），
所以**本插件的 patch 不需要、也不该重复声明它们**。那个组合包同时禁用了旧的
`tool-subagent*` 控件，因此本插件的 preset **有意不镜像** standard 的 delegation 组里那四个
subagent 行——重新声明它们会让指挥者同时拿到两套 `send_message` / `list_agents` /
`interrupt_agent`。

preset 里只保留 `workflow-ptc` + `tool-workflow` 作为互补的编排通道（一次性扇出多个 fresh
子代理）。

## 配置

挂在 preset 子行 `commander-mode` 上的字段（`cordis.patch.yml` 里已写好默认值）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `confirmPlan` | `true` | 是否强制"规划/拆分完成后先让用户确认" |
| `escalateOnConflict` | `true` | 是否强制"子代理之间有分歧时交回用户" |
| `maxTeammates` | `4` | 写进协议的建议并行子代理上限（1–12） |
| `blockedTools` | `write, edit, pwsh, bash, job_kill, plugin_manager` | 指挥者不许自己调用的工具；传 `[]` 可只留协议约束 |
| `registerSkill` | `true` | 是否把长文协议注册成 `commander-mode` skill |

profile 层覆盖这个 preset 时注意：按 id 定向的 patch 会**整块替换** `config`，必须重述
`id` / `name` / `description` / `order` 和整个 `plugins` 列表。

## 已知边界

- **`inactive` ≠ 做完了。** teammate 的 `inactive` 只表示"当前没有轮次在执行"。判断结果
  要看它报回来的内容与验收判据——协议里写明了，但这是模型行为，不是代码保证。
- **共享工作目录。** 所有 teammate 观察同一个 cwd，改文件立即可见；本模式不提供 worktree
  隔离或文件锁。协议要求"写作用域不重叠"，但 `writeScopes` 只是**提示**——Bash、formatter、
  代码生成器与直接外部写入都能绕过它。最终 diff 仍需人（或指挥者的只读核对）来看。
- **门禁只覆盖工具调用。** 它拦的是 DSH 工具（`write` / `edit` / `pwsh` / …）。如果指挥者
  通过别的途径（例如某个插件的自定义工具）改文件，门禁不管；`blockedTools` 可用来补。
- **关掉「智能体团队」= 模式降级。** 那时指挥者没有 Team 工具，门禁会自动放行（避免死锁），
  模式退化成"只会做协议的普通 agent"。
- **协议是概率性的。** "规划后先确认"与"分歧上报"由协议保证，模型偶尔可能跳过。门禁只兜住
  "不执行操作"这一条——那一条是确定性的。

## 开发

```powershell
cd E:\dsh-plugins\dsh-commander-mode
node --test          # 57 个用例：门禁判定、协议文本、patch 结构、插件接线
```

零依赖：不 import 任何 `@deepseek-ai/*`，不声明 `Config`（配置在 `lib/config.js` 里自己解析），
因此 `install_bundle` 不会有 `pendingBuilds`、不需要 `approvedBuilds`。

| 文件 | 职责 |
|---|---|
| `index.js` | 接线：prompt section、`tools/pre-execute` 门禁、skill |
| `lib/protocol.js` | 指挥者协议（紧凑版注入 system prompt，长文注册成 skill） |
| `lib/guard.js` | 执行边界的纯函数：身份判别、判定、拒绝理由 |
| `lib/config.js` | 零依赖配置解析 |
| `cordis.patch.yml` | preset `commander` 的完整组合（能力行 + 本插件） |

### 验证过什么

- **`node --test` 63/63 通过**，含"teammate 调用 `write` 必须放行"这条关键断言。
- **`preset_audit` 审计 `commander`**：20 个子行全部 `ACTIVE`、无 `broken`，scope 工具集
  符合预期（`write` / `edit` / `pwsh` 保留给子代理，`ask_user_question` / `todo_write` /
  `workflow` 到位）。
- **端到端门禁验证**（一次性 headless 探测 profile，装一个"只带门禁、不带协议"的诊断
  插件，好让模型真的去试）：

  ```
  PROBE-EXEC   {"tool":"pwsh","parentSession":null,"origin":null,"delegated":false}
  PROBE-DENY   {"tool":"pwsh","kind":"deny"}                       ← Lead 被拒
  PROBE-EXEC   {"tool":"subagent",...}                             ← 模型改去派发
  PROBE-EXEC   {"tool":"pwsh","parentSession":"session-498c…",
                "origin":"subagent","delegationDepth":1,"delegated":true}
                                                                   ← 子代理放行，真的跑了
  ```

  模型收到的拒绝原文就是 `Error: 指挥者模式：你不自己执行 \`pwsh\`。…`，随后它按纠正指令
  派了 `subagent`，子代理的 `pwsh` 调用**没有被门禁拦**（那次调用失败于 headless 沙箱的
  ACL 问题，与门禁无关）。

  这次探测抓到了一个真实缺陷并已修复：拒绝理由最初把 `spawn_teammate` 与
  `team_task_create` 写死了，而那个部署里**没有 Agent Teams**，模型收到"请用
  `spawn_teammate`"却找不到这个工具，**当场卡住**。现在理由按 agent 实际拥有的工具生成
  （见 `lib/guard.js` 的 `buildDenialReason`，以及 `test/guard.test.mjs` 里那组
  "拒绝理由必须适配真实部署"的用例）。
- **仍未验证的**：桌面版 GUI 里选中「指挥者模式」后的真实会话表现（preset 绑定只在
  web bundle 里发生，headless 验证不了）。上面那次端到端走的是"全局挂同一份门禁代码"的
  等价路径。
