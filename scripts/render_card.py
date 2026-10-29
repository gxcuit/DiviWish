#!/usr/bin/env python3
"""
股息率日报 MD → HTML card (1080×1440) → PNG via a headless Chromium browser.
"""
import base64, html as html_mod, os, re, subprocess, sys, tempfile
from pathlib import Path
from browser_utils import find_browser

AVATAR_PATH = Path(__file__).parent.parent / ".xhs-md-renderer" / "avatar.jpg"
CARD_W, CARD_H = 1080, 1440

STATUS_COLORS = {
    "🟢": ("#16a34a", "#bbf7d0", "#14532d"),
    "🔵": ("#2563eb", "#bfdbfe", "#1e3a8a"),
    "🟠": ("#ea580c", "#fed7aa", "#7c2d12"),
    "⚪": ("#6b7280", "#e5e7eb", "#374151"),
}

SECTION_ACCENTS = {
    "颜色跃迁":   "#3b82f6",
    "今日大涨大跌": "#dc2626",
    "近期除息日":  "#7c3aed",
}


def _avatar_src():
    if AVATAR_PATH.exists():
        data = base64.b64encode(AVATAR_PATH.read_bytes()).decode()
        return f"data:image/jpeg;base64,{data}"
    return ""


def _parse_stats(line):
    parts = re.split(r'\s{2,}', line.strip())
    result = []
    for p in parts:
        p = p.strip()
        m = re.match(r'([\U0001F7E2\U0001F535\U0001F7E0⚪])\s+(.*)', p)
        if m:
            result.append((m.group(1), m.group(2)))
    return result


def _parse(text):
    lines = text.strip().split('\n')
    out = {"date": "", "stats": [], "sections": []}

    for l in lines:
        if l.startswith('# '):
            m = re.search(r'(\d{4}-\d{2}-\d{2})', l)
            if m:
                out["date"] = m.group(1)

    for l in lines:
        if any(e in l for e in ['🟢', '🔵', '🟠', '⚪']) and not l.startswith('#'):
            out["stats"] = _parse_stats(l)
            break

    cur_sec = cur_sub = None
    for l in lines:
        if l.startswith('## '):
            cur_sec = {"title": l[3:].strip(), "subsections": [], "items": []}
            out["sections"].append(cur_sec)
            cur_sub = None
        elif l.startswith('**') and l.endswith('**') and cur_sec is not None:
            cur_sub = {"title": l[2:-2], "items": []}
            cur_sec["subsections"].append(cur_sub)
        elif l.startswith('- ') and cur_sec is not None:
            item = l[2:].strip()
            (cur_sub["items"] if cur_sub else cur_sec["items"]).append(item)

    return out


def _stat_box(emoji, label):
    col, bg, _ = STATUS_COLORS.get(emoji, ("#6b7280", "#e5e7eb", "#374151"))
    m = re.match(r'(\d+)支(\([+-]\d+\))?', label)
    count = m.group(1) if m else label
    delta = m.group(2) if (m and m.group(2)) else ""
    delta_html = f'<div class="stat-delta" style="color:{col}">{delta}</div>' if delta else ""
    return (f'<div class="stat-box" style="background:{bg}">'
            f'<div class="stat-emoji">{emoji}</div>'
            f'<div class="stat-count" style="color:{col}">{count}支</div>'
            f'{delta_html}</div>')


def _pop_price(parts):
    """If parts[0] is a price token (¥… / HK$…), pop and return it."""
    if parts and re.match(r'^(¥|HK\$)\d', parts[0]):
        return parts.pop(0)
    return ""


