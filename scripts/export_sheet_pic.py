#!/usr/bin/env python3
"""
把 daily-dy.xlsx「股票数据」Sheet 渲染成图片保存到 pictures/<日期时间>.png
原理：openpyxl 读取数据和格式 → 生成 HTML → Chromium 浏览器无头截图
"""
import subprocess, sys, html as html_mod, tempfile, os, datetime
from pathlib import Path
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from browser_utils import find_browser

EXCEL_PATH = Path(__file__).parent.parent / "data" / "daily-dy.xlsx"
OUTPUT_DIR  = Path(__file__).parent.parent / "pictures"


# ── 颜色工具 ─────────────────────────────────────────────────────────────────

def _hex(color):
    """openpyxl Color → CSS hex 或 None"""
    if color is None:
        return None
    try:
        if color.type == "rgb":
            rgb = color.rgb  # 'AARRGGBB'
            if rgb and len(rgb) == 8 and rgb.upper() not in ("00000000", "FFFFFFFF"):
                return f"#{rgb[2:]}"
    except Exception:
        pass
    return None


def _border(side):
    if not side or not side.style:
        return None
    mapping = {"thin": "1px solid #aaa", "medium": "2px solid #777",
               "thick": "3px solid #444", "hair": "1px solid #ccc",
               "dashed": "1px dashed #aaa", "dotted": "1px dotted #aaa"}
    return mapping.get(side.style, "1px solid #aaa")


# ── 数值格式化 ────────────────────────────────────────────────────────────────

def _fmt(cell, val=None):
    if val is None:
        val = cell.value
    if val is None:
        return ""
    nf = (cell.number_format or "").upper()
    if isinstance(val, float):
        if "%" in nf:
            return f"{val:.2%}"
        if "0.00" in nf or "#,##0.00" in nf:
            return f"{val:,.2f}"
        if "#,##0" in nf:
            return f"{val:,.0f}"
        # 整数值
        if val == int(val):
            return str(int(val))
        return f"{val:.4f}".rstrip("0").rstrip(".")
    if isinstance(val, int):
        return f"{val:,}" if "#,##" in nf else str(val)
    return str(val)


# ── HTML 生成 ─────────────────────────────────────────────────────────────────

def _cell_val(ws, row, col):
    """读单元格值；公式列被 openpyxl 清空后按原始公式重算。"""
    v = ws.cell(row=row, column=col).value
    if v is not None:
        return v
    if ws.title == "股票数据":
        # G=7: E/D   I=9: E/H   K=11: (D-J)/J
        d = ws.cell(row=row, column=4).value
        e = ws.cell(row=row, column=5).value
        h = ws.cell(row=row, column=8).value
        j = ws.cell(row=row, column=10).value
        if col == 7 and d and e:
            return e / d
        if col == 9 and e and h:
            return e / h
        if col == 11 and d and j:
            return (d - j) / j
    elif ws.title == "港股数据":
        # G=7 A/H溢价率   H=8 A股股息率   I=9 港股股息率
        # J=10 港户股息率  K=11 港股通股息率
        d = ws.cell(row=row, column=4).value   # H价HKD
        e = ws.cell(row=row, column=5).value   # A价CNY
        f = ws.cell(row=row, column=6).value   # 最新完整年度分红
        l_tax = ws.cell(row=row, column=12).value  # 港股通税率
        # 汇率：找标签 '汇率' 后右邻格
        fx = None
        for c in range(1, ws.max_column + 1):
            if ws.cell(1, c).value == '汇率':
                fx = ws.cell(1, c + 1).value
                break
        if not (isinstance(d, (int, float)) and isinstance(e, (int, float))):
            return None
        denom = d * fx if fx else None
        if col == 7 and denom:
            return e / denom - 1
        if col in (8, 9, 10, 11) and not isinstance(f, (int, float)):
            return '待核实'
        if col == 8 and f and e:
            return f / e
        if col == 9 and f and denom:
            return f / denom
        if col == 10 and f and denom:
            return f / denom * 0.9
        if col == 11 and f and denom and l_tax:
            return f / denom * l_tax
    return None


