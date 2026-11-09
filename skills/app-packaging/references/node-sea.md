# Node 单文件可执行（SEA）实操

把 Node 应用打成**目标机无需安装 Node** 的单个可执行文件。命令细节以官方文档为准（`nodejs.org` → Single executable applications），本文件给流程、判据与坑。

## 前提：入口先打成单文件 JS

SEA 注入的主脚本**不能从文件系统加载模块**（只认内置模块）——动手前先用打包器（esbuild / rollup / ncc 等）把应用与依赖打成**单个 `.js`**。顺带的好处是依赖图确定，不会出现「构建机能跑、目标机缺包」。

原生模块（`.node`）不能直接内联，见下方「资源与原生模块」。

## 两条路径

| 路径 | 最低版本 | 何时用 |
|---|---|---|
| `node --build-sea <配置文件>` | Node **≥ 25.5.0** | **首选**：一条命令生成可执行文件，无需注入工具 |
| `--experimental-sea-config` 出 blob + `postject` 注入 | Node ≥ 19.7 / 18.16 | Node 版本较低，或需自己控制注入步骤（如注入后还要改资源） |

两条路径**用同一份配置格式**，区别只在 `output` 的含义：`--build-sea` 写最终可执行文件，`--experimental-sea-config` 写 blob 文件。

### 路径 A：一步生成（推荐）

```bash
node --build-sea sea-config.json     # 模板见 assets/sea-config.json
```

配置字段（按需取用，模板已含常用项）：

| 字段 | 说明 |
|---|---|
| `main` | **已打包**的单文件 JS 入口 |
| `mainFormat` | `commonjs`（默认）/ `module` |
| `executable` | 用作底座的 node 二进制；**省略则用当前 node**——交叉构建就靠它 |
| `output` | 产物路径；**Windows 下必须带 `.exe` 后缀** |
| `useCodeCache` / `useSnapshot` | 启动优化；**跨平台构建时必须为 false**（见下） |
| `assets` | 需内嵌的资源文件字典（键 → 构建机上的路径） |
| `disableExperimentalSEAWarning` | 关掉启动时的实验特性警告 |

模板 `assets/sea-config.json` 只含**恒成立**的字段：`useCodeCache` / `useSnapshot` 未预置（即取默认 false，跨平台构建必须保持 false，同平台构建可开以优化启动）；**交叉构建时另加 `executable`** 指向目标平台的 node 二进制。

### 路径 B：blob + postject 注入

```bash
# 1) 生成 blob（配置里 output 指向 .blob 文件）
node --experimental-sea-config sea-config.json

# 2) 复制一份 node 二进制作为底座
cp "$(command -v node)" <产物名>                      # macOS / Linux
node -e "require('fs').copyFileSync(process.execPath, '<产物名>.exe')"   # Windows（.exe 必须有）

# 3) 移除原有签名（macOS 必做；Windows 可跳过）
codesign --remove-signature <产物名>                   # macOS
signtool remove /s <产物名>.exe                        # Windows（需 Windows SDK；跳过时忽略 postject 的签名告警）

# 4) 注入 blob
npx postject <产物名> NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2        # Linux
npx postject <产物名> NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA                                          # macOS 多这一个参数
npx postject <产物名>.exe NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2         # Windows

# 5) 重新签名（注入破坏了原签名）
codesign --sign - <产物名>                              # macOS：ad-hoc 签名，不签会无法运行
signtool sign /fd SHA256 <产物名>.exe                   # Windows：可选，未签名仍可运行
```

## 平台支持与交叉构建

**官方常态测试的平台**：Windows；**macOS 仅 arm64**（x64 未支持）；Linux（除 Alpine、除 s390x）。目标平台不在此列时先小样验证，别直接排产。macOS x64 除不获官方测试外，**自编译基底**注入后还会撞 dyld 坏档（见下方已知坑第一条），基底选择与链接器旗标按那条处理。

**交叉构建可以做**，靠配置里的 `executable` 指向**目标平台的 node 二进制**：

```
同平台同架构      → 直接生成
换平台 / 换架构   → 下载目标平台的 node 二进制，作为 executable 传入
```

**硬约束**：跨平台生成时 `useCodeCache` 与 `useSnapshot` **必须为 false**——代码缓存与快照只能在与编译相同的平台上加载，跨平台产物会在启动时崩溃。另外**生成 blob 的 node 版本必须与底座二进制版本一致**（换平台时下载对应版本的 node）。