def _fmt_transition(text):
    m = re.match(r'([\U0001F7E2\U0001F535\U0001F7E0⚪])→([\U0001F7E2\U0001F535\U0001F7E0⚪])\s+(\S+)\s+(.*)', text)
    if not m:
        return f'<div class="item"><span class="iname">{html_mod.escape(text)}</span></div>'
    fe, te, name, rest = m.groups()
    fc = STATUS_COLORS.get(fe, ("#6b7280",))[0]
    tc = STATUS_COLORS.get(te, ("#6b7280",))[0]
    parts = re.split(r'\s{2,}', rest.strip())
    price = _pop_price(parts)
    pct = parts[0] if parts else ""
    detail = "  ".join(parts[1:]) if len(parts) > 1 else ""
    pc = "#16a34a" if pct.startswith('-') else "#dc2626"
    price_html = f'<span class="iprice">{html_mod.escape(price)}</span>' if price else ""
    return (f'<div class="item">'
            f'<div class="tr-arrow"><span style="color:{fc}">{fe}</span>'
            f'<span class="arr">→</span><span style="color:{tc}">{te}</span></div>'
            f'<div class="item-body">'
            f'<span class="iname">{html_mod.escape(name)}</span>'
            f'{price_html}'
            f'<span class="ipct" style="color:{pc}">{html_mod.escape(pct)}</span>'
            f'<span class="idet">{html_mod.escape(detail)}</span>'
            f'</div></div>')


def _fmt_mover(text):
    m = re.match(r'(📉|📈)\s+(\S+)\s+(.*)', text)
    if not m:
        return f'<div class="item"><span class="iname">{html_mod.escape(text)}</span></div>'
    emo, name, rest = m.groups()
    parts = re.split(r'\s{2,}', rest.strip())
    price = _pop_price(parts)
    pct = parts[0] if parts else ""
    detail = "  ".join(parts[1:]) if len(parts) > 1 else ""
    pc = "#16a34a" if pct.startswith('-') else "#dc2626"
    price_html = f'<span class="iprice">{html_mod.escape(price)}</span>' if price else ""
    return (f'<div class="item"><span class="emo">{emo}</span>'
            f'<div class="item-body">'
            f'<span class="iname">{html_mod.escape(name)}</span>'
            f'{price_html}'
            f'<span class="ipct" style="color:{pc}">{html_mod.escape(pct)}</span>'
            f'<span class="idet">{html_mod.escape(detail)}</span>'
            f'</div></div>')


def _fmt_exdiv(text):
    m = re.match(r'📅\s+(\S+)\s+(.*)', text)
    if not m:
        return f'<div class="item"><span class="iname">{html_mod.escape(text)}</span></div>'
    name, rest = m.groups()
    parts = re.split(r'\s{2,}', rest.strip())
    price_s = next((p for p in parts if p.startswith("¥")), "")
    date_s  = next((p for p in parts if ("天后" in p or "今天" in p)), "")
    amt_s   = next((p for p in parts if p.startswith("每股")), "")
    yld_s   = next((p for p in parts if ("现价" in p or "股息率" in p)), "")
    m_days = re.search(r'(\d+)天后', date_s)
    urgent = "今天" in date_s or (m_days is not None and int(m_days.group(1)) <= 3)
    dc = "#dc2626" if urgent else "#1a1200"
    price_html = f'<span class="iprice">{html_mod.escape(price_s)}</span>' if price_s else ""
    amt_html = f'<span class="iamt">{html_mod.escape(amt_s)}</span>' if amt_s else ""
    if "→" in yld_s and "除息后" in yld_s:
        cur_p, ex_p = (x.strip() for x in yld_s.split("→", 1))
        yld_html = (f'<span class="iylds">'
                    f'<span class="iy-cur">{html_mod.escape(cur_p)}</span>'
                    f'<span class="iy-arr">→</span>'
                    f'<span class="iy-ex">{html_mod.escape(ex_p)}</span></span>')
    else:
        yld_html = f'<span class="iylds"><span class="iy-cur">{html_mod.escape(yld_s)}</span></span>'
    return (f'<div class="item"><span class="emo">📅</span>'
            f'<div class="item-body">'
            f'<span class="iname">{html_mod.escape(name)}</span>'
            f'{price_html}'
            f'<span class="idate" style="color:{dc}">{html_mod.escape(date_s)}</span>'
            f'{amt_html}'
            f'{yld_html}'
            f'</div></div>')


def _fmt_item(text):
    if '→' in text and any(e in text for e in ['🟢', '🔵', '🟠', '⚪']):
        return _fmt_transition(text)
    if text.startswith(('📉', '📈')):
        return _fmt_mover(text)
    if text.startswith('📅'):
        return _fmt_exdiv(text)
    return f'<div class="item"><span class="iname">{html_mod.escape(text)}</span></div>'


