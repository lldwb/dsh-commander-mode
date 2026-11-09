#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
会话记录抽取（脚本只取数，判定归 agent）。

把 Claude Code 的会话记录（`~/.claude/projects/<项目路径转义>/<会话 id>.jsonl`，单文件
可达十几 MB）抽成可读、可控体量的文本，供「会话总结」等场景取证——**别整份读 transcript**
（会撑爆上下文），先落盘抽取再按需读。

四种模式（缺省 `--user`）：
  --user              用户消息全文 —— 总结的取证主体（含时间戳，默认不截断）
  --assistant <N>     尾部 N 条 assistant 文本消息 —— 会话最后停在哪、留下了什么结论
  --timeline          逐条时间线：用户 / assistant 文本 / 工具调用（参数压成一行）
  --transcript        紧凑全文转录（含 thinking 与 tool_result 摘要，供逐段精读）

会话文件定位：① 直接给文件路径；② 给会话 id（可配 `--project <项目路径>`，缺省当前目录），
按 Claude Code 的项目目录转义规则（路径中的非字母数字字符转 `-`）定位到 `~/.claude/projects/`。

用法:
    python extract-session.py <会话id> [--project <项目路径>] [模式] [--out <文件>]
    python extract-session.py <会话文件.jsonl> --user --stdout
