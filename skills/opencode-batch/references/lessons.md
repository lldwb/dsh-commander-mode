# 经验教训速查（对照排查）

> **示例经验**：以下条目来自一类 Java + Spring Boot + 多模块 Maven 项目的真实踩坑归纳，用于对照排查同类问题；**按项目实际技术栈替换**，不要照搬到无关技术栈的项目。

## 批次中断类

- **测试凭据密文**：测试环境的中间件 / 数据库密码为密文且本地无解密 key → 上下文加载失败 → 所有 `@SpringBootTest` 全挂（现象是"测试全挂"，根因在凭据）。阶段 0 检查 → 改明文后再跑。
- **命令定义缺容错条款**：`.opencode/commands/<命令>.md` 未写清测试命令与失败分类时，opencode 会自行拼命令、遇到失败即停下等待输入 → 非交互场景下 EOF 退出 → 重启循环。派发前补齐三要素（测试命令 / 失败分类与容错条款 / 阶段门禁）。
- **挂起识别**：主进程存活但日志 mtime 停滞、无新工具调用 → 判为挂起；终止时按命令行含 worktree 路径定位 PID，不按进程名批量杀。

## 构建与测试类

- **多模块 Maven `-Dtest`**：命令不带 `-pl` 时，其余模块没有匹配的测试类 → surefire 的 `failIfNoSpecifiedTests` 生效 → BUILD FAILURE。用 `mvn test -pl <模块> -am -Dtest=<模式> -DfailIfNoTests=false`；必要时在父 pom 的 surefire 配置里补 `failIfNoSpecifiedTests=false` + `failIfNoTests=false` 兜底。
- **MockMvc 中文乱码**：测试基类的 mockMvc 需显式设置响应默认字符编码（UTF-8），否则断言中文失败。
- **Mockito 陷阱**：`UnfinishedStubbing` —— 把 `R.ok(...)` 之类构造结果预计算到局部变量再传入；`mockStatic` 后静态工具类返回 null —— 加 `CALLS_REAL_METHODS` 或改为注入真实 DAO。
- **测试用户上下文缺字段**：mock 用户的组织 / 租户等字段缺失会导致数据权限或组织校验失败；补齐 mock 用户字段，并保证测试数据的外键（如归属组织）与 mock 用户一致。
- **数据库非空约束**：测试插入漏掉非空列 → 插入失败；按表结构补全必填列。
- **架构约束测试既有失败**：如 ArchUnit「某类应存在」的规则在没有对应类的项目中恒失败——确认非本次引入后**标注不阻断**，并记入失败集合基线。

## 数据权限类

- **数据权限拦截**：测试构造的假 ID 不在当前用户权限范围 → 被拦截。处置：用真实的组织 / 归属数据 + mock 用户组织为其祖先，或按容错条款记录后放行（不纳入失败集合）。

## Git 操作类

- **查分支内文件用 `git cat-file` / `git ls-tree`，勿用 `git show`**：Git Bash（MSYS）会对 `<分支>:<点开头的路径>` 做路径转换，误报"文件不存在 / 为空"。
- **多 worktree 并行合并冲突**：合并前用 `git rev-parse <分支>:<文件>` 对比 blob hash 判断是否真的分叉；冲突取并集并用 `git diff` 复核完整性。