def _count_items(sec):
    n = len(sec.get("items", []))
    for sub in sec.get("subsections", []):
        n += len(sub.get("items", []))
    return max(n, 1)


def _section_html(sec, flex_grow=1, index=1):
    key = sec["title"].split("（")[0]
    accent = SECTION_ACCENTS.get(key, "#b35a00")
    parts = []
    for item in sec.get("items", []):
        parts.append(_fmt_item(item))
    for sub in sec.get("subsections", []):
        sub_items = "".join(_fmt_item(i) for i in sub["items"])
        parts.append(
            f'<div class="sub">'
            f'<div class="sub-title" style="color:{accent};border-left-color:{accent}">{html_mod.escape(sub["title"])}</div>'
            f'{sub_items}</div>'
        )
    shadow = f"inset 7px 0 0 0 {accent}"
    return (f'<div class="sec" style="flex:{flex_grow};box-shadow:{shadow}">'
            f'<div class="sec-head">'
            f'<span class="sec-num" style="color:{accent}">{index:02d}</span>'
            f'<span class="sec-title">{html_mod.escape(sec["title"])}</span>'
            f'</div>'
            f'<div class="sec-body">{"".join(parts)}</div>'
            f'</div>')


def build_html(md_text):
    data = _parse(md_text)
    avatar_src = _avatar_src()
    stats_html = "".join(_stat_box(e, l) for e, l in data["stats"])
    secs_html = "".join(
        _section_html(s, _count_items(s) + 1, i + 1)
        for i, s in enumerate(data["sections"])
    )

    # 自适应密度：除息条目通常折成两行，按 2 条普通 item 计入布局负载。
    total_items = sum(
        len(s.get("items", [])) + sum(len(sub.get("items", [])) for sub in s.get("subsections", []))
        for s in data["sections"]
    )
    exdiv_items = sum(
        _count_items(s) for s in data["sections"] if s["title"].startswith("近期除息日")
    )
    layout_items = total_items + exdiv_items
    if layout_items >= 14:
        body_cls = "dense ultra"
    elif layout_items >= 9:
        body_cls = "dense"
    else:
        body_cls = ""

    y, mo, d = (data["date"].split("-") + ["", "", ""])[:3]
    date_disp = f"{y}年{int(mo)}月{int(d)}日" if y else data["date"]
    avatar_tag = f'<img class="avatar" src="{avatar_src}">' if avatar_src else '<div class="avatar"></div>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{
  --mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,"Roboto Mono",monospace;
  --sans:"PingFang SC","Noto Sans SC","Microsoft YaHei","Apple Color Emoji",sans-serif;
  --serif:"Songti SC","STSong",ui-serif,Georgia,"Times New Roman",serif;
  --clay:#B85C3E;
  width:{CARD_W}px;height:{CARD_H}px;overflow:hidden;
  background:#FFE552;color:#1a1200;
  font-family:var(--sans);
  padding:56px 72px 40px;
  display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;
}}

