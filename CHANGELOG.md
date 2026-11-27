# Changelog

本插件的改动记在这里；版本号遵循 `.` 分段语义（大版本 = 结构性/破坏性，中版本 = 新能力，
小版本 = 修复与文档）。本文件自 8.2.2 起建立，更早的版本记录见 `git log`（各版本有 tag）。

## 8.3.0 — 2026-11-27

### 谷峰暂停后续做：被「高峰暂停」打断的下级别当失败重派

用户要求参照 `lib/reboot-resume.js`（7.28.0）的做法，对「谷峰暂停」这种中断同样在运行时上下文里
给出协议提示。

- 新增 `lib/offpeak-paused.js`：`isOffpeakPause()`（认 `aborted + hook + offpeak-pause`）、
  `lastTurnEndReason()`、`collectOffpeakPaused()`（从 `listDescendants()` 挑出「不在跑 + 最后一个
  `turn/end` 是 offpeak-pause」的直接下级，按会话缓存 60 秒，读失败按"不是暂停"处理，绝不误报）、
  `renderOffpeakPausedNotice()`（列出下级 + 三条处置口径）；
- `refreshTeamMembers()` 顺带算这组名单（与离线/在线快照同一次 `listDescendants()`），
  运行时上下文在重启提示之后渲染：「**不要重新派一批替代**、**不要当失败追责/报错**、
  需要立刻推进才 `session_resume_subagents`，否则等它们自己恢复」；没有这类下级时不输出；
- 没有 `session_resume_subagents` 时提示改为「等它们自动恢复（或让用户先关掉谷峰）」，
  不点名不存在的工具。

**验证**：指挥官测试 **844/844**（新增 9 例：判定、最后 turn/end 提取、渲染三条口径、
空名单不输出、无 resume 工具时改写、>8 个截断、`collectOffpeakPaused` 的过滤/缓存/失败降级）；
session-enhance 侧同批改动 **333/333**；真实沙箱（commander 8.2.5 + session-enhance 6.8.2）
验证了「关闭谷峰后指挥官会话收到写明『高峰暂停』的续跑消息」；本提示块由单测覆盖
（`systemPrompt.context` 不落盘，未做端到端抓取，如实说明）。

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
