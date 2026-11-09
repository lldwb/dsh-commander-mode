# CI 构建与分发（GitHub Actions）

本文件覆盖「构建在哪跑、产物怎么交付」两段。artifact 与 Release 附件的区别是最容易混的一处，逐条核对。

## 触发方式

| 触发 | 适用 | 代价 |
|---|---|---|
| tag（`on.push.tags`） | 发布正式版本，产物与 tag 一一对应 | 打错 tag 会触发一轮构建；产物要改就得重打 tag |
| 手动（`workflow_dispatch`） | 先验证能不能构建、内部试用 | 产物与版本无强绑定 |
| 分支 push | 每次改动都验证构建 | 耗 CI 额度 |

判据：**产物要与版本一一对应时用 tag 触发**。tag 触发的 workflow 里版本号取 `github.ref_name`（tag 名）注入产物，**别再让使用者手填一遍**——两处各写一份版本号必然漂移。

### 无 gh CLI 环境手动触发（API 兜底）

本机没有 `gh` 时，触发 / 查状态 / 取日志全走 REST API，token 用 `git credential fill` 取推送凭据（**只进命令、不落盘不打印**）：

```bash
CRED=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password[=]//p')

# 触发手动构建（workflow_dispatch，不打 tag、不发版）
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $CRED" -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/<owner>/<repo>/actions/workflows/<workflow>.yml/dispatches" \
  -d '{"ref":"main"}'

# 查最近运行与 job 状态
curl -s -H "Authorization: Bearer $CRED" \
  "https://api.github.com/repos/<owner>/<repo>/actions/runs?per_page=3"

# 取某 job 日志（302 重定向到签名存储；跨主机后 curl 默认丢 Authorization——别加 --location-trusted，会把凭据带到重定向目标）
curl -sL -H "Authorization: Bearer $CRED" \
  "https://api.github.com/repos/<owner>/<repo>/actions/jobs/<job_id>/logs"
```

要点：`api.github.com` 常可直连（与 `github.com` 不同出口，后者可能要代理）；触发返回 204 即成功；日志接口的跨主机重定向坑见仓库 `AGENTS.md` 已知坑。

## 多平台编排（matrix）

- 维度是 **OS × 架构**（`windows-latest` / `macos-latest` / `ubuntu-latest` × `x64` / `arm64`）；
- `fail-fast: false`：一个平台失败不掐掉其他平台，一次看清全部问题；
- **产物名必须带平台与架构**（`<应用名>-<版本>-<平台>-<架构>`），否则多 job 上传同名互相覆盖；
- arm64 的托管 runner 可用性按 GitHub 最新文档核对；不可用时改用交叉构建（受 `node-sea.md` 的跨平台限制）或自建 runner；
- 构建步骤抽成**平台无关的一段**，平台差异用条件分支，避免三份复制粘贴互相漂移。

## Artifacts 与 Release 附件的区别（最容易混）

| | Artifacts（`actions/upload-artifact`） | Release 附件（release asset） |
|---|---|---|
| 用途 | workflow 内 job 之间传递、临时下载 | 对外发布给使用者下载 |
| 保留 | **默认 90 天**（可设 1–90），过期即删 | 长期保留 |
| 形态 | **上传目录会被打成 zip**，下载得到 zip | **原始文件，不套 zip** |
| 文件权限 | **剥掉**：目录 755、文件 644 | 保留 |
| 访问 | 需登录且有权限；跨 run / 跨仓要带 token | 公开直链 `/releases/download/<tag>/<文件名>` |

**结论**：给人下载的产物一律走 Release 附件；artifact 只当 workflow 内的中转。

### Artifacts 的坑

- **可执行位会丢**：Linux / macOS 二进制经 artifact 传递后**不再可执行**（这是官方行为，不是 bug）——要么别经 artifact 直接发 Release 附件，要么先 `tar` 再用 `archive: false` 直传单文件（需较新版本 action）；
- **隐藏文件默认不上传**（`.` 开头的文件与目录）——需要时显式开启；
- v4 起 artifact **不可变、同名必须唯一**，多个 job 不能修改同一个 artifact（并列上传同名会直接报错）；
- 上传目录时压缩级别可调（默认 6；随机二进制数据可设 0 省时间）；
- 跨 run / 跨仓下载需要 `github-token`（`actions:read`）。

