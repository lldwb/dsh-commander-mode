# 指挥者模式架构图

本目录存放「指挥者模式」（`dsh-commander-mode`）的运行时架构图，供人阅读与后续修订。

| 文件 | 说明 |
|---|---|
| `commander-mode-architecture.html` | 架构图成品，单文件自包含，`file://` 直接打开 |
| `commander-mode-architecture.candidate.json` | 图的候选定义（组件 / 关系 / 边界 / 卡片 + 源码证据行号） |
| `preview.png` | 静态预览截图 |

## 这张图画了什么

按「**装配期** vs **运行时**」分层：

- **装配期**（右上）：`lib/capabilities.js` 能力行单一来源 → `preset-commander` 声明行（order 7）→ `commander-mode-agent` 模式行；工作流行 `project-dev-workflow` 只注册 skill、不参与运行时连线。这一组被 `preset scope: commander` 边界框住，表达"preset 是完整组合、每个会话一份隔离 scope"。
- **运行时**（左）：用户 → 指挥官会话 L0 → 小组长 L1 → 子智能体 L2，主链路标绿。
- **门禁**：`确定性门禁（仅 Lead 生效）` 边界框住门禁瀑布与派发门禁，红线贯穿主链路——这是代码级拒绝，不是提示词约束。
- **持久化与外部**：工单账本、共享任务板、外部事件源 / 投递器、设置页 client 半各自独立成节点。
- **卡片（6 张）**：两条 Loader 行 / 门禁是代码 / 三层指挥链 / 持久化与外部事件 / 专家名册 /
  **通知链：子完成→组长→指挥官（7.5.0）**。

规模：17 节点 / 2 边界 / 15 条关系 / **6 张卡片**，41 条源码引用。

## 证据

- 仓库：`https://github.com/lldwb/dsh-commander-mode.git`
- 绑定 revision：`3675d1b896c29806c3b22564d576db29e4c55a00`（7.5.0）
- 每个组件挂仓库相对路径 + 行号；`deliver` 门禁校验为 `verified`，与工作区无关（按该 revision 的已提交字节核对）

## 校验结论

`archify finalize architecture ... --repo-root . --quality showcase --browser-check` 四道门禁全过：

| 门禁 | 结果 |
|---|---|
| validate | pass（composition `showcase`，0 error / 0 warning） |
| deliver | pass（仓库证据 verified，41 条引用） |
| check | pass（正交箭头、标签净空、无交叉、图例净空） |
| browser-check | pass（1440/1600/1920/2048 四视口 × 明暗主题；无横向溢出；最小投影文字 6.36px，高于 6px 底线） |

产物：HTML 880,663 B（sha256 `658282ef…`）、`preview.png` 由 `visual-check` 的
1440×900 light 截图替换。**未做人工视觉评审**，只做了自动截图 + 卡片区抽查。

## 7.5.0 这次改了什么（与图的关系）

| 改动 | 图里的落点 |
|---|---|
| 团队模型从八条变**十条**（7.1.0 第 9 条团队形状、7.2.0 第 10 条完成语义） | 协议 section 行本身没变；判据写在卡片「三层指挥链」与「门禁是代码」 |
| **新增结算门禁** `evaluateTicketSettle`（7.2.0） | 门禁瀑布 `sublabel` 补「结算」+ 门禁卡片新增一条 + `guard` 组件新增源码引用（替换掉旧的一条，schema 上限 3 条） |
| **新增通知链兜底** `lib/wake-chain.js` + `subagent/end` 监听器（7.5.0） | 新增第 6 张卡片 + `agentRow` 组件新增源码引用（替换旧的一条） |
| 全仓代码改动导致 **9 条源码行号漂移** | 用「旧 revision 行内容 → 当前文件重新定位」脚本重映射，41 条引用全部核对 |

> ⚠️ **`deliver` 门禁不校验行号内容**：只把 revision 换成 HEAD、行号不动，`deliver` 仍然
> `verified: true`（实测）。所以**图会静默过期**——`agent.js:1179` 原本指 pre-execute 监听器，
> 代码改动后指向了 `canDelegate: ...`，门禁不报错。改代码后重跑图时，**必须自己核对行号**，
> 不能只看门禁绿灯。

## 怎么重新生成

图由 [Archify](https://github.com/tt-a1i/archify) 技能生成（DSH 插件 `@tt-a1i/archify-dsh`）。改图时编辑候选 JSON，再重跑：

```bash
node <archify>/bin/archify.mjs finalize architecture \
  文档/commander-mode-architecture.candidate.json \
  文档/commander-mode-architecture.html \
  --repo-root . --quality showcase --json
```

`--repo-root` 指向本仓库根，用于校验候选里的源码证据行号。代码改动后需同步更新受影响组件的 `sources` 行号，否则 `deliver` 会失败。

> 注意：`finalize` 的 `browser-check` 需要启动 Chrome 子进程。若在受限沙箱（禁止子进程建命名管道）里运行，会以 `spawn EPERM` 失败；这是环境限制，不是图的问题。
