#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
评审取数脚本（通用）。
只负责按修订号或分支区间拉取提交/差异信息并落盘，不做问题判定（判定由调用方 agent 完成）。

用法:
    python review-fetch.py <修订号> [--max-diff-lines 500] [--out-dir .tasks/review-fetch]
    python review-fetch.py --range <base>...<head> [--max-diff-lines 500] [--out-dir .tasks/review-fetch]

输出:
    修订号模式: <sha>.summary.txt + <sha>.raw.diff
    区间模式:   <base>...<head>.summary.txt + <base>...<head>.raw.diff（文件名中的路径字符清洗为 _）
stdout: 取数概要 + 输出路径
"""
import sys
import os
import argparse
import subprocess
import codecs

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TASKS_DIR = os.path.join(SCRIPT_DIR, "..", ".tasks", "review-fetch")

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

GIT = ["git", "-c", "core.quotepath=false"]


def die(msg, code=1):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def git(*args):
    """执行 git 并返回 stdout，失败即退出。"""
    r = subprocess.run(GIT + list(args), capture_output=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        die("git %s 失败: %s" % (" ".join(args), r.stderr.strip()[:500]))
    return r.stdout


def git_ok(*args):
    """执行 git 不抛错，返回 (ok, stdout, stderr)。"""
    r = subprocess.run(GIT + list(args), capture_output=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0, r.stdout, r.stderr


def sanitize_name(ref):
    """把 ref 名清洗成安全文件名片段（路径分隔与保留字符替换为 _）。"""
    name = ref.strip()
    for ch in '/\\:*?"<>| \t':
        name = name.replace(ch, "_")
    while ".." in name:
        name = name.replace("..", "_")
    return name or "ref"


def append_diff_block(lines, diff_text, max_diff_lines, raw_path):
    """把 diff（含截断告警）追加进 summary 行列表，返回 (行数, 是否截断)。"""
    n_diff = diff_text.count("\n")
    truncated = n_diff > max_diff_lines
    lines.append("=== diff (%d 行%s) ===" % (
        n_diff, "，前 %d 行，完整见 raw.diff" % max_diff_lines if truncated else ""))
    if truncated:
        lines.append("\n".join(diff_text.split("\n")[:max_diff_lines]))
        lines.append("")
        lines.append("... (已截断 %d 行，完整内容见 %s)" % (n_diff - max_diff_lines, raw_path))
    else:
        lines.append(diff_text)
    return n_diff, truncated


def write_outputs(out_dir, sha, subject, author, date, parents,
                  files, shortstat, file_list, diff_text, max_diff_lines):
    os.makedirs(out_dir, exist_ok=True)
    sum_path = os.path.join(out_dir, sha + ".summary.txt")
    raw_path = os.path.join(out_dir, sha + ".raw.diff")

    lines = []
    lines.append("sha=%s  subject=%s" % (sha, subject))
    lines.append("author=%s" % author)
    lines.append("date=%s" % date)
    lines.append("parents=%d (%s)" % (len(parents), " ".join(parents) or "-"))
    lines.append("files=%s  %s" % (files, shortstat or "(无增删)"))
    if not diff_text:
        lines.append("提示: 该提交无 diff（空提交或仅合并，见 raw.diff）。")
    lines.append("")
    lines.append("=== 提交信息 ===")
    body = git("show", "-s", "--format=%B", sha).strip()
    lines.append(body)
    lines.append("")
    lines.append("=== 文件清单 (状态 路径) ===")
    lines.extend(file_list)
    lines.append("")
    n_diff, truncated = append_diff_block(lines, diff_text, max_diff_lines, raw_path)

    with open(sum_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(raw_path, "w", encoding="utf-8") as f:
        f.write(diff_text)
    return sum_path, raw_path, truncated, n_diff


def write_range_outputs(out_dir, base, head, merge_base, commit_lines,
                        shortstat, file_list, diff_text, max_diff_lines):
    os.makedirs(out_dir, exist_ok=True)
    label = "%s...%s" % (sanitize_name(base), sanitize_name(head))
    sum_path = os.path.join(out_dir, label + ".summary.txt")
    raw_path = os.path.join(out_dir, label + ".raw.diff")

    lines = []
    lines.append("range=%s...%s  merge-base=%s" % (base, head, merge_base))
    lines.append("commits=%d  files=%d  %s" % (len(commit_lines), len(file_list),
                                               shortstat or "(无增删)"))
    if not commit_lines and not diff_text:
        lines.append("提示: 区间无差异提交（源分支可能已合入目标分支，或 base 选取有误）。")
    elif not diff_text:
        lines.append("提示: 区间有提交但最终 diff 为空（改动互相抵消，按提交序列核对）。")
    lines.append("")
    lines.append("=== 提交序列 (base..head，不含 base 侧提交) ===")
    lines.extend(commit_lines if commit_lines else ["(无提交)"])
    lines.append("")
    lines.append("=== 文件清单 (状态 路径) ===")
    lines.extend(file_list if file_list else ["(无文件变更)"])
    lines.append("")
    n_diff, truncated = append_diff_block(lines, diff_text, max_diff_lines, raw_path)

    with open(sum_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(raw_path, "w", encoding="utf-8") as f:
        f.write(diff_text)
    return sum_path, raw_path, truncated, n_diff


def run_revision(revision, max_diff_lines, out_dir):
    ok, meta, err = git_ok("show", "-s", "--format=%H%x09%an%x09%aI%x09%P", revision)
    if not ok:
        die("修订号无效: %s\n%s" % (revision, err.strip()[:500]))
    sha, author, date, parents_str = meta.strip().split("\t")
    parents = [p for p in parents_str.split() if p]

    subject = git("show", "-s", "--format=%s", sha).strip()

    # merge 提交按第一父级展示改动（聚焦主分支合入内容）；非 merge 即普通 patch
    shortstat = git("show", "--first-parent", "--shortstat", "--format=", sha).strip()
    ns = git("show", "--first-parent", "--name-status", "--format=", sha)
    file_list = [ln.strip() for ln in ns.split("\n") if ln.strip()]
    files = len(file_list)

    diff_text = git("show", "--first-parent", "--format=", sha).strip()

    out_dir = os.path.abspath(out_dir)
    sum_path, raw_path, truncated, n_diff = write_outputs(
        out_dir, sha, subject, author, date, parents,
        files, shortstat, file_list, diff_text, max_diff_lines)

    print("OK  sha=%s" % sha)
    print("    subject: %s" % subject)
    print("    作者/时间: %s / %s" % (author, date))
    print("    文件: %d  %s" % (files, shortstat or "(无增删)"))
    print("    diff: %d 行%s" % (n_diff, "（summary 已截断，完整见 raw）" if truncated else ""))
    print("    summary:%s" % sum_path)
    print("    raw:    %s" % raw_path)


def run_range(range_spec, max_diff_lines, out_dir):
    if "..." not in range_spec:
        die("区间格式须为 <base>...<head>（三点，merge-base 语义）；"
            "两点 <base>..<head> 会把目标分支改动计入差异，不支持——请改用三点。")
    base, head = range_spec.split("...", 1)

    for ref in (base, head):
        ok, _, err = git_ok("rev-parse", "--verify", ref + "^{commit}")
        if not ok:
            die("引用无效: %s\n%s" % (ref, err.strip()[:500]))

    ok, merge_base, err = git_ok("merge-base", base, head)
    if not ok:
        die("无法求 merge-base（base 与 head 可能无共同祖先）: %s\n%s"
            % (range_spec, err.strip()[:500]))
    merge_base = merge_base.strip()

    log_text = git("log", "--oneline", "--no-decorate", "%s..%s" % (base, head))
    commit_lines = [ln.strip() for ln in log_text.split("\n") if ln.strip()]

    shortstat = git("diff", "--shortstat", "%s...%s" % (base, head)).strip()
    ns = git("diff", "--name-status", "%s...%s" % (base, head))
    file_list = [ln.strip() for ln in ns.split("\n") if ln.strip()]

    diff_text = git("diff", "%s...%s" % (base, head)).strip()

    out_dir = os.path.abspath(out_dir)
    sum_path, raw_path, truncated, n_diff = write_range_outputs(
        out_dir, base, head, merge_base, commit_lines,
        shortstat, file_list, diff_text, max_diff_lines)

    print("OK  range=%s...%s  merge-base=%s" % (base, head, merge_base))
    print("    提交数: %d" % len(commit_lines))
    print("    文件: %d  %s" % (len(file_list), shortstat or "(无增删)"))
    print("    diff: %d 行%s" % (n_diff, "（summary 已截断，完整见 raw）" if truncated else ""))
    print("    summary:%s" % sum_path)
    print("    raw:    %s" % raw_path)


def main():
    ap = argparse.ArgumentParser(
        description="评审取数：按修订号或分支区间拉取提交/差异信息并落盘（不做判定）")
    ap.add_argument("revision", nargs="?", default=None,
                    help="提交修订号（完整/短 sha、分支名、tag 等，与 git show 一致）；与 --range 二选一")
    ap.add_argument("--range", dest="range_spec", default=None, metavar="<base>...<head>",
                    help="分支区间取数（三点，merge-base 语义）；与位置参数修订号互斥")
    ap.add_argument("--max-diff-lines", type=int, default=500,
                    help="summary 中 diff 显示行数上限，默认 500；实际行数超出时截断并告警（raw.diff 始终完整）")
    ap.add_argument("--out-dir", default=DEFAULT_TASKS_DIR)
    args = ap.parse_args()

    if args.range_spec and args.revision:
        die("--range 与位置参数修订号互斥，二选一。")
    if args.range_spec:
        run_range(args.range_spec, args.max_diff_lines, args.out_dir)
    elif args.revision:
        run_revision(args.revision, args.max_diff_lines, args.out_dir)
    else:
        die("请提供修订号，或用 --range <base>...<head> 指定区间。")


if __name__ == "__main__":
    main()
