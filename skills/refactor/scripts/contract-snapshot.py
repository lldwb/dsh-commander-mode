#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
契约快照脚本（通用）。
只负责机械抓取源码中的「对外契约痕迹」（公开签名 / 路由与关键注解 / 导出符号）并按文件
比对改造前后的增删，**不做任何判定**——差异是否可接受、是否需要修复，由调用方 agent
依据重构契约（不可变更项清单）判定。

用法:
    # 抓取（改造前 / 改造后各执行一次）
    python contract-snapshot.py capture --root <源码目录或文件> [--lang auto|java|ts|js|py|generic]
                                 [--include <glob>] [--out <快照.json>]

    # 比对
    python contract-snapshot.py diff <改造前快照.json> <改造后快照.json> [--out <差异文本>]

默认:
    --lang auto 按扩展名识别（.java→java；.ts/.tsx→ts；.js/.jsx/.mjs→js；.py→py；其余跳过）
    --include 额外限定文件 glob（如 "**/web/*.java"），可多次传入
    --out 不传时打印到 stdout（capture 建议落盘以便后续 diff）

输出:
    capture → JSON 快照（meta + files：相对路径 → 归一化后的契约行数组，已排序去重）
    diff    → 按「新增文件 / 删除文件 / 变更文件」分组的差异清单 + 汇总统计

说明:
    抓取为**行级粗筛**（正则匹配 + 去注释 + 空白归一化），用于防"路径/签名/注解被悄悄改动"的
    漏检；不覆盖跨行签名改写、语义级变化，这类差异仍需人工/审查子代理核对。
"""
import argparse
import codecs
import datetime
import fnmatch
import json
import os
import re
import sys

LANG_BY_EXT = {
    ".java": "java",
    ".kt": "java",
    ".ts": "ts",
    ".tsx": "ts",
    ".js": "js",
    ".jsx": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".py": "py",
}

# 遍历时跳过的目录（构建产物 / 依赖 / 版本控制）
SKIP_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "target", "build", "dist", "out",
    "__pycache__", ".idea", ".vscode", ".gradle", "venv", ".venv", "coverage",
    ".next", ".nuxt", ".pytest_cache", ".mypy_cache",
}

JAVA_PATTERNS = [
    # 公开/受保护的方法声明
    re.compile(r"^\s*(?:public|protected)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+)*"
               r"[\w<>\[\],.?\s]+\s+\w+\s*\("),
    # 公开类型声明
    re.compile(r"^\s*(?:public|protected)\s+(?:static\s+|final\s+|abstract\s+)*"
               r"(?:class|interface|enum|record)\s+\w+"),
    # 关键注解（路由 / 权限 / 事务 / 组件角色 / 接口文档 / 幂等与防重）
    re.compile(r"^\s*@\s*(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|"
               r"RequiresPermissions|RequiresRoles|PreAuthorize|PostAuthorize|Transactional|"
               r"RestController|Controller|Service|Component|Repository|Mapper|"
               r"Validated|Operation|ApiOperation|Tag|Schema|Token|RepeatSubmit)\b"),
]

TS_PATTERNS = [
    re.compile(r"^\s*export\s+(?:default\s+)?(?:abstract\s+)?"
               r"(?:class|interface|type|enum|const|let|var|function|async\s+function|namespace)\b"),
    re.compile(r"^\s*export\s*\{"),
    re.compile(r"^\s*export\s+default\s+[\w$]+\s*;?\s*$"),
]

PY_PATTERNS = [
    # 顶层函数 / 类（契约面通常为顶层公开对象）
    re.compile(r"^(?:async\s+)?def\s+\w+\s*\("),
    re.compile(r"^class\s+\w+"),
    # 路由与端点装饰器
    re.compile(r"^\s*@\s*(?:app|router|api|bp|blueprint)\s*\.\s*(?:route|get|post|put|delete|patch)\b"),
    re.compile(r"^\s*@\s*(?:route|endpoint)\s*\("),
]

GENERIC_PATTERNS = [
    re.compile(r"^\s*(?:public|protected|export|def|async\s+def|class|interface|type|func|fn)\b"),
    re.compile(r"^\s*@\s*\w*(?:Route|Mapping|Controller|Endpoint|Path|PathVariable)\w*\b", re.IGNORECASE),
]

PATTERNS_BY_LANG = {
    "java": JAVA_PATTERNS,
    "ts": TS_PATTERNS,
    "js": TS_PATTERNS,
    "py": PY_PATTERNS,
    "generic": GENERIC_PATTERNS,
}


# Windows 控制台缺省 GBK，强制 UTF-8 输出中文。
# 提前规避乱码：stdout/stderr 可能被 GBK 控制台消费，或被 AI 以
# UTF-8 捕获（如 --resume 场景）；统一按 UTF-8 输出，两处均不乱码；
# reconfigure 不可用时回退到基于底层 buffer 的 UTF-8 写入器兜底。
def _ensure_utf8():
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
            continue
        except Exception:
            pass
        try:
            buf = getattr(stream, "buffer", None)
            if buf is not None and hasattr(stream, "write"):
                setattr(sys, name, codecs.getwriter("utf-8")(buf, errors="backslashreplace"))
        except Exception:
            pass


_ensure_utf8()


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def strip_comments(line, hash_comment=False):
    """引号感知地去掉行内注释（// 与 /* */；hash_comment 时额外处理 #）。"""
    out = []
    quote = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            out.append(ch)
            if ch == quote and (i == 0 or line[i - 1] != "\\"):
                quote = None
            i += 1
            continue
        if ch in "\"'`":
            quote = ch
            out.append(ch)
            i += 1
            continue
        if quote is None and line.startswith("//", i):
            break
        if quote is None and hash_comment and ch == "#":
            break
        if line.startswith("/*", i):
            end = line.find("*/", i + 2)
            if end == -1:
                break
            i = end + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def normalize_line(line, hash_comment=False):
    """归一化：去注释 → 压缩空白 → 去首尾空白。"""
    return re.sub(r"\s+", " ", strip_comments(line, hash_comment)).strip()