### Release 附件的坑

- **同名重复上传报 422**：重跑发版前必须先删旧附件（`gh release upload --clobber` 可覆盖）；
- 文件名里的**特殊字符与首尾点号会被 GitHub 重命名**——命名只用字母数字与点划线，下载链接才不会失效；
- 上传需要 `permissions: contents: write`；
- 上传过程中游 502 可能留下 `state: starter` 的空附件，需删除后重传；
- 若项目已有自己的 Release 正文来源（如由 CHANGELOG 生成），上传步骤**只传附件、别让 CI 重建 Release 正文**——否则与既有正文互相覆盖；
- **产物命名变更要过渡一版双名字**：自更新 / 下载脚本通常按附件名里的平台词 / 架构词匹配产物，改名（如平台词 `darwin`→`macos`）后只发新名的 Release 会让**旧版使用者的自更新断链**（旧版只认旧词）。做法：改名版本里让挑附件逻辑**同时认新旧两套词**（新名优先、旧词兜底），并在 Release 挂一份旧名字的过渡附件（开关变量控制仅本次开启），下一个版本再撤旧词与过渡附件——旧版使用者沿旧附件完成最后一次更新，之后才走新名。

## 长编译与缓存的坑

- **缓存按 ref 作用域**：tag push 触发的 run 恢复不了非默认分支建的缓存（日志 `Cache not found for input keys: …`）——特性分支上试跑得再热，tag 一打全 miss、全量重编。要让发版构建快：打 tag 前在**默认分支**上 `workflow_dispatch` 跑一次构建预热缓存（默认分支的缓存对所有 run 可访问）。反向有利的一面：缓存按 ref 字符串作用域，**同 tag 重打（删远端 tag → 重打 → 重推）触发的新 run 能命中上一次 run 建的缓存**——tag 移位修发版缺陷的重跑成本接近零；
- **长编译 job 的「停摆」判定与处置**：编译类 job 随机整机静默停摆是托管 runner 的已知故障模式（如 actions/runner-images#13882：macOS x86_64 runner 的 C++ 编译随机停摆——无报错、无 OOM、日志不再增长），与 workflow 改动无关。**判定不看步总时长（本来就长），看日志增长节奏**：下载 job 日志对比两次的字节数与末行 UTC 时间戳，与同 job 历史日志的健康节奏对照（健康编译相邻输出间隔通常以秒计）；跨多次采样字节完全不动才算实锤——超大编译单元也可能十几分钟不吐日志后自愈。处置：确认冻结 → `POST /actions/runs/{id}/cancel` → 等 completed → `POST /actions/runs/{id}/rerun-failed-jobs` 只重跑失败 job。三个约束：**cancel 是 run 级**（没有单 job 取消），先等健康 job 全部 success 再动手，否则它们也被取消、进 rerun 集合白跑；`timeout` 看门狗对整机停摆无效（timeout 进程随 VM 一起冻死，到点不触发）；**rerun-failed-jobs 沿用旧 commit 的 workflow**——修 workflow 缺陷必须推新提交另起 run（tag 触发的发版 run 走删 tag 重打，配合上一条的缓存复用，重跑成本接近零）。

## 校验和

构建后生成 `SHA256SUMS`（每产物一行），**与产物一并上传**（附件或制品），并在下载说明里写明核对方式。这是「产物被完整下载」的唯一证据。

## 权限与可复现

- `permissions:` 只给需要的：发附件的那个 job 给 `contents: write`，其余 `contents: read`；
- action 与运行时版本**锁定**（tag 或 commit SHA），别用浮动版本——今天的构建与三个月后的构建必须是同一套；
- 构建用的版本号从 tag 注入（`github.ref_name`），产物文件名、产物内版本、tag 三者一致。