**自编译基底（如换 small-icu，见 runtime-trimming.md）在 arm64 机器上交叉编译 x64 时，编译器必须钉死目标架构**：`CC="clang -arch x86_64"`、`CXX="clang++ -arch x86_64"`——node 的 make 构建在 mac 上从不主动传 `-arch`，原生构建靠「编译器默认 = host 架构」侥幸成立，交叉时缺了它编译器按 host 的 arm64 出码，产出 arm64 码冒名 x64 的废品；而自检跑在 arm64 机器上、arm64 码原生可跑，**自检拦不住它**（实测 `deps/zlib/cpu_features.c` 的 cpuid.h `#error` 是罕见的最后防线）。配套两个硬点：OpenSSL 交叉编译加 `--openssl-no-asm`（x86_64 汇编的内联寄存器约束在 arm64 host 上不合法）；产物名按**基底**架构取名，别用构建机的 `process.arch`（交叉时会错标）。

## 签名（顺序不可颠倒）

| 平台 | 注入前 | 注入后 |
|---|---|---|
| macOS | `codesign --remove-signature`（必做） | `codesign --sign -`（**必做**，否则无法运行） |
| Windows | `signtool remove /s`（可跳过） | `signtool sign /fd SHA256`（可选，未签名仍可运行） |
| Linux | — | 无需签名 |

要正式分发（有开发者证书）时，把 ad-hoc 签名换成正式签名；**任何对二进制的后续改动都会让签名失效**——改图标、改资源都要在签名之前做完。

## 注入脚本里的路径语义

主脚本运行在可执行文件里，**不读源码目录**：

- `__filename` = `process.execPath`（产物自身路径）；
- `__dirname` = 产物**所在目录**；

要读「和产物放在一起的配置文件 / 资源」，用 `__dirname` 拼，别用源码里的相对路径。

## 资源与原生模块

- **资源内嵌**：配置 `assets` 字段把文件打进产物，运行时用 `node:sea` 的 `getAsset` / `getAssetAsBlob` / `getRawAsset` / `getAssetKeys` 取（`getRawAsset` 不复制、更快，但**不要写回它返回的 buffer**）；
- **原生模块**：不能从产物内部直接 `dlopen`——先写到临时文件再 `process.dlopen()`；
- **组合限制**（记牢，否则产物不可用）：`useSnapshot` 与 `useCodeCache` **不能与 `mainFormat: module` 或 VFS 模式同用**；`useCodeCache: true` 时 `import()` 不可用。

## 已知坑

- **linux arm64 容器里注入会产出坏 ELF**：postject 在 linux arm64 的 docker 容器内运行，产物的哈希表不正确，加载原生模块时崩溃（nodejs/postject #105）——换非容器的 linux arm64 环境或换平台构建；
- **macOS x64 注入后 dyld 报 `unsupported thread-local, larger than 4GB`（自编译基底实测）**：上游已知坏档（nodejs/node#59553，官方对 Intel macOS 的 SEA 选择文档化为不支持而不修）——Xcode 15+ 新式链接器产出的 x64 二进制经 postject 注入后损坏，同一环境官方 node 基底（老链接器产物）注入无恙；该 dyld 报错在 Rosetta 下同样复现，CI 上跑 x64 产物自检能可靠拦住它。绕法：自编译 x64 基底时走经典链接器（macOS 上给 make 透传 `LDFLAGS=-Wl,-ld_classic`，node 的 gyp 链接命令会消费该环境变量），或直接换官方 x64 node 当基底；
- **postject 的哨兵串必须带状态位**：`--sentinel-fuse` 埋进二进制的串本体后必须紧跟 `:` 与初始状态位（官方格式 `NODE_SEA_FUSE_…:0`，注入时 postject 把 `0` 置 `1`）——只埋本体、后跟 NUL 时注入报「fuse must be ':'」；其报错构造路径还对 Buffer 里的数字调 `charCodeAt` 二次崩溃，把真实原因掩盖成 `buffer[colonIndex].charCodeAt is not a function`（表象像「一解析 x64 Mach-O 就崩」，读 postject 源码的冒号校验段可确认）。写注入自检 / hello-world 验证时按官方三段格式埋串，见到 charCodeAt 报错先查哨兵串格式；
- **Windows 产物名必须带 `.exe`**（配置的 `output` 与复制出的底座文件名都一样）；
- **忘了重新签名**：macOS 上表现为产物直接无法运行，Windows 上只是持续的安全告警；
- **把源码入口当 `main`**：直接注入未打包的多文件入口，运行时报「找不到模块」——入口必须先打包成单文件。

## 验证清单

1. `./<产物> --version` → 与 git tag 一致（版本号建议在打包时注入，见技能正文「要求 6」）；
2. 冒烟命令退出码为 0；
3. **在没装 Node 的机器 / 干净容器里跑**（构建机上能跑不算）；
4. 目录 / 压缩包形态分发时，确认解压后**可执行位还在**（见 `ci-distribution.md` 的权限坑）。