def detect_lang(path, lang):
    if lang != "auto":
        return lang
    return LANG_BY_EXT.get(os.path.splitext(path)[1].lower())


def iter_files(root, include_globs):
    if os.path.isfile(root):
        yield root, os.path.basename(root)
        return
    if not os.path.isdir(root):
        die("路径不存在: %s" % root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if include_globs and not any(
                fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(name, g) for g in include_globs
            ):
                continue
            yield full, rel


def capture_file(path, lang):
    """抓取单个文件的契约痕迹（归一化 + 去重 + 排序）。"""
    patterns = PATTERNS_BY_LANG[lang]
    hash_comment = lang == "py"
    items = set()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = normalize_line(raw, hash_comment)
                if not line:
                    continue
                if any(p.search(line) for p in patterns):
                    items.add(line)
    except OSError as e:
        die("读取失败 %s: %s" % (path, e))
    return sorted(items)


def cmd_capture(args):
    patterns_lang = args.lang
    files = {}
    scanned = 0
    skipped = 0
    for full, rel in iter_files(args.root, args.include or []):
        lang = detect_lang(full, patterns_lang)
        if lang not in PATTERNS_BY_LANG:
            skipped += 1
            continue
        scanned += 1
        items = capture_file(full, lang)
        if items:
            files[rel] = items
    snapshot = {
        "meta": {
            "root": os.path.abspath(args.root),
            "lang": args.lang,
            "include": args.include or [],
            "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "files": len(files),
            "entries": sum(len(v) for v in files.values()),
        },
        "files": files,
    }
    text = json.dumps(snapshot, ensure_ascii=False, indent=2)
    if args.out:
        out_dir = os.path.dirname(os.path.abspath(args.out))
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print("契约快照已落盘: %s" % os.path.abspath(args.out))
    else:
        print(text)
    print("扫描文件 %d 个（跳过不支持的类型 %d 个），命中 %d 个文件 / %d 条契约痕迹。"
          % (scanned, skipped, len(files), snapshot["meta"]["entries"]))


def load_snapshot(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        die("快照读取失败 %s: %s" % (path, e))
    if not isinstance(data, dict) or "files" not in data:
        die("快照格式不正确（缺 files 字段）: %s" % path)
    return data


def cmd_diff(args):
    before = load_snapshot(args.before)
    after = load_snapshot(args.after)
    fb, fa = before.get("files", {}), after.get("files", {})
    before_keys, after_keys = set(fb), set(fa)

    added_files = sorted(after_keys - before_keys)
    removed_files = sorted(before_keys - after_keys)
    changed_files = []
    added_entries = removed_entries = 0

    for rel in sorted(before_keys & after_keys):
        b, a = set(fb[rel]), set(fa[rel])
        removed = sorted(b - a)
        added = sorted(a - b)
        if removed or added:
            changed_files.append((rel, removed, added))
            removed_entries += len(removed)
            added_entries += len(added)

    lines = []
    lines.append("契约快照差异（机械取数，判定归 agent：差异是否可接受以重构契约的不可变更项为准）")
    lines.append("")
    lines.append("改造前: %s（root=%s，%d 文件 / %d 条）"
                 % (args.before, before.get("meta", {}).get("root", "?"),
                    len(fb), sum(len(v) for v in fb.values())))
    lines.append("改造后: %s（root=%s，%d 文件 / %d 条）"
                 % (args.after, after.get("meta", {}).get("root", "?"),
                    len(fa), sum(len(v) for v in fa.values())))
    root_b = before.get("meta", {}).get("root")
    root_a = after.get("meta", {}).get("root")
    if root_b and root_a and os.path.normcase(root_b) != os.path.normcase(root_a):
        lines.append("注意: 两次快照的 root 不同（%s vs %s），逐文件比对可能错位，请确认是否同一范围的快照。"
                     % (root_b, root_a))
    lines.append("")

    def emit(title, rel, marker, items):
        lines.append("[%s] %s" % (title, rel))
        for it in items:
            lines.append("  %s %s" % (marker, it))
        lines.append("")

    for rel in added_files:
        emit("新增文件", rel, "+", fa[rel])
    for rel in removed_files:
        emit("删除文件", rel, "-", fb[rel])
    for rel, removed, added in changed_files:
        lines.append("[变更文件] %s" % rel)
        for it in removed:
            lines.append("  - %s" % it)
        for it in added:
            lines.append("  + %s" % it)
        lines.append("")

    if not (added_files or removed_files or changed_files):
        lines.append("无差异：两次快照的契约痕迹完全一致。")
        lines.append("")

    lines.append("汇总: 新增文件 %d / 删除文件 %d / 变更文件 %d；条目 +%d / -%d"
                 % (len(added_files), len(removed_files), len(changed_files),
                    added_entries, removed_entries))
    lines.append("提示: 新增/删除的产物文件与条目若属契约声明的预期变化（如新层产物）即为正常；"
                 "入口对象的路径、签名、注解等条目出现差异时，对照契约的「不可变更项」逐条判定。")

    text = "\n".join(lines)
    if args.out:
        out_dir = os.path.dirname(os.path.abspath(args.out))
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print("差异清单已落盘: %s" % os.path.abspath(args.out))
    else:
        print(text)


def main():
    parser = argparse.ArgumentParser(
        prog="contract-snapshot.py",
        description="契约快照：机械抓取源码中的对外契约痕迹并比对改造前后差异（只取数，判定归 agent）。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_cap = sub.add_parser("capture", help="抓取契约痕迹，落 JSON 快照")
    p_cap.add_argument("--root", required=True, help="源码目录或单个文件")
    p_cap.add_argument("--lang", default="auto",
                       choices=["auto", "java", "ts", "js", "py", "generic"],
                       help="语言规则；auto 按扩展名识别（默认）")
    p_cap.add_argument("--include", action="append", default=[],
                       help="额外的文件 glob 过滤（相对 root 或文件名），可多次传入")
    p_cap.add_argument("--out", default=None, help="快照输出文件（不传则打印到 stdout）")
    p_cap.set_defaults(func=cmd_capture)

    p_dif = sub.add_parser("diff", help="比对两份快照，输出差异清单")
    p_dif.add_argument("before", help="改造前快照 JSON")
    p_dif.add_argument("after", help="改造后快照 JSON")
    p_dif.add_argument("--out", default=None, help="差异文本输出文件（不传则打印到 stdout）")
    p_dif.set_defaults(func=cmd_diff)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
