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

规模：17 节点 / 2 边界 / 15 条关系 / 5 张卡片，41 条源码引用。

## 证据

- 仓库：`https://github.com/lldwb/dsh-commander-mode.git`
- 绑定 revision：`58979cb21451966d1d6e0cfbf66282028cbaebb3`（7.0.1）
- 每个组件挂仓库相对路径 + 行号；`deliver` 门禁校验为 `verified`，与工作区无关（按该 revision 的已提交字节核对）

## 校验结论

`archify finalize architecture ... --repo-root . --quality showcase` 四道门禁全过：

| 门禁 | 结果 |
|---|---|
| validate | pass（composition `showcase`，0 error / 0 warning） |
| deliver | pass（仓库证据 verified，41 条引用） |
| check | pass（正交箭头、标签净空、无交叉、图例净空） |
| browser-check | pass（1440/1600/1920/2048 四视口 × 明暗主题；无横向溢出；最小投影文字 7.1px，高于 6px 底线；1440/1600 下按 intrinsic-height 允许纵向滚动） |

自动检查未报告交叉或绕行建议；**未做人工视觉评审**，只做了自动截图确认。

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
