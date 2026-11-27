# Changelog

本插件的改动记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。本文件自 8.2.2 起建立，更早的版本记录见 `git log`（各版本有 tag）。

## 8.2.5 — 2026-11-27

### 插件卡片描述改为只描述当前能力
- `locale/zh.json` / `locale/en.json` 的 `meta.description`（插件卡片实际显示的文案）改为只描述
  当前能力并收敛长度：zh 402 → 147 字符，en 1017 → 276 字符；`meta.title` 与设置页文案未动。

## 8.2.4 — 2026-11-27

### 清单描述去版本史
- `package.json` 的 `description` / `meta.description` 改为只描述当前能力（原文带 `7.0.0 起…`、
  `Worker Session 实现 7.0.1 已删除`、`2.1.0 起…`、`7.20.0 起…` 这类版本史），两处保持同义。
- 新增本文件；README 在「仓库 / 许可」处增加「变更历史」指针；`package.json` 的 `files`
  收录 `CHANGELOG.md`。

## 8.2.3 — 2026-11-26

### 修正 README 加载方式标记行
- 标记行里的「5 个工具」是陈旧计数，改为按名字列：3 个工单工具
  （`commander_ticket_create` / `commander_ticket_update` / `commander_tickets`）+ 每位专家一个
  `subagent_<id>`（出厂名册 6 位）。
- 同一行里「3 个提示词 section」与实际不符（源码是 2 个 `systemPrompt.section` +
  1 个 `systemPrompt.context`），改为按名字列 `commander:mode` / `commander:specialist` /
  `commander:sync-board`，不再写数量。
- 正文里「返工 / 复现」这类过程叙述措辞改为现状陈述（工单多次派发的说法、`tester` 定位、
  工作流手册的「失败后的补救规则」）。

## 8.2.2 — 2026-11-26

### README 只描述当前版本
- README 从 3971 行 / 359 KB 整理为只描述当前版本（886 行 / 63 KB）：删掉版本标注、逐版本
  changelog 式叙述、各版本实测与验证记录、迁移指南与「用户要做什么」、经验教训小节。
- 补齐旧 README 漏写的当前能力：13 类看板告警、默认拦截的 55 项 `blockedTools`（旧文档写 48）、
  3 个工单工具、2 个 preset（`commander` / `commander-cc`）、`stallWatchdog` 与
  `degenerationGuard` 两个配置键、重启后续做、通知补投与冷唤醒、任务板投影细节。
- 该次提交同时把版本升到 8.2.2；`package.json` 的 `repository` / `homepage` / `bugs` 当时已正确
  指向本仓库，未改动。首次建立 `v8.2.2` 发版 tag。