退出码: 0 = 抽取成功；1 = 会话文件不可定位或无可抽取内容
"""
import sys
import os
import re
import json
import codecs
import argparse


# Windows 控制台缺省 GBK，强制 UTF-8 输出（同仓库其他脚本的处理）。
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

# transcript 模式的三个截断档位（文本 / 工具结果 / 工具入参）。
TEXT_LIMIT, RESULT_LIMIT, TOOL_ECHO_LIMIT = 4000, 1500, 400
# 工具调入参里最能说明"在动什么"的那个键。
TOOL_KEY = {
    "Bash": "command", "Read": "file_path", "Write": "file_path", "Edit": "file_path",
    "Glob": "pattern", "Grep": "pattern", "Skill": "skill", "Task": "description",
    "Agent": "description", "WebFetch": "url", "WebSearch": "query",
    "NotebookEdit": "notebook_path",
}


def clip(text, limit):
    """截断长文本并标注原长；limit <= 0 表示不截断。"""
    text = (text or "").replace("\r", "").strip()
    if limit and len(text) > limit:
        return "%s ...[共 %d 字]" % (text[:limit], len(text))
    return text


def brief(value, limit):
    """把工具入参压成一行。"""
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    s = (s or "").replace("\r", "").replace("\n", " ")
    return s if len(s) <= limit else s[:limit] + "..."


def iter_records(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def user_texts(rec):
    """用户消息的文本块；工具结果回传与 meta 记录不算用户输入。"""
    if rec.get("isMeta"):
        return []
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content):
            return []
        return [x.get("text", "") for x in content
                if isinstance(x, dict) and x.get("type") == "text"]
    return []


def assistant_texts(rec):
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [b["text"] for b in content
            if isinstance(b, dict) and b.get("type") == "text" and (b.get("text") or "").strip()]


def tool_brief(name, inp):
    """工具调用压成一行：能指认对象即可，不复制参数全文。"""
    if not isinstance(inp, dict):
        return ""
    value = inp.get(TOOL_KEY.get(name, ""), "")
    if name in ("Edit", "Write") and isinstance(value, str):
        value = os.path.basename(value)
    detail = brief(value, 220)
    if name == "TodoWrite":
        todos = inp.get("todos") or []
        return "[%d 项] %s" % (len(todos), " | ".join(t.get("content", "")[:40] for t in todos[:8]))
    if name in ("mcp__Chrome_DevTools__navigate_page", "mcp__Chrome_DevTools__new_page"):
        detail = (detail + " " + str(inp.get("url", ""))[:120]).strip()
    return detail


# 上下文压缩摘要（harness 在上下文耗尽时以用户消息形式注入的续接说明）不是用户输入，
# 长会话里它动辄占一半以上行数，且内容与 assistant 尾部文本高度重复。
SUMMARY_PREFIXES = ("This session is being continued", "This session is being resumed")


def is_compression_summary(text):
    return text.startswith(SUMMARY_PREFIXES)


def command_args(text):
    """技能命令包装的消息里取 <command-args> 的用户参数；找不到返回空串。

    技能启动的会话其用户输入是 harness 以
    `<command-message>…<command-name>…<command-args>…</command-args>` 包装的，
    参数才是用户原话，包装本身是注入、与时间线冗余。
    """
    start = text.find("<command-args>")
    if start == -1:
        return ""
    start += len("<command-args>")
    end = text.find("</command-args>", start)
    if end == -1:
        return ""
    return text[start:end].strip()


def clean_user_text(t, with_summary=False):
    """一条用户文本是否算用户输入的统一判定，各模式共用：

    去空白、过滤 Caveat 提示与 task-notification 系统通知（后台任务跨会话
    残留注入 user turn，非用户直发——实测 40 条里 19 条，不过滤统计近半失真）；
    斜杠命令包装（`<command-message>…` 开头）解包出 `<command-args>` 的用户
    参数，无参数则整条丢弃；上下文压缩摘要默认过滤（`with_summary` 时原样
    返回）。返回 None 表示该条不算用户输入。
    """
    t = (t or "").strip()
    if not t or t.startswith(("Caveat:", "<task-notification>")):
        return None
    if t.startswith(("<command-message>", "<command-name>")):
        t = command_args(t)
        if not t:
            return None
    if is_compression_summary(t):
        return t if with_summary else None
    return t


def mode_user(path, limit, with_summary=False):
    out, n, skipped = [], 0, 0
    for rec in iter_records(path):
        if rec.get("type") != "user":
            continue
        for t in user_texts(rec):
            if not with_summary and is_compression_summary((t or "").strip()):
                # 默认过滤的摘要也要计入 skipped，否则「已过滤 N 条」提示
                # 对其服务的默认模式永远是 0（clean_user_text 返回 None 后
                # 直接 continue，计数发生在不了那条路径上）。
                skipped += 1
                continue
            t = clean_user_text(t, with_summary)
            if t is None:
                continue
            if is_compression_summary(t):
                skipped += 1
            else:
                n += 1
            out.append("### %s\n%s\n" % (rec.get("timestamp", ""), clip(t, limit)))
    if skipped:
        note = ("（已过滤 %d 条上下文压缩摘要，--with-summary 保留）" % skipped
                if not with_summary else "（含 %d 条上下文压缩摘要）" % skipped)
    else:
        note = ""
    return out, "%d 条用户消息%s" % (n, note)


def mode_assistant(path, limit, tail):
    texts = []
    for rec in iter_records(path):
        if rec.get("type") != "assistant":
            continue
        for t in assistant_texts(rec):
            texts.append((rec.get("timestamp", ""), t))
    picked = texts[-tail:] if tail > 0 else texts
    out = ["assistant 文本消息共 %d 条，取尾部 %d 条\n" % (len(texts), len(picked))]
    for ts, t in picked:
        out.append("### %s\n%s\n" % (ts, clip(t, limit)))
    return out, "assistant 文本 %d 条（尾部 %d 条）" % (len(texts), len(picked))


def mode_timeline(path, limit):
    out = ["（时间戳取自会话记录的 UTC 时刻，非本地时间）"]
    n_user, n_ai, n_tool = 0, 0, 0
    for rec in iter_records(path):
        kind = rec.get("type")
        ts = (rec.get("timestamp") or "")[5:19].replace("T", " ")
        if kind == "user":
            for t in user_texts(rec):
                t = clean_user_text(t)
                if t is None:
                    continue
                n_user += 1
                out.append("\n@@@@ [USER %s] %s" % (ts, clip(t, limit)))
        elif kind == "assistant":
            for c in (rec.get("message") or {}).get("content") or []:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text":
                    text = (c.get("text") or "").strip()
                    if not text:
                        continue
                    n_ai += 1
                    out.append("  AI[%s]: %s" % (ts, clip(text, limit)))
                elif c.get("type") == "tool_use":
                    n_tool += 1
                    out.append("  >>%s[%s] %s" % (c.get("name", ""), ts,
                                                  tool_brief(c.get("name", ""), c.get("input") or {})))
    return out, "用户 %d 条 / assistant 文本 %d 条 / 工具调用 %d 次" % (n_user, n_ai, n_tool)


def mode_transcript(path, limit):
    out = ["（时间戳取自会话记录的 UTC 时刻，非本地时间）"]
    n_tool, n = 0, 0
    for rec in iter_records(path):
        kind = rec.get("type")
        if kind == "summary":
            out.append("\n## [SUMMARY] %s\n" % brief(rec.get("summary", ""), 800))
            continue
        if kind in ("queue-operation", "system"):
            continue
        n += 1
        ts = (rec.get("timestamp") or "")[5:19].replace("T", " ")
        head = "\n### #%d [%s] %s%s" % (n, ts, (rec.get("message") or {}).get("role", kind),
                                       " <SIDECHAIN>" if rec.get("isSidechain") else "")
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, str):
            out.append(head + "\n" + brief(content, TEXT_LIMIT))
            continue
        if not isinstance(content, list):
            continue
        parts = []
        for c in content:
            if not isinstance(c, dict):
                continue
            ctype = c.get("type")
            if ctype == "text":
                parts.append("[TEXT] " + brief(c.get("text", ""), TEXT_LIMIT))
            elif ctype == "thinking":
                parts.append("[THINK] " + brief(c.get("thinking", ""), 1200))
            elif ctype == "tool_use":
                n_tool += 1
                parts.append("[TOOL_USE #%d] %s :: %s" % (n_tool, c.get("name"),
                                                          brief(c.get("input", {}), TOOL_ECHO_LIMIT)))
            elif ctype == "tool_result":
                cont = c.get("content")
                if isinstance(cont, list):
                    cont = " ".join(x.get("text", "") for x in cont if isinstance(x, dict))
                parts.append("[TOOL_RESULT] " + brief(cont, RESULT_LIMIT))
            elif ctype == "image":
                parts.append("[IMAGE]")
            else:
                parts.append("[%s]" % ctype)
        out.append(head + "\n" + "\n".join(parts))
    return out, "记录 %d 条 / 工具调用 %d 次" % (n, n_tool)


def locate(session, project):
    """会话文件定位：直接是文件就用它；否则按项目路径转义规则找 projects 目录。"""
    if os.path.isfile(session):
        return session
    escaped = re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(project or os.getcwd()))
    candidate = os.path.join(os.path.expanduser("~"), ".claude", "projects", escaped,
                             session + ".jsonl")
    return candidate if os.path.isfile(candidate) else None


def main():
    ap = argparse.ArgumentParser(description="抽取 Claude Code 会话记录（只取数，不判定）")
    ap.add_argument("session", help="会话 id 或 .jsonl 文件路径")
    ap.add_argument("--project", help="会话所属项目路径（给会话 id 时用于定位，缺省当前目录）")
    ap.add_argument("--user", action="store_true", help="用户消息全文（缺省模式，上下文压缩摘要默认过滤）")
    ap.add_argument("--with-summary", action="store_true",
                    help="用户模式保留上下文压缩摘要（缺省过滤）")
    ap.add_argument("--assistant", nargs="?", type=int, const=4, metavar="N",
                    help="尾部 N 条 assistant 文本消息（缺省 4 条；N<=0 表示全部）")
    ap.add_argument("--timeline", action="store_true", help="逐条时间线（含工具调用摘要）")
    ap.add_argument("--transcript", action="store_true", help="紧凑全文转录")
    ap.add_argument("--limit", type=int, default=None,
                    help="单条消息截断字数（0 = 不截断；缺省 user 不截断、assistant 2500、timeline 900）")
    ap.add_argument("--out", help="落盘文件（显式指定才写盘；未指定时直接打印）")
    ap.add_argument("--stdout", action="store_true", help="直接打印，不落盘（与缺省行为一致，兼容保留）")
    args = ap.parse_args()

    chosen = []
    if args.transcript:
        chosen.append("transcript")
    if args.timeline:
        chosen.append("timeline")
    if args.assistant is not None:
        chosen.append("assistant")
    if args.user:
        chosen.append("user")
    if len(chosen) > 1:
        print("阻塞: 一次只能指定一种模式（%s）" % " / ".join(chosen))
        return 1
    mode = chosen[0] if chosen else "user"

    path = locate(args.session, args.project)
    if not path:
        print("阻塞: 找不到会话文件 %s —— 给 .jsonl 路径，或用 --project <项目路径> 指定会话所属项目"
              % args.session)
        return 1

    defaults = {"user": 0, "assistant": 2500, "timeline": 900, "transcript": 0}
    limit = defaults[mode] if args.limit is None else args.limit
    if mode == "user":
        lines, summary = mode_user(path, limit, args.with_summary)
    elif mode == "assistant":
        lines, summary = mode_assistant(path, limit, args.assistant)
    elif mode == "timeline":
        lines, summary = mode_timeline(path, limit)
    else:
        lines, summary = mode_transcript(path, limit)

    body = "\n".join(lines)
    if not body.strip():
        print("阻塞: %s 里没有可抽取的 %s 内容" % (os.path.basename(path), mode))
        return 1

    if args.stdout or not args.out:
        # 缺省直接打印：复核/审查类只读用途不该在调用方不知情时写文件，
        # 落盘必须显式 --out。
        print(body)
        print("\n[%s] %s" % (mode, summary))
        return 0

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    print("落盘: %s" % out)
    print("[%s] %s / 输出 %d 字" % (mode, summary, len(body)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
