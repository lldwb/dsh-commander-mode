# 发 Release 的 GitHub 机制坑位清单

覆盖「CI 构建完 → 发 Release 附件」这段最容易踩的 GitHub 机制坑。全部为实测（2026 年、GitHub Actions + `gh` CLI），**换个项目一样成立**，与本仓库的目标项目无关。对应 `ci-distribution.md` 的「Release 附件的坑」一节，这里收的是更深的机制坑。

## 令牌分工：控制面走 PAT、数据面走内置 token

- **现象**：Release 署名是 `github-actions[bot]`；或改用作者 PAT 后附件上传反复失败（一跑十几到二十几分钟才挂），构建 job 却全绿。
- **根因**：① 内置 token 建 Release 时作者就是 bot 身份；② PAT 上传附件不稳定（实测同量附件内置 token 97 秒传完、PAT 三次尝试全失败，且都卡在同一类体积较大的文件上）；③ 内置 token 建 Release 产生的 `release: published` 事件**不触发**新的 workflow 运行（`GITHUB_TOKEN` 驱动不了 `on: release` 自动化），想加「发版后自动跑点什么」只有 PAT 建的会触发。**Release 作者一经创建无法修改**（update 接口没有 author 字段），换署名只能删了重建。
- **处置**：**建 / 改 Release 用作者 PAT（署名才是本人），附件传输用内置 `GITHUB_TOKEN`**；release job 给 `permissions: contents: write`。PAT 存仓库 secret（如 `RELEASE_TOKEN`），并在**最早的 job 就真调一次 API**（`/user` 确认身份 + `repos/<repo>` 确认写权限）——几秒暴露令牌问题，别等 40 分钟构建跑完。

## `gh release create` 先建草稿、传完附件才发布

- **现象**：中途取消 / 失败后留下一个草稿；下次运行报「已存在」跳过、或页面出现带「草案」标记的重复项。
- **根因**：`gh release create` 实际是「建草稿 → 逐个传附件 → 发布」三步。草稿对**匿名接口不可见**（列表列不出、按 tag 查 404），但有写权限的令牌**看得见** → 把草稿当已发布而跳过，表面成功、实际什么都没发出去。
- **处置**：发布步骤**只对已发布的跳过**；草稿一律按下面「草稿复用续传」处理。**「发布步骤 0 秒过、Releases 里却没有这个版本」就是被草稿骗过的信号**。

## 草稿复用续传，但只复用自己的

- **根因**：一次性 `gh release create <tag> dist/*` 是**串行传完所有附件、任一附件失败整条命令作废**，已传的部分只能重来；「第一个附件失败就 exit 1」一样糟——后面的附件连试都没试过。
- **处置**：先 `gh release create --draft` 建草稿 → **逐个 `gh release upload --clobber`**（每个 3 次重试、单次长 timeout）→ 全部成功才 `gh release edit --draft=false`。失败**不中断**、全部试完再 exit 1，于是失败附件的名字与 gh 错误原文一起落进日志。
- **续传**：本地 `sha256sum` 比远端附件的 `.digest` 字段（`digest` 为空的老式上传判不等、重传，偏向安全）；一致的跳过、缺什么补什么，发布前把不属于本次构建的遗留附件 `gh release delete-asset --yes` 清掉。
- **只复用自己的草稿**：署名在建 Release 那一刻定死，复用一个内置 token 建的草稿，最终署名仍是 bot。续传前比草稿 `.author.login` 与发布令牌 `gh api user` 的 `.login`，对不上就 `gh release delete --yes`（**不带 `--cleanup-tag`，tag 保留**）后重建。

## 上传失败要能查、要能续

- **关键事实**：`::error::` **注解匿名可读**（`GET /repos/{o}/{r}/check-runs/{job_id}/annotations`），而 job 日志要仓库权限（匿名 403）。**「失败但没有任何注解」本身就把范围缩到「没包错误输出的那一行」**。
- **处置**：每条会失败的 gh 命令外头包一层错误输出（失败时把 gh 原文写进 `::error::` 注解）；上传循环逐个报附件名。

## Release 更新接口只认数字 id

