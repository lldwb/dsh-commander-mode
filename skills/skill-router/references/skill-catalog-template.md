# 技能分类路由表（模板）

`skill-router` 的参考件：按任务特征分类的候选技能表 + 通用决策口诀。技能名是本仓库 29 个通用工作流技能，项目装了自定义技能时按同一结构补行。**判断以各技能 `SKILL.md` frontmatter 的 `description` 为准，本表只做第一轮归类。**

## 怎么用

1. 读用户原话，按「动作 + 产出」定位到下面某个分类；
2. 该分类的候选技能逐一出列，读各自 `description` 的「何时用 + 边界互指」排除；
3. 只剩一个 → 确定；多个 → 用「三问」（改不改代码？行为变不变？产出是什么？）收敛；
4. 仍模糊 → AI 判断按"用户意图中最重的需求"取，附理由与备选交用户。

## 通用决策口诀

- **改不改代码？**
  - 不改 → 按对象：查提交 `code-review` / 查日志 `log-diagnose` / 查库 `db-query` / 前端报错 `frontend-error-diagnose` / 讲概念 `project-explain` / 查规范 `spec-route`；写文档 → 对齐既有 `doc-sync`、建立或增补指引 `repo-init`
  - 改 → **行为变不变？** 变 → 缺陷 `bug-fix` / 新需求 `feature-dev` / 文案国际化 `i18n-transform`；不变 → 注释层 `comment-supplement` / 小范围 `code-optimize` / 结构 `refactor`
- **git 动作**：提交 `commit-create` / 提 MR·PR `mr-create` / 历史改写 `git-history-rewrite` / 回滚 `git-rollback` / 清分支 `git-clean-branches` / worktree `git-worktree`
- **编排**：任务指挥 `task-commander` / 经 opencode CLI `opencode-batch` / worktree+子代理 `module-batch` / 逐 Controller `check-rule-extract`
- **产出形态**：测试 `unit-test` / Excel `check-rule-extract` / 诊断报告 `log-diagnose`·`nas-disk-diagnostic` / 打包产物 `app-packaging`
- **元工作**：总结会话 `session-summary` / 选技能 `skill-router`（本技能）

## 分类路由表

| 分类 | 候选技能 | 区分判据（description 里的边界句） |
|---|---|---|
| 缺陷修复 | `bug-fix` | 问题现象 + 报错 / 复现；四段式定位。纯注释问题转 `comment-supplement` |
| 新需求 / 大改造 | `feature-dev` | 需求到落地全流程；跨前后端 / 外部依赖。小范围优化转 `code-optimize` |
| 小范围优化 | `code-optimize` | 对外行为不变、重复代码 / 局部性能 / 可读性。结构性转 `refactor` |
| 结构改造 | `refactor` | 对外行为不变、分层 / 迁移 / 批量同构；契约先行 + 测试基线 |
| 注释补齐 | `comment-supplement` | 严格注释层面；与代码改动并存用 `bug-fix` |
| 文案国际化 | `i18n-transform` | 硬编码文案 → 资源文件，三条改造线 |
| 代码评审 | `code-review` | 只检查不改代码；对象：提交（sha/分支/PR）/ 合并（分支区间）/ 模块 / 项目整体 / 架构 |
| 日志诊断 | `log-diagnose` | trace_id + 时间窗，Kibana 多环境；BUG 出双 MD |
| 数据库查询 | `db-query` | 查业务数据 / 核对数据状态；生产只读 |
| 前端报错 | `frontend-error-diagnose` | 浏览器侧报错，先复现再定位；只诊断不改代码 |
| 项目讲解 | `project-explain` | 讲清概念，引用真实代码位置，不臆造 |
| 文档对齐 | `doc-sync` | 文档与代码实际行为不一致的同步修正；代码改造转 `feature-dev` |
| 指引建立 / 增补 | `repo-init` | 生成 / 更新 AGENTS.md；含增补规范条款；提交前先问 |
| 提交改动 | `commit-create` | 工作区已改动 → 本地提交；提交环节 SSOT |
| MR / PR 生成 | `mr-create` | 分支已提交 → 生成合并请求；四段式描述 |
| 历史改写 | `git-history-rewrite` | 拆分 / 改类型 / 重排 / 删除既有提交；先备份、强推前确认 |
| 分支回滚 | `git-rollback` | 分支回滚到历史版本；默认 dry-run + 备份分支 |
| 分支清理 | `git-clean-branches` | 清理已合并 / 过期分支；默认 dry-run + 保护清单 |
| worktree 管理 | `git-worktree` | 建 / 列 / 删 worktree；内容迁移 |
| 任务指挥与编排 | `task-commander` | 分析 → 规划拆分 → 派子代理按映射技能执行；同构多模块批量转 `module-batch` |
| 多模块并行 | `module-batch` | worktree 隔离 + 子代理直接改造 + 合并 |
| opencode 并行 | `opencode-batch` | 经 opencode CLI 中转的多模块并行 |
| 校验规则提取 | `check-rule-extract` | 菜单入口 → 逐 Controller 追溯 → Excel 工作簿 |
| 单元测试 | `unit-test` | 生成测试 / 修复失败测试 |
| NAS 诊断 | `nas-disk-diagnostic` | 硬盘故障排查 + SMART + 可视化报告；只读采集 |
| 打包分发 | `app-packaging` | 产物形态 → 跨平台构建 → CI 与 Release 附件分发 |
| 规范路由 | `spec-route` | 按场景定位 `AGENTS.md` 章节，按段加载——路由的是规范，不是技能 |
| 会话总结 | `session-summary` | 把会话收尾为总结 + 技能优化点 + 实施 |
| 技能路由 | `skill-router` | 从可用技能中做选择——本技能 |

## 易混对（高频误判，写理由时先自查）

| 对 | 区分点 |
|---|---|
| `spec-route` / `skill-router` | 任务对象是"规范章节"还是"技能" |
| `code-optimize` / `refactor` | 改动范围：小范围局部 vs 结构 / 迁移 / 批量 |
| `bug-fix` / `code-optimize` | 是缺陷（行为有错）还是优化（行为正常、只是不好） |
| `doc-sync` / `repo-init` | 对齐既有文档 vs 建立 / 增补指引 |
| `log-diagnose` / `db-query` / `code-review` | 任务对象：日志 trace / 业务数据 / 提交 sha |
| `feature-dev` / `doc-sync` | 主体是代码改造还是纯文档 |

## 填表说明（项目有自定义技能时）

- 新增技能按「分类 / 候选技能 / 区分判据」三列补行，区分判据抄该技能 `description` 的边界句；
- 同一技能可出现在多个分类（如 `i18n-transform` 既是改代码也是编排），重复行没关系，按实际归类；
- 判断永远以各技能 `description` 原文为准，本表与 description 冲突时以 description 为准。
