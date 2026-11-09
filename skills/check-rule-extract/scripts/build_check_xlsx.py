#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
业务管控逻辑 xlsx 合并生成脚本（固定操作脚本化，保证输出稳定性）。

只负责：读取落盘片段 -> 读取权限明细 -> 合并生成工作簿。
判定/描述撰写由调用方（协调方）完成；本脚本只做机械转换，参数化固定操作。

用法:
    python build_check_xlsx.py --tasks <片段目录> --out <输出.xlsx> --source <本册来源>
    [--menu <权限明细.xls>] [--template <模板.json>] [--no-roles]

输入:
    --tasks    落盘片段目录（默认 <skill 目录>/.tasks/check-controller），扫描其下 **/*.md
    --menu     权限明细表（老式 xls，xlrd 读取）：明细表含表头 菜单ID/菜单名称/菜单地址/
               权限标识/层级码/是否末级/角色名称/角色编号，每行一条「菜单按钮 × 角色」；
               权限标识非空的行按「权限标识 → 角色名称」归集（去重保序）。未传则跳过权限角色提取
    --out      输出 xlsx 完整路径
    --source   本册来源描述（写入数据区末尾空行后的 A 列）
    --template 输出格式模板（JSON），缺省用内置通用模板（11 列：一级/二级/三级菜单、功能点、
               触发时机、校验位置、逻辑类型、管控类型、管控逻辑描述、提示语、备注）。
               项目需要特定表格格式（如对接既有《xxx收集表》样式）时，传模板 JSON 覆盖
    [--no-roles] 不附加「有权限角色」（默认对权限控制类条目自动附加）

输出:
    xlsx 工作簿（单表 Sheet1，按模板格式生成）
stdout: 统计（解析条目数 / 附加角色条目数 / 输出路径）

模板 JSON schema:
    {
      "header_rows": 1,                       # 表头行数（2 时支持第 1 行分组提示 + 表头合并）
      "headers": {1: "一级菜单", ...},         # 列号(1起) -> 表头文本
      "row1": {1: "分组1\n分组2", ...},         # header_rows=2 时的第 1 行分组提示（可空 {}）
      "widths": {"A": 14, ...},                # 列宽
      "field_columns": [1,2,...],              # 片段字段写入的列号（顺序对应片段列）
      "freeze": "A2",                          # 冻结窗格
      "header_fill": "FFC0C0C0",               # 表头底色
      "system_cols": [10, 11]                  # 涉及系统列（填 √），无则省略
    }
"""
import sys
import os
import re
import json
import glob
import argparse
import codecs


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

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TASKS = os.path.join(SCRIPT_DIR, "..", ".tasks", "check-controller")

# Excel 公式注入防护：以 = + - @ 开头的文本会被 Excel 当作公式（含 DDE 之类
# 外部调用）；写入单元格前前置单引号强制按文本处理，单引号本身不显示。
_FORMULA_PREFIX = ("=", "+", "-", "@")


def safe_text(v):
    """写入 xlsx 单元格前的中和：公式前缀开头的字符串加单引号，其余原样返回。"""
    if isinstance(v, str) and v.startswith(_FORMULA_PREFIX):
        return "'" + v
    return v

# 内置通用默认模板（无项目专属列；项目需对接既有表格样式时用 --template 覆盖）
DEFAULT_TEMPLATE = {
    "header_rows": 1,
    "headers": {1: "一级菜单", 2: "二级菜单", 3: "三级菜单", 4: "功能点", 5: "触发时机",
                6: "校验位置", 7: "逻辑类型", 8: "管控类型", 9: "管控逻辑描述", 10: "提示语", 11: "备注"},
    "row1": {},
    "widths": {"A": 14, "B": 14, "C": 14, "D": 10, "E": 10, "F": 10, "G": 12, "H": 10,
               "I": 45, "J": 20, "K": 20},
    "field_columns": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "freeze": "A2",
    "header_fill": "FFC0C0C0",
    "system_cols": None,
}


def load_template(template_path):
    if not template_path:
        return dict(DEFAULT_TEMPLATE)
    with open(template_path, "r", encoding="utf-8") as f:
        tpl = json.load(f)
    merged = dict(DEFAULT_TEMPLATE)
    for k, v in tpl.items():
        if v is None:
            continue
        if k in ("headers", "row1"):
            merged[k] = {int(c): t for c, t in v.items()}
        else:
            merged[k] = v
    return merged


def parse_fragments(tasks_dir):
    """解析落盘片段：markdown 层级 + 表格行 -> 数据行（每行一条管控逻辑）。
    数据行 = [一级菜单, 二级菜单, 三级菜单] + 表格 7 列（功能点/触发时机/校验位置/逻辑类型/管控类型/描述/提示语）"""
    rows = []
    for path in glob.glob(os.path.join(tasks_dir, "**", "*.md"), recursive=True):
        cur_m1 = cur_m2 = cur_m3 = None
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("### "):
                    cur_m1 = s.replace("### ", "").replace("一级菜单：", "")
                elif s.startswith("#### "):
                    cur_m2 = s.replace("#### ", "").replace("二级菜单：", "")
                elif s.startswith("##### "):
                    cur_m3 = s.replace("##### ", "").replace("三级菜单：", "")
                elif s.startswith("|") and not s.startswith("|---") and not s.startswith("| 功能点"):
                    cells = [c.strip() for c in s.strip("|").split("|")]
                    if len(cells) >= 7 and cells[0]:
                        rows.append([cur_m1, cur_m2, cur_m3] + cells[:7])
    return rows


def read_menu_roles(menu_path):
    """读取权限明细表 -> {权限点: 有权限角色列表}
    表头：菜单ID | 菜单名称 | 菜单地址 | 权限标识 | 层级码 | 是否末级 | 角色名称 | 角色编号；
    权限标识非空的行按「权限标识 → 角色名称」归集（去重、保序）。"""
    try:
        import xlrd
    except ImportError:
        print("[warn] 未安装 xlrd，无法读取权限明细，跳过权限角色提取", file=sys.stderr)
        return {}
    wb = xlrd.open_workbook(menu_path)
    sheet_names = wb.sheet_names()
    name = "Sheet1" if "Sheet1" in sheet_names else sheet_names[0]
    sh = wb.sheet_by_name(name)

    header_row = None
    for r in range(min(5, sh.nrows)):
        vals = [str(sh.cell_value(r, c)) for c in range(min(8, sh.ncols))]
        if "菜单名称" in vals and "权限标识" in vals and "角色名称" in vals:
            header_row = r
            break
    if header_row is None:
        print("[warn] 权限明细表未找到表头行，跳过权限角色提取", file=sys.stderr)
        return {}

    col_perm = col_role = None
    for c in range(sh.ncols):
        h = str(sh.cell_value(header_row, c)).strip()
        if h == "权限标识":
            col_perm = c
        elif h == "角色名称":
            col_role = c
    if col_perm is None or col_role is None:
        print("[warn] 权限明细表缺少 权限标识/角色名称 列，跳过权限角色提取", file=sys.stderr)
        return {}

    perm_roles = {}
    for r in range(header_row + 1, sh.nrows):
        perm = str(sh.cell_value(r, col_perm)).strip()
        role = str(sh.cell_value(r, col_role)).strip()
        if not perm or not role:
            continue
        perm_roles.setdefault(perm, [])
        if role not in perm_roles[perm]:
            perm_roles[perm].append(role)
    return perm_roles


def attach_roles(rows, perm_roles):
    """权限控制类条目按描述中的权限点代码匹配明细表，改写为角色导向描述：
    查到角色 -> 「仅以下角色可操作：xx、yy（权限点 xx:yyy）」；
    查不到 -> 「需权限点 xx:yyy（权限明细表未查询到该权限点的角色配置，需人工确认）」"""
    attached = 0
    perm_re = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)+")
    for row in rows:
        if row[7] != "权限控制":  # row: [一级,二级,三级,功能点,触发,位置,逻辑类型,管控类型,描述,提示语]
            continue
        desc = row[8]
        m = perm_re.search(desc)
        if not m:
            continue
        perm = m.group(0)
        roles = perm_roles.get(perm)
        if roles:
            row[8] = "仅以下角色可操作：%s（权限点 %s）" % ("、".join(roles), perm)
        else:
            row[8] = "需权限点 %s（权限明细表未查询到该权限点的角色配置，需人工确认）" % perm
        attached += 1
    return attached


def build_xlsx(rows, out_path, source, tpl):
    import openpyxl
    from openpyxl.styles import Font, Alignment, Border, Side, PatternFill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"

    font = Font(name="宋体", size=11)
    header_font = Font(name="宋体", size=11, bold=True)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    vcenter = Alignment(vertical="center")
    vcenter_wrap = Alignment(vertical="center", wrap_text=True)
    thin = Side(style="thin")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    header_fill = PatternFill("solid", fgColor=tpl.get("header_fill", "FFC0C0C0"))

    header_rows = tpl.get("header_rows", 1)
    headers = tpl.get("headers", {})
    row1 = tpl.get("row1", {})
    field_cols = tpl.get("field_columns", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    system_cols = tpl.get("system_cols")

    # header_rows=2：第 1 行分组提示行（无边框），第 2 行表头；否则仅 1 行表头
    if header_rows >= 2:
        for col, val in row1.items():
            c = ws.cell(row=1, column=col, value=safe_text(val))
            c.font = font
            c.alignment = center
        ws.row_dimensions[1].height = 99

    header_row_idx = header_rows if header_rows >= 2 else 1
    for col, val in headers.items():
        c = ws.cell(row=header_row_idx, column=col, value=val)
        c.font = header_font
        c.alignment = center
        c.border = border
        c.fill = header_fill
    if header_rows >= 2:
        # 第 1 行分组提示 + 第 2 行表头；system_cols 用于「涉及系统」细分列（填 √）
        pass
    ws.row_dimensions[header_row_idx].height = 14

    # 数据行
    data_start = header_row_idx + 1
    for i, r in enumerate(rows, start=data_start):
        for k, col in enumerate(field_cols):
            if k < len(r):
                c = ws.cell(row=i, column=col, value=safe_text(r[k]))
                c.font = font
                c.alignment = vcenter_wrap if col in (9, 10) else vcenter
        if system_cols:
            for col in system_cols:
                ws.cell(row=i, column=col, value="√").font = font
        ws.row_dimensions[i].height = 14.15

    # 列宽
    for k, v in tpl.get("widths", {}).items():
        ws.column_dimensions[k].width = v

    # 冻结窗格
    ws.freeze_panes = tpl.get("freeze", "A2")

    # 本册来源（数据区末尾空一行）
    if source:
        src_row = data_start + len(rows) + 1
        c = ws.cell(row=src_row, column=1, value="本册来源：%s" % source)
        c.font = font

    wb.save(out_path)
    return len(ws.merged_cells.ranges)


def main():
    ap = argparse.ArgumentParser(description="业务管控逻辑合并生成 xlsx（模板驱动）")
    ap.add_argument("--tasks", default=DEFAULT_TASKS, help="落盘片段目录")
    ap.add_argument("--menu", default=None, help="权限明细表（老式 xls，xlrd 读取；未传则跳过权限角色提取）")
    ap.add_argument("--out", required=True, help="输出 xlsx 完整路径")
    ap.add_argument("--source", default="", help="本册来源描述")
    ap.add_argument("--template", default=None, help="输出格式模板 JSON（缺省内置通用模板）")
    ap.add_argument("--no-roles", action="store_true", help="跳过权限角色提取")
    args = ap.parse_args()

    if not os.path.isdir(args.tasks):
        print("错误：片段目录不存在：%s" % args.tasks, file=sys.stderr)
        return 2
    out_dir = os.path.dirname(args.out)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    rows = parse_fragments(args.tasks)
    if not rows:
        print("错误：未解析到任何管控逻辑（片段目录为空？）", file=sys.stderr)
        return 2

    attached = 0
    if args.no_roles:
        print("[info] --no-roles 已指定，跳过权限角色提取")
    elif args.menu and os.path.isfile(args.menu):
        menu_roles = read_menu_roles(args.menu)
        attached = attach_roles(rows, menu_roles)
    elif not args.menu:
        print("[info] 未提供 --menu，跳过权限角色提取")

    tpl = load_template(args.template)
    merged = build_xlsx(rows, args.out, args.source, tpl)
    print("解析管控逻辑条目：%d | 附加有权限角色：%d | 输出：%s | 合并单元格：%d | 模板：%s"
          % (len(rows), attached, args.out, merged,
             args.template or "内置通用模板"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