/* ── header ─────────────────────────── */
.hdr{{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}}
.hdr-left{{display:flex;align-items:center;gap:20px}}
.avatar{{width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(0,0,0,0.18)}}
.uname{{font-size:28px;font-weight:700;color:#1a1200}}
.uhandle{{font-size:18px;color:#1a1200;margin-top:3px;font-family:var(--mono);letter-spacing:0.06em}}
.hdr-date{{font-size:22px;font-weight:600;color:#1a1200;line-height:1.6;text-align:right;font-family:var(--mono);letter-spacing:0.04em}}

/* ── eyebrow + title ────────────────── */
.eyebrow{{
  display:flex;align-items:center;gap:14px;
  font-family:var(--mono);font-size:17px;font-weight:700;
  letter-spacing:0.16em;text-transform:uppercase;
  color:#1a1200;margin:4px 0 12px;
}}
.eyebrow::before{{content:"";width:42px;height:3.5px;background:var(--clay);border-radius:2px}}
.title{{
  font-family:var(--serif);
  font-size:72px;font-weight:600;color:#1a1200;
  letter-spacing:-1.6px;line-height:1.0;margin-bottom:30px;
}}

/* ── stats ──────────────────────────── */
.stats{{display:flex;gap:14px;margin-bottom:37px}}
.stat-box{{flex:1;border-radius:18px;padding:18px 10px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:5px}}
.stat-emoji{{font-size:30px;line-height:1;font-family:"Apple Color Emoji",sans-serif}}
.stat-count{{font-size:36px;font-weight:800;line-height:1.1}}
.stat-delta{{font-size:18px;font-weight:600;opacity:0.85;font-family:var(--mono);letter-spacing:-0.2px}}

/* ── sections ───────────────────────── */
.secs{{display:flex;flex-direction:column;flex:1;gap:18px;min-height:0}}
.sec{{background:rgba(255,255,255,0.72);border-radius:22px;padding:26px 30px;display:flex;flex-direction:column;min-height:0;overflow:hidden}}
.sec-head{{
  display:flex;align-items:baseline;gap:14px;
  margin-bottom:14px;padding-bottom:12px;
  border-bottom:2px solid rgba(0,0,0,0.22);
}}
.sec-num{{font-family:var(--mono);font-size:16px;letter-spacing:0.14em;font-weight:700}}
.sec-title{{font-size:32px;font-weight:800;color:#1a1200;letter-spacing:-0.5px}}
.sec-body{{flex:1;display:flex;flex-direction:column;justify-content:space-around}}

/* ── subsection ─────────────────────── */
.sub{{margin-top:4px}}
.sub-title{{font-size:22px;font-weight:700;margin-bottom:6px;padding-left:10px;border-left:4px solid currentColor}}

/* ── items ──────────────────────────── */
.item{{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.16)}}
.item:last-child{{border-bottom:none}}
.tr-arrow{{display:flex;align-items:center;gap:3px;font-size:24px;min-width:76px;font-family:"Apple Color Emoji",sans-serif}}
.arr{{color:#5a3e00;font-size:18px;padding:0 1px}}
.emo{{font-size:26px;min-width:38px;font-family:"Apple Color Emoji",sans-serif}}
.item-body{{flex:1;display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}}
.iname{{font-size:27px;font-weight:700;color:#1a1200;letter-spacing:-0.3px}}
.iprice{{font-size:21px;font-weight:700;color:#1a1200;font-family:var(--mono);letter-spacing:-0.3px}}
.ipct{{font-size:24px;font-weight:700;font-family:var(--mono);letter-spacing:-0.5px}}
.idate{{font-size:23px;font-weight:700;font-family:var(--mono);letter-spacing:-0.3px}}
.iamt{{font-size:21px;font-weight:700;color:#7c3aed;font-family:var(--mono);letter-spacing:-0.3px}}
.idet{{font-size:23px;font-weight:700;color:#1a1200;margin-left:auto;font-family:var(--mono);letter-spacing:-0.2px}}
.iylds{{display:flex;align-items:baseline;gap:7px;margin-left:auto;font-family:var(--mono);font-weight:700;letter-spacing:-0.2px}}
.iy-cur{{font-size:23px;color:#1a1200}}
.iy-arr{{font-size:18px;color:#7c3aed}}
.iy-ex{{font-size:23px;color:#7c3aed}}

/* ── risk ───────────────────────────── */
.risk{{margin-top:20px;text-align:center;font-size:17px;font-weight:600;color:#5a2200;line-height:1.4;padding:12px 16px;background:rgba(255,255,255,0.55);border-radius:12px;border:1.5px dashed var(--clay)}}

/* ── dense mode（内容多时压缩 padding/字号）─────────── */
body.dense{{padding:48px 68px 32px}}
body.dense .title{{font-size:64px;margin-bottom:20px}}
body.dense .stats{{margin-bottom:22px}}
body.dense .stat-box{{padding:14px 10px;gap:3px}}
body.dense .stat-count{{font-size:32px}}
body.dense .secs{{gap:12px}}
body.dense .sec{{padding:16px 24px;border-radius:18px}}
body.dense .sec-head{{margin-bottom:8px;padding-bottom:8px}}
body.dense .sec-title{{font-size:28px}}
body.dense .item{{padding:5px 0}}
body.dense .iname{{font-size:24px}}
body.dense .iprice{{font-size:19px}}
body.dense .ipct,body.dense .idate{{font-size:22px}}
body.dense .iamt{{font-size:19px}}
body.dense .idet{{font-size:21px}}
body.dense .iy-cur,body.dense .iy-ex{{font-size:21px}}
body.dense .iy-arr{{font-size:16px}}
body.dense .tr-arrow{{font-size:22px;min-width:70px}}
body.dense .emo{{font-size:24px;min-width:34px}}
body.dense .sub-title{{font-size:20px;margin-bottom:4px}}
body.dense .risk{{margin-top:12px;padding:9px 14px;font-size:15px}}

/* ── ultra mode（≥14 项时再次压缩）─────────── */
body.ultra{{padding:40px 60px 24px}}
body.ultra .hdr{{margin-bottom:18px}}
body.ultra .title{{font-size:52px;margin-bottom:14px}}
body.ultra .stats{{margin-bottom:14px;gap:10px}}
body.ultra .stat-box{{padding:10px 8px;gap:1px;border-radius:14px}}
body.ultra .stat-emoji{{font-size:24px}}
body.ultra .stat-count{{font-size:26px}}
body.ultra .stat-delta{{font-size:15px}}
body.ultra .secs{{gap:8px}}
body.ultra .sec{{padding:11px 20px;border-radius:14px}}
body.ultra .sec-head{{margin-bottom:5px;padding-bottom:5px}}
body.ultra .sec-title{{font-size:24px}}
body.ultra .sec-num{{font-size:14px}}
body.ultra .item{{padding:3px 0;gap:8px}}
body.ultra .iname{{font-size:21px}}
body.ultra .iprice{{font-size:17px}}
body.ultra .ipct,body.ultra .idate{{font-size:19px}}
body.ultra .iamt{{font-size:17px}}
body.ultra .idet{{font-size:19px}}
body.ultra .iy-cur,body.ultra .iy-ex{{font-size:19px}}
body.ultra .iy-arr{{font-size:15px}}
body.ultra .tr-arrow{{font-size:19px;min-width:62px}}
body.ultra .emo{{font-size:21px;min-width:30px}}
body.ultra .sub-title{{font-size:18px;margin-bottom:2px}}
body.ultra .risk{{margin-top:8px;padding:7px 12px;font-size:14px}}
</style>
</head>
<body class="{body_cls}">
<div class="hdr">
  <div class="hdr-left">
    {avatar_tag}
    <div><div class="uname">股息观察</div><div class="uhandle">每日跟踪</div></div>
  </div>
  <div class="hdr-date">{date_disp}</div>
</div>
<div class="eyebrow"><span>每日观察 · 股息率追踪</span></div>
<div class="title">股息率日报</div>
<div class="stats">{stats_html}</div>
<div class="secs">{secs_html}</div>
<div class="risk">⚠️ 数据为估算值，未考虑分红预案变更、汇率波动、流动性、税制调整等风险，仅供参考，不构成投资建议</div>
</body></html>"""


def render_card(md_text: str, output_path: Path) -> None:
    _screenshot(build_html(md_text), output_path)


def _screenshot(html_content: str, output_path: Path) -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html_content)
        html_file = f.name
    try:
        result = subprocess.run([
            find_browser(),
            "--headless=new", "--no-sandbox", "--disable-gpu",
            f"--window-size={CARD_W},{CARD_H}",
            f"--screenshot={output_path}",
            f"file://{html_file}",
        ], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"浏览器截图错误：{result.stderr[:300]}")
    finally:
        os.unlink(html_file)


# ─── 港股 A/H 溢价排名卡片 ─────────────────────────────────────────────

def _hk_collect(ws):
    """读取港股数据，仅返回溢价 ≥20% (🟢🟠) 的股票，按溢价降序。
    每条含 a_yld/hk_yld/hu_yld/gt_yld 四个口径。"""
    fx = None
    for c in range(1, ws.max_column + 1):
        if ws.cell(1, c).value == '汇率':
            fx = ws.cell(1, c + 1).value
            break
    fx = fx or 0.8684
    rows = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(r, 1).value
        d = ws.cell(r, 4).value   # H 价 HKD
        e = ws.cell(r, 5).value   # A 价 CNY
        f = ws.cell(r, 6).value   # 最新完整年度分红 CNY
        tax = ws.cell(r, 12).value or 0.8
        if not all(isinstance(x, (int, float)) for x in [d, e, f]) or not name:
            continue
        denom = d * fx
        premium = e / denom - 1
        if premium < 0.20:
            continue
        hk_yld = f / denom
        rows.append({
            "name": name,
            "premium": premium,
            "a_yld":  f / e,
            "hk_yld": hk_yld,
            "hu_yld": hk_yld * 0.9,
            "gt_yld": hk_yld * tax,
        })
    rows.sort(key=lambda x: -x["premium"])
    return rows, fx


def build_hk_html(ws, date_str):
    rows, fx = _hk_collect(ws)
    avatar_src = _avatar_src()
    avatar_tag = f'<img class="avatar" src="{avatar_src}">' if avatar_src else '<div class="avatar"></div>'

    y, mo, d = (date_str.split("-") + ["", "", ""])[:3]
    date_disp = f"{y}年{int(mo)}月{int(d)}日" if y else date_str

    n_green  = sum(1 for r in rows if r["premium"] >= 0.30)
    n_orange = sum(1 for r in rows if 0.20 <= r["premium"] < 0.30)

    def stat(emoji, n, lbl):
        col, bg, _ = STATUS_COLORS[emoji]
        return (f'<div class="stat-box" style="background:{bg}">'
                f'<div class="stat-emoji">{emoji}</div>'
                f'<div class="stat-count" style="color:{col}">{n}支</div>'
                f'<div class="stat-lbl" style="color:{col}">{lbl}</div></div>')

    stats_html = stat("🟢", n_green, "≥30%") + stat("🟠", n_orange, "20-30%")

    rows_html = []
    for r in rows:
        emoji = "🟢" if r["premium"] >= 0.30 else "🟠"
        yields = [r["a_yld"], r["hk_yld"], r["hu_yld"], r["gt_yld"]]
        # 红框只比较 A股 vs 港股通（内地投资者实际二选一）
        hi_idx = 0 if r["a_yld"] >= r["gt_yld"] else 3
        cells = []
        for i, val in enumerate(yields):
            cls = "yc hi" if i == hi_idx else "yc"
            cells.append(f'<div class="{cls}">{val*100:.2f}%</div>')
        rows_html.append(
            f'<div class="row">'
            f'<span class="r-emoji">{emoji}</span>'
            f'<span class="r-name">{html_mod.escape(r["name"])}</span>'
            f'<span class="r-prem">+{r["premium"]*100:.2f}%</span>'
            f'{"".join(cells)}'
            f'</div>'
        )

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{
  --mono:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,"Roboto Mono",monospace;
  --sans:"PingFang SC","Noto Sans SC","Microsoft YaHei","Apple Color Emoji",sans-serif;
  --serif:"Songti SC","STSong",ui-serif,Georgia,"Times New Roman",serif;
  --clay:#B85C3E;
  width:{CARD_W}px;height:{CARD_H}px;overflow:hidden;
  background:#FFE552;color:#1a1200;
  font-family:var(--sans);
  padding:38px 44px 28px;
  display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;
}}

/* ── header ─────────────────────────── */
.hdr{{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}}
.hdr-left{{display:flex;align-items:center;gap:14px}}
.avatar{{width:56px;height:56px;border-radius:50%;object-fit:cover;border:3px solid rgba(0,0,0,0.18)}}
.uname{{font-size:22px;font-weight:700;color:#1a1200}}
.uhandle{{font-size:14px;color:#1a1200;margin-top:2px;font-family:var(--mono);letter-spacing:0.06em}}
.hdr-date{{font-size:18px;font-weight:600;color:#1a1200;text-align:right;font-family:var(--mono);letter-spacing:0.04em}}

/* ── eyebrow + title ────────────────── */
.eyebrow{{
  display:flex;align-items:center;gap:12px;
  font-family:var(--mono);font-size:15px;font-weight:700;
  letter-spacing:0.16em;text-transform:uppercase;
  color:#1a1200;margin:2px 0 6px;
}}
.eyebrow::before{{content:"";width:34px;height:3px;background:var(--clay);border-radius:2px}}
.title{{font-family:var(--serif);font-size:60px;font-weight:600;color:#1a1200;letter-spacing:-1.4px;line-height:1.0;margin-bottom:10px}}
.subtitle{{font-size:16px;color:#1a1200;margin-bottom:6px;line-height:1.45;font-family:var(--mono);letter-spacing:-0.2px}}
.note{{font-size:15px;color:#1a1200;margin-bottom:14px;line-height:1.4;background:rgba(255,255,255,0.4);border-radius:8px;padding:7px 12px}}

/* ── stats ──────────────────────────── */
.stats{{display:flex;gap:12px;margin-bottom:14px}}
.stat-box{{flex:1;border-radius:16px;padding:10px 6px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:1px}}
.stat-emoji{{font-size:22px;line-height:1;font-family:"Apple Color Emoji",sans-serif}}
.stat-count{{font-size:26px;font-weight:800;line-height:1}}
.stat-lbl{{font-size:13px;font-weight:600;opacity:0.85;font-family:var(--mono);letter-spacing:0.02em}}

/* ── table ──────────────────────────── */
.table{{flex:1;display:flex;flex-direction:column;background:rgba(255,255,255,0.78);border-radius:16px;padding:12px 18px}}
.hd{{display:flex;align-items:center;padding:6px 0 12px;border-bottom:2px solid rgba(0,0,0,0.16);font-size:14px;font-weight:700;color:#1a1200;font-family:var(--mono);letter-spacing:0.14em;text-transform:uppercase}}
.row{{flex:1;display:flex;align-items:center;border-bottom:1px solid rgba(0,0,0,0.18);font-size:21px}}
.row:last-child{{border-bottom:none}}
.r-emoji,.h-emoji{{flex:0 0 32px;font-size:18px;font-family:"Apple Color Emoji",sans-serif}}
.r-name{{flex:0 0 122px;font-weight:800;color:#1a1200}}
.h-name{{flex:0 0 122px}}
.r-prem{{flex:0 0 100px;font-weight:700;color:#dc2626;text-align:right;padding-right:6px;font-family:var(--mono);letter-spacing:-0.4px}}
.h-prem{{flex:0 0 100px;text-align:right;padding-right:6px;color:#1a1200;font-weight:700}}
.yc{{flex:1;text-align:center;padding:0 4px;font-weight:700;color:#1a1200;font-family:var(--mono);letter-spacing:-0.4px}}
.h-yc{{flex:1;text-align:center;padding:0 4px;color:#1a1200;font-weight:700}}
.yc.hi{{color:#dc2626;background:#fff;box-shadow:inset 0 0 0 2.5px #dc2626;border-radius:8px;padding:6px 4px}}

/* ── risk ───────────────────────────── */
.risk{{margin-top:12px;text-align:center;font-size:16px;font-weight:600;color:#5a2200;line-height:1.4;padding:10px 14px;background:rgba(255,255,255,0.55);border-radius:10px;border:1.5px dashed var(--clay)}}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-left">
    {avatar_tag}
    <div><div class="uname">股息观察</div><div class="uhandle">每日跟踪</div></div>
  </div>
  <div class="hdr-date">{date_disp}</div>
</div>
<div class="eyebrow"><span>港股观察 · 高溢价排名</span></div>
<div class="title">港股 A/H 高溢价排名</div>
<div class="subtitle">汇率 1 港元 = {fx} 人民币  ·  共 {len(rows)} 支（按溢价率降序）</div>
<div class="note">港户 = 港股股息率 × 0.9（扣 10% 红利税）　|　港股通 = 港股股息率 × 0.8 或 0.72（扣 20%/28%）　|　红色框为 A股 vs 港股通 中较高（内地投资者视角）</div>
<div class="stats">{stats_html}</div>
<div class="table">
  <div class="hd">
    <div class="h-emoji"></div>
    <div class="h-name">股票</div>
    <div class="h-prem">A/H溢价</div>
    <div class="h-yc">A股</div>
    <div class="h-yc">港股</div>
    <div class="h-yc">港户</div>
    <div class="h-yc">港股通</div>
  </div>
  {"".join(rows_html)}
</div>
<div class="risk">⚠️ 数据为估算值，未考虑分红预案变更、汇率波动、流动性、税制调整等风险，仅供参考，不构成投资建议</div>
</body></html>"""


def render_hk_card(ws, output_path: Path, date_str: str) -> None:
    _screenshot(build_hk_html(ws, date_str), output_path)