def build_html(ws, row1, row2, col1, col2):
    # 合并单元格
    skip = set()
    spans = {}
    for mr in ws.merged_cells.ranges:
        r1, c1 = mr.min_row, mr.min_col
        r2, c2 = mr.max_row, mr.max_col
        spans[(r1, c1)] = (r2 - r1 + 1, c2 - c1 + 1)
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if not (r == r1 and c == c1):
                    skip.add((r, c))

    # 列宽 (pt → px ≈ ×7)
    col_px = {}
    for ci in range(col1, col2 + 1):
        letter = get_column_letter(ci)
        dim = ws.column_dimensions.get(letter)
        col_px[ci] = round((dim.width if dim and dim.width else 9) * 7)
        # The HTML uses 14pt text, larger than Excel's source font. Allow the
        # full formatted labels and prices to fit before sizing the viewport.
        for ri in range(row1,row2+1):
            if (ri,ci) in skip:
                continue
            text=_fmt(ws.cell(ri,ci),_cell_val(ws,ri,ci))
            text_width=sum(20 if ord(ch)>127 else 11 for ch in text)+16
            col_px[ci]=max(col_px[ci],text_width)

    rows_html = []
    for ri in range(row1, row2 + 1):
        rdim = ws.row_dimensions.get(ri)
        rh_px = round((rdim.height if rdim and rdim.height else 14) * 1.33)
        cells_html = []
        for ci in range(col1, col2 + 1):
            if (ri, ci) in skip:
                continue
            cell = ws.cell(row=ri, column=ci)
            s = [f"height:{rh_px}px", "padding:2px 5px", "white-space:nowrap",
                 "overflow:hidden", "box-sizing:border-box"]

            # 背景色
            fill = cell.fill
            if fill and fill.fill_type == "solid":
                bg = _hex(fill.fgColor)
                if bg:
                    s.append(f"background:{bg}")

            # 字体
            font = cell.font
            if font:
                if font.bold:   s.append("font-weight:bold")
                if font.italic: s.append("font-style:italic")
                fg = _hex(font.color) if font.color else None
                if fg:          s.append(f"color:{fg}")
                # font-size 由 CSS 统一控制，不读 Excel 原始值
                if font.name:   s.append(f'font-family:"{font.name}",sans-serif')

            # 对齐
            align = cell.alignment
            if align:
                ha = align.horizontal
                if ha and ha != "general":
                    css_ha = {"left":"left","center":"center","right":"right",
                              "centerContinuous":"center"}.get(ha, "left")
                    s.append(f"text-align:{css_ha}")
                va = align.vertical
                if va:
                    css_va = {"top":"top","center":"middle","bottom":"bottom"}.get(va,"middle")
                    s.append(f"vertical-align:{css_va}")

            # 边框
            border = cell.border
            if border:
                for prop, side in [("border-top", border.top), ("border-right", border.right),
                                   ("border-bottom", border.bottom), ("border-left", border.left)]:
                    b = _border(side)
                    if b:
                        s.append(f"{prop}:{b}")

            attrs = f' style="{";".join(s)}"'
            if (ri, ci) in spans:
                rs, cs = spans[(ri, ci)]
                if rs > 1: attrs += f' rowspan="{rs}"'
                if cs > 1: attrs += f' colspan="{cs}"'

            cells_html.append(f"<td{attrs}>{html_mod.escape(_fmt(cell, _cell_val(ws, ri, ci)))}</td>")
        rows_html.append(f"<tr>{''.join(cells_html)}</tr>")

    col_tags = "".join(f'<col style="width:{col_px[ci]}px">'
                       for ci in range(col1, col2 + 1))
    total_w = sum(col_px.values())
    total_h = sum(
        round((ws.row_dimensions.get(ri).height
               if ws.row_dimensions.get(ri) and ws.row_dimensions.get(ri).height
               else 15) * 1.33)
        for ri in range(row1, row2 + 1)
    )

    html_str = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{margin:0;padding:0;background:#fff}}
  table {{border-collapse:collapse;width:{total_w}px;
          font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:14pt}}
  td {{border:1.5px solid #999999;text-align:center;vertical-align:middle;font-size:14pt}}
</style>
</head><body>
<table><colgroup>{col_tags}</colgroup><tbody>
{"".join(rows_html)}
</tbody></table>
</body></html>"""
    return html_str, total_w, total_h


# ── 浏览器截图 ───────────────────────────────────────────────────────────────

def screenshot_html(html_content: str, output_path: Path, total_w: int, total_h: int,
                    watermark: str = ""):
    output_path=Path(output_path).resolve()
    # 用远大于内容的窗口高度，确保不裁断；再用 Pillow 裁掉空白
    window_w = total_w + 20
    window_h = max(total_h * 2, 3000)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".html",
                                     delete=False, encoding="utf-8") as f:
        f.write(html_content)
        html_file = f.name

    try:
        with tempfile.TemporaryDirectory(prefix='dy-screenshot-') as profile:
            result = subprocess.run([
                find_browser(),
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                f"--user-data-dir={profile}",
                f"--window-size={window_w},{window_h}",
                f"--screenshot={output_path}",
                f"file://{html_file}",
            ], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"浏览器截图错误：{result.stderr[:300]}")
    finally:
        os.unlink(html_file)

    # 自动裁掉右侧和底部空白区域
    from PIL import Image, ImageChops, ImageDraw, ImageFont
    img = Image.open(str(output_path)).convert("RGB")
    bg  = Image.new("RGB", img.size, (255, 255, 255))
    bbox = ImageChops.difference(img, bg).getbbox()
    if bbox:
        img = img.crop(bbox)

    # 居中对角线单条大水印
    if watermark:
        # 字号按图片对角线 / 文字长度估算，让单条水印横跨整图
        diag = (img.width ** 2 + img.height ** 2) ** 0.5
        font_size = max(48, int(diag / (len(watermark) * 1.3)))
        font = None
        for path in ("/System/Library/Fonts/PingFang.ttc",
                     "/System/Library/Fonts/STHeiti Light.ttc",
                     "/System/Library/Fonts/Helvetica.ttc"):
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, font_size)
                    break
                except Exception:
                    pass
        if font is None:
            font = ImageFont.load_default()

        tmp_draw = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
        tb = tmp_draw.textbbox((0, 0), watermark, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pad = font_size
        tile = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text(
            (pad, pad), watermark, font=font,
            fill=(80, 80, 80, 80),
            stroke_width=2, stroke_fill=(255, 255, 255, 110),
        )
        tile = tile.rotate(-30, resample=Image.BICUBIC, expand=True)

        # 居中贴一个
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        x = (img.width - tile.width) // 2
        y = (img.height - tile.height) // 2
        overlay.paste(tile, (x, y), tile)

        Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB").save(str(output_path))
    else:
        img.save(str(output_path))


# ── 主流程 ───────────────────────────────────────────────────────────────────

def main():
    sys.path.insert(0, str(Path(__file__).parent))

    # 1. 更新 Excel（价格 + 除息日），返回分红结论
    import update_dy
    dividend_summary = update_dy.main()

    # 2. 按日期分目录：pictures/YYYYMMDD/
    now = datetime.datetime.now()
    as_of_date = update_dy.ashare_price_date()
    day_dir = OUTPUT_DIR / now.strftime("%Y%m%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    timestamp = now.strftime("%Y%m%d_%H%M%S")

    print()
    wb = load_workbook(EXCEL_PATH, data_only=True)

    watermark = f"{as_of_date.isoformat()}  ·  股息观察"
    summary_path = day_dir / f"{timestamp}_分红结论.txt"
    summary_path.write_text(dividend_summary, encoding="utf-8")
    yield_md = update_dy.generate_yield_markdown(wb)
    yield_md_path = day_dir / f"{timestamp}_股息率.md"
    yield_md_path.write_text(yield_md, encoding="utf-8")

    try:
        find_browser()
    except RuntimeError as exc:
        print(f"\n已更新表格；跳过图片生成：{exc}")
        print(f"结论：{summary_path}\n股息率报告：{yield_md_path}")
        return

    def _last_data_row(ws, name_col=2):
        for r in range(ws.max_row, 1, -1):
            if ws.cell(r, name_col).value:
                return r
        return 1

    image_paths = []
    try:
        # 表格截图和卡片属于可选输出；失败不影响已完成的表格更新。
        output_path = day_dir / f"{timestamp}.png"
        a_last = _last_data_row(wb["股票数据"])
        html_content, total_w, total_h = build_html(wb["股票数据"], 1, a_last, 1, 19)
        screenshot_html(html_content, output_path, total_w, total_h, watermark=watermark)
        image_paths.append(("A股截图", output_path))

        hk_path = day_dir / f"{timestamp}_港股.png"
        hk_last = _last_data_row(wb["港股数据"], name_col=1)
        hk_html, hk_w, hk_h = build_html(wb["港股数据"], 1, hk_last, 1, 11)
        screenshot_html(hk_html, hk_path, hk_w, hk_h, watermark=watermark)
        image_paths.append(("港股截图", hk_path))

        import render_card
        exdiv_md = update_dy.exdiv_card_md(wb)
        card_path = day_dir / f"{timestamp}_card.png"
        if exdiv_md:
            idx = yield_md.rfind("\n## 近期除息日")
            main_md = yield_md[:idx].rstrip() if idx >= 0 else yield_md
            render_card.render_card(main_md, card_path)
            exdiv_card_path = day_dir / f"{timestamp}_除息日_card.png"
            render_card.render_card(exdiv_md, exdiv_card_path)
            image_paths.append(("除息日卡片", exdiv_card_path))
        else:
            render_card.render_card(yield_md, card_path)
        image_paths.append(("A股卡片", card_path))

        hk_card_path = day_dir / f"{timestamp}_港股_card.png"
        render_card.render_hk_card(wb["港股数据"], hk_card_path, as_of_date.isoformat())
        image_paths.append(("港股卡片", hk_card_path))
    except Exception as exc:
        print(f"图片生成失败，已跳过：{exc}")

    print()
    print("=" * 50)
    print(dividend_summary)
    print("=" * 50)
    print(f"结论：{summary_path}")
    print(f"股息率报告：{yield_md_path}")
    for label, path in image_paths:
        print(f"{label}：{path}")


if __name__ == "__main__":
    main()