- **根因**：`PATCH /repos/{o}/{r}/releases/{release_id}` 的参数就是数字 id；按 tag 只有 `/releases/tags/<tag>` 这一个独立端点，且**只支持 GET**。`gh api -X PATCH ".../releases/tags/$TAG" -f draft=false` 会 404 静默失败——没包错误输出就只剩 `exit code 1`，既看不出栽在哪一行、又让该版本停在「删了没建回来」的中间态。
- **处置**：改 / 删先查 id；或直接用 `gh release create / edit / delete`（内部自己按 tag 查 id），**每条控制面命令包错误输出**。

## `make_latest` 默认 true，草稿转正会抢 Latest

- **根因**：草稿转正（`draft=false`）默认把 Latest 徽标抢过来；重建旧版本后 Latest 挂在旧版本上，页面观感即错。
- **处置**：**Latest 归属按版本号现算，不记忆「原来是谁」**——取 tag 形如 `vX.Y.Z` 的最大正式版本（非草稿、非预发布），每次重建完用 `gh release edit <tag> --latest` 重算一次。别记录「重建前是谁」：两次修复可以并发跑，先记下的会被另一次运行改掉；`published_at` 也会被重建重置，按时间排不出先后。

## `actions/checkout` 会清空既有工作区

- **根因**：runner 工作区目录**本来就在**、而里面还没有 `.git` 时，checkout 走 `prepareExistingDirectory` 的 remove 分支，把整个目录**删了重建**（步骤日志里有 `Deleting the contents of ...`）。**在 checkout 之前落盘的文件全没了**。
- **现象**：Release 都建好发布了、workflow 却红——某步读到不存在的文件、`bash -e` 闷声退出、一条注解都没有，极难查。
- **处置**：跨步骤传文件一律放 checkout **之后**；能用现算解决的（Latest 归属即一例）就别传文件。

## `workflow_dispatch` 读默认分支的 yml

- **根因**：手动触发（`workflow_dispatch`）的 workflow 永远取**默认分支**上那一份 yml。改完不推，页面上看不到新 job / 新输入项，「选不到新任务」。
- **处置**：改 workflow 后先推默认分支，再手动触发。

## 显式 `permissions` 会清零未列出的权限

- **根因**：job 里一旦写 `permissions:`，未列出的权限全部归零。例：release job 只写 `contents: write`，`gh run download`（取备份 artifacts，走 `/actions/` 接口）就 403。
- **处置**：用到 `gh run` / artifacts / 备份下载时把 `actions: read` 一并列出。

## GitHub 没有重命名附件的接口

- **根因**：改附件名只能「传新名 + 删旧名」（先下载 → 改名 → 上传 → 删旧）。
- **处置**：**先传后删**——新名字全部就位、校验和（`SHA256SUMS`）也重算成指向新名字之后，才删旧名字；任何时刻页面清单只列**真实存在且哈希对得上**的文件，中途失败只多留一组旧名（重跑按 digest 跳过已传的）。识别规则要保守：**认不出就不改，比改错强**。

## 已发布的 Release 不随 CI 重跑而更新

- **根因**：发布步骤对已发布的 Release 直接跳过。强推 tag 重跑 CI 不会覆盖已发布版本的产物与正文。
- **处置**：改已发布版本的**正文**直接 `gh release edit <tag> --notes-file <文件>`（只换正文、不碰附件）；改**产物 / 署名**只能删了重建（可先把附件备份到 artifacts 供续建，或走项目自己的修复工作流）。

## 取资产别用 API 资产端点，用 `browser_download_url` 直链

- **根因**：`GET /repos/{o}/{r}/releases/assets/<id>` 不带 `Accept: application/octet-stream` 时返回的是该资产的 **JSON 元数据**，不是二进制——消费端脚本若用资产对象里的 `url` 字段当下载地址，下载回来的是 `{"ur…` 开头的 JSON，肉眼都看得出、程序却常因「挑对了名字」而漏掉下载地址这道验证。
- **实证**：某 CLI 的自更新从最早版本起就没装成过、多个版本无人发现——按名字挑对了附件，url 却给的是资产端点；有文件头校验护栏的一侧被拦下（侥幸没坏），无护栏的一侧会把 JSON 当安装包启动（更糟）。
- **处置**：下载方只信资产对象里的 **`browser_download_url`**（`/releases/download/<tag>/<文件>` 直链），或请求头带 `Accept: application/octet-stream`；发版后的「下载 / 更新链路实测」（见 SKILL.md 验证）就是这道兜底——下载到的要是产物本身，不是 JSON / HTML。

