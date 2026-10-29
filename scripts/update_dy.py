#!/usr/bin/env python3
"""
每日分红跟踪表更新脚本

缓存策略：
  - A股/港股价格：休市 且 缓存是收盘后获取的 → 复用缓存；否则实时获取
    A股收盘：工作日 15:00 | 港股收盘：工作日 16:00
  - 分红事件：12 小时缓存
"""

import openpyxl
from openpyxl.styles import PatternFill, Font
import urllib.request
import json
import ssl
import time
import datetime
import re
import requests
import os
import math
from pathlib import Path

_DIR = Path(__file__).parent
FILE_PATH  = str(_DIR.parent / 'data' / 'daily-dy.xlsx')
CACHE_FILE = str(_DIR / '.dy_cache.json')
DIV_CACHE_HOURS = 12

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

FILL_GREEN  = PatternFill(start_color='75FB4C', end_color='75FB4C', fill_type='solid')
FILL_BLUE   = PatternFill(start_color='C2D6EC', end_color='C2D6EC', fill_type='solid')
FILL_ORANGE = PatternFill(start_color='F1CDB1', end_color='F1CDB1', fill_type='solid')
FILL_CLEAR  = PatternFill(fill_type=None)
FONT_YAHEI  = Font(name='微软雅黑', size=12)

HEADER_DIV_DATE = '最近除息日'

# ─── 缓存 ────────────────────────────────────────────────────────

CACHE: dict = {}

def load_cache():
    global CACHE
    try:
        with open(CACHE_FILE) as f:
            CACHE = json.load(f)
    except Exception:
        CACHE = {}

def save_cache():
    with open(CACHE_FILE, 'w') as f:
        json.dump(CACHE, f, ensure_ascii=False, indent=2)

def cache_fresh(ts, hours):
    return ts is not None and (time.time() - ts) < hours * 3600

def is_market_open(market='ashare'):
    """开市时段视为「连续开市」（含午盘休市），用于缓存判断。
    9:30 前 / 收盘后 / 周末 / 节假日才算闭市。"""
    now = datetime.datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    if market == 'ashare':
        return datetime.time(9, 30) <= t <= datetime.time(15, 0)
    else:  # hkstock
        return datetime.time(9, 30) <= t <= datetime.time(16, 0)

def last_close_ts(close_hour, market='ashare'):
    """
    返回最近一次收盘时间的 unix timestamp。
    从今天往前找最近一个工作日的 close_hour:00，且该时间点已过。
    """
    now = datetime.datetime.now()
    for days_back in range(0, 7):
        candidate = datetime.datetime.combine(
            now.date() - datetime.timedelta(days=days_back),
            datetime.time(close_hour, 0, 0)
        )
        if candidate.weekday() < 5 and candidate <= now:
            return candidate.timestamp()
    return 0

def price_cache_valid(market='ashare'):
    """
    股价缓存有效条件：当前休市 且 缓存时间戳 >= 最近一次收盘时间。
    即：价格是收盘后才抓的，休市期间不会再变，可以复用。
    """
    if is_market_open(market):
        return False
    sec = CACHE.get('ashare_prices' if market == 'ashare' else 'hk_prices', {})
    ts = sec.get('ts')
    if not ts or not sec.get('data'):
        return False
    close_hour = 15 if market == 'ashare' else 16
    return ts >= last_close_ts(close_hour, market)


def ashare_price_date():
    """返回 A 股行情实际所属交易日，缺失时回退到最近一个工作日。"""
    value = CACHE.get('ashare_prices', {}).get('date')
    if value:
        try:
            return datetime.date.fromisoformat(value)
        except ValueError:
            pass
    result = datetime.date.today()
    if datetime.datetime.now().time() < datetime.time(9, 30):
        result -= datetime.timedelta(days=1)
    while result.weekday() >= 5:
        result -= datetime.timedelta(days=1)
    return result

# ─── HTTP ────────────────────────────────────────────────────────

def http_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=12, context=ctx) as r:
        return r.read()

# ─── A股价格（腾讯 API 批量）────────────────────────────────────

def exchange_prefix(code):
    return 'sh' if str(code).zfill(6)[0] == '6' else 'sz'

def _fetch_ashare_prices_batch(codes):
    """Use Tencent quotes directly for workbook symbols."""
    print('  [腾讯 qt.gtimg.cn] 按表格股票代码批量获取行情', flush=True)
    return _fetch_ashare_prices_legacy(codes)


def _fetch_ashare_prices_legacy(codes):
    """返回 {code6: (price, pct_chg, trade_date)}。
    pct_chg 是腾讯接口字段 v[32]（百分比小数，如 +0.25 表示 +0.25%）；
    除权日昨收已自动用除权后基准，所以涨跌幅天然是除权后真实涨跌。"""
    symbols = [f'{exchange_prefix(c)}{str(c).zfill(6)}' for c in codes]
    url = f'https://qt.gtimg.cn/q={",".join(symbols)}'
    try:
        raw = http_get(url).decode('gbk')
        result = {}
        for line in raw.strip().split('\n'):
            if '~' not in line or '"' not in line:
                continue
            fields = line.split('"')[1].split('~')
            if len(fields) > 3:
                code6 = fields[2].zfill(6)
                try:
                    price = float(fields[3])
                except ValueError:
                    continue
                pct = None
                if len(fields) > 32:
                    try:
                        pct = float(fields[32]) / 100  # 百分比 → 小数
                    except ValueError:
                        pass
                trade_date = None
                if len(fields) > 30 and re.fullmatch(r'\d{8}(?:\d{6})?', fields[30]):
                    trade_date = datetime.datetime.strptime(fields[30][:8], '%Y%m%d').date().isoformat()
                result[code6] = (price, pct, trade_date)
        return result
    except Exception as e:
        print(f'  [错误] A股批量价格: {e}')
        return {}

def get_ashare_prices(codes):
    """每轮在线获取最新报价；旧快照仅在请求失败时保留。
    同时把腾讯接口的当日涨跌幅写进 CACHE['ashare_pct_chg']（除权日已自动按
    除权后基准价计算，无需额外修正）。"""
    sec = CACHE.setdefault('ashare_prices', {})
    print(f'【A股价格】在线检查，批量获取 {len(codes)} 支...')
    batch = _fetch_ashare_prices_batch(codes)
    prices = {k: v[0] for k, v in batch.items()}
    pcts   = {k: v[1] for k, v in batch.items() if v[1] is not None}
    trade_dates = [v[2] for v in batch.values() if v[2]]
    print(f'  成功获取 {len(prices)} 支（含涨跌幅 {len(pcts)}）')
    now_ts = time.time()
    # Failed/incomplete batches must not replace valid cached prices or mark
    # a partial response as a complete fresh snapshot.
    expected = {str(c).zfill(6) for c in codes}
    complete = expected.issubset(prices)
    if not complete:
        print(f'  [待核实] {",".join(sorted(expected-set(prices)))} 本轮报价缺失，保留旧价格')
    sec['data'] = {**sec.get('data', {}), **prices}
    if complete:
        sec['ts'] = now_ts
    if trade_dates:
        sec['date'] = max(trade_dates)
    pct_sec = CACHE.setdefault('ashare_pct_chg', {})
    pct_sec['ts'] = now_ts
    pct_sec['data'] = pcts
    return sec['data']

# ─── A股 除息日（东方财富）──────────────────────────────────────

class DivFetchError(Exception):
    """除息日/价格拉取因网络等异常失败（区别于"确实无分红"返回 None）。"""

def _fetch_ashare_div(code6):
    url = (
        'https://datacenter-web.eastmoney.com/api/data/v1/get'
        '?reportName=RPT_SHAREBONUS_DET&columns=ALL'
        f'&filter=(SECURITY_CODE=%22{code6}%22)'
        '&pageNumber=1&pageSize=20'
        '&sortColumns=REPORT_DATE&sortTypes=-1'
    )
    try:
        from data_sources import cached_dividends
        cached = cached_dividends(code6)
        if cached is not None:
            records = cached[0]
        else:
            data = json.loads(http_get(url))
            records = (data.get('result') or {}).get('data') or []
        cur_year = str(datetime.datetime.now().year)
        def _ex_date(rec):
            """返回除息日：有 EX_DIVIDEND_DATE 直接用；只有 EQUITY_RECORD_DATE 则 +1天。"""
            ex = rec.get('EX_DIVIDEND_DATE')
            if ex:
                return ex[:10]
            eq = rec.get('EQUITY_RECORD_DATE')
            if eq:
                d = datetime.date.fromisoformat(eq[:10]) + datetime.timedelta(days=1)
                return d.isoformat()
            return None

        # 优先：最近一个「未来」除息日（>=今天），无论进度是实施分配还是董事会/股东大会通过。
        # 这样像中国平安这类「当年已实施末期分红 + 已公告中期分红」的股票，
        # 不会因先命中已过去的末期除息日而漏掉即将到来的中期除息日。
        today = datetime.date.today().isoformat()
        upcoming = []
        for rec in records:
            date_str = _ex_date(rec)
            if date_str and date_str >= today:
                upcoming.append((date_str, _parse_dps(rec)))
        if upcoming:
            upcoming.sort(key=lambda x: x[0])  # 取最近的未来除息日
            return upcoming[0]
        # 次选：当年已实施的最近一笔（除息日已过），避免整列为空
        for rec in records:
            if rec.get('ASSIGN_PROGRESS') == '实施分配':
                date_str = _ex_date(rec)
                if date_str and date_str[:4] == cur_year:
                    return date_str, _parse_dps(rec)
    except Exception as e:
        print(f'  [错误] {e}')
        raise DivFetchError(str(e)) from e
    return None, None

# ─── 港股（Yahoo Finance）────────────────────────────────────────

def hk_ticker(hk_code):
    digits = str(hk_code).lstrip('0') or '0'
    return digits.zfill(4) + '.HK'

def _fetch_hk_info(hk_code):
    """返回 (价格 HKD, 除息日 str|None)。"""
    ticker = hk_ticker(hk_code)
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
           '?interval=1d&range=3y&events=div')
    try:
        data = json.loads(http_get(url))
        result = (data.get('chart') or {}).get('result') or []
        if not result:
            raise ValueError('Yahoo未返回该港股的行情数据')
        price = result[0].get('meta', {}).get('regularMarketPrice')
        divs = (result[0].get('events') or {}).get('dividends') or {}
        div_date = None
        if divs:
            ts = max(divs, key=lambda x: int(x))
            dt = datetime.datetime.fromtimestamp(int(ts))
            if dt.year == datetime.datetime.now().year:
                div_date = dt.strftime('%Y-%m-%d')
        return price, div_date
    except Exception as e:
        print(f'  [错误] 港股 {hk_code}: {e}')
        raise DivFetchError(str(e)) from e

# ─── 工具 ────────────────────────────────────────────────────────

def find_or_create_header_col(ws, header, after_col):
    for col in range(1, ws.max_column + 1):
        if ws.cell(row=1, column=col).value == header:
            return col
    new_col = after_col + 1
    ws.cell(row=1, column=new_col).value = header
    return new_col

def fit_col_widths_by_header(ws):
    """按第一行表头内容自适应列宽（CJK 字符按 2.6 倍宽计，ASCII 1.2 倍）。"""
    for col in range(1, ws.max_column + 1):
        header = ws.cell(1, col).value
        if header is None:
            continue
        width = sum(2.6 if ord(c) > 127 else 1.2 for c in str(header)) + 3
        col_letter = openpyxl.utils.get_column_letter(col)
        ws.column_dimensions[col_letter].width = max(width, 6)

def gh_fill(gh_val):
    if not isinstance(gh_val,(int,float)) or isinstance(gh_val,bool) or not math.isfinite(gh_val):
        return FILL_CLEAR
    if gh_val >= 0:
        return FILL_GREEN
    elif gh_val >= -0.0025:
        return FILL_BLUE
    elif gh_val >= -0.003:
        return FILL_ORANGE
    return FILL_CLEAR

# ─── Sheet 更新 ──────────────────────────────────────────────────

def update_ashare_sheet(wb, wb_val, ashare_prices):
    ws_val = wb_val['股票数据']
    ws = wb['股票数据']

    div_sec   = CACHE.setdefault('ashare_dividends', {})
    div_data  = div_sec.setdefault('data', {})
    div_fresh = False  # 分红使用本轮刚在线获取的明细，旧时间戳不跳过检查
    fetched_any_div = False
    div_error = False

    rows_data = []
    for row_idx in range(2, ws_val.max_row + 1):
        code  = ws_val.cell(row=row_idx, column=3).value
        name  = ws_val.cell(row=row_idx, column=2).value
        div_e = ws_val.cell(row=row_idx, column=5).value
        tgt_h = ws_val.cell(row=row_idx, column=8).value
        old_d = ws_val.cell(row=row_idx, column=4).value
        if code is None:
            continue
        rows_data.append((row_idx, code, name, div_e, tgt_h, old_d))

    div_col = find_or_create_header_col(ws, HEADER_DIV_DATE, after_col=13)
    status = f'分红{"缓存" if div_fresh else "实时"}'
    print(f'【股票数据】价格/颜色/{status} → 除息日第 {div_col} 列\n')

    for row_idx, code, name, div_e, tgt_h, old_d in rows_data:
        code6 = str(code).strip().zfill(6)
        new_price = ashare_prices.get(code6, old_d)

        if new_price:
            ws.cell(row=row_idx, column=4).value = new_price

        valid=all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
                  for v in (div_e,new_price,tgt_h))
        gh = div_e/new_price-tgt_h if valid and new_price>0 and tgt_h>=0 else None
        if ws_val.cell(row_idx, 14).value == '待核实':
            gh = None
        fill = gh_fill(gh)
        for col_idx in range(2, 13):  # B–L，跳过 A(板块)
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.fill = fill
            cell.font = FONT_YAHEI

        if div_fresh and code6 in div_data:
            entry = div_data[code6]
            tag = '(缓存)'
        else:
            try:
                div_date, div_dps = _fetch_ashare_div(code6)
                entry = {'date': div_date, 'dps': div_dps}
                div_data[code6] = entry
                fetched_any_div = True
                tag = ''
            except DivFetchError:
                # 拉取失败：保留旧缓存值，不污染缓存；本轮不刷新 ts，下次重试
                entry = div_data.get(code6, {'date': None, 'dps': None})
                div_error = True
                tag = '(失败·留旧)'
            from data_sources import cached_dividends
            if cached_dividends(code6) is None:
                time.sleep(0.3)
        # 兼容旧缓存（纯日期字符串）
        div_date = entry.get('date') if isinstance(entry, dict) else entry

        print(f'  {str(name):8s} ({code6}) → {div_date or "—"} {tag}')
        ws.cell(row=row_idx, column=div_col).value = div_date

    if fetched_any_div and not div_error:
        div_sec['ts'] = time.time()


def update_hkstock_sheet(wb, wb_val, ashare_prices):
    ws2_val = wb_val['港股数据']
    ws2 = wb['港股数据']

    price_data = CACHE.setdefault('hk_prices', {}).setdefault('data', {})
    div_sec    = CACHE.setdefault('hk_dividends', {})
    div_data   = div_sec.setdefault('data', {})
    div_fresh = False
    hk_price_valid = False  # 最新价格及分红日期每次在线检查
    fetched_any = False
    div_error = False

    div_col = find_or_create_header_col(ws2, HEADER_DIV_DATE, after_col=11)
    status = f'分红{"缓存" if div_fresh else "实时"} | 价格{"缓存(收盘后)" if hk_price_valid else "实时"}'
    print(f'\n【港股数据】{status} → 除息日第 {div_col} 列\n')

    for row_idx in range(2, ws2_val.max_row + 1):
        hk_code = ws2_val.cell(row=row_idx, column=2).value
        a_code  = ws2_val.cell(row=row_idx, column=3).value
        name    = ws2_val.cell(row=row_idx, column=1).value
        if hk_code is None or not isinstance(name, str) or str(name).startswith('='):
            continue

        key = str(hk_code)
        need_price = not hk_price_valid or key not in price_data
        need_div   = not div_fresh or key not in div_data

        if need_price or need_div:
            print(f'  {str(name):8s} ({hk_code})', end=' → ')
            try:
                hk_price, div_date = _fetch_hk_info(hk_code)
                if hk_price is not None:
                    price_data[key] = hk_price
                else:
                    hk_price = price_data.get(key)   # 无数据时回退缓存
                div_data[key] = div_date
                fetched_any = True
            except DivFetchError:
                # 拉取异常：价格与除息日均回退缓存，不污染；本轮不刷新 ts
                hk_price = price_data.get(key)
                div_date = div_data.get(key)
                div_error = True
            print(f'H={hk_price}  除息={div_date or "—"}')
            time.sleep(0.5)
        else:
            hk_price = price_data[key]
            div_date = div_data[key]
            print(f'  {str(name):8s} ({hk_code}) → H={hk_price}  除息={div_date or "—"} (缓存)')

        if hk_price:
            ws2.cell(row=row_idx, column=4).value = round(hk_price, 4)
        if a_code:
            a_price = ashare_prices.get(str(a_code).strip().zfill(6))
            if a_price:
                ws2.cell(row=row_idx, column=5).value = a_price
        ws2.cell(row=row_idx, column=div_col).value = div_date

    if fetched_any and not div_error:
        CACHE['hk_prices']['ts'] = time.time()
        div_sec['ts'] = time.time()

    _update_hk_derived(ws2, wb_val)

def _fetch_hkd_cny_rate():
    """实时 HKD→CNY 汇率；失败返回 None"""
    try:
        r = requests.get('https://open.er-api.com/v6/latest/HKD', timeout=8).json()
        rate = r.get('rates', {}).get('CNY')
        if rate and 0.5 < rate < 1.5:
            return round(rate, 4)
    except Exception:
        pass
    return None


def _find_col_by_header(ws, header):
    for col in range(1, ws.max_column + 1):
        if ws.cell(1, col).value == header:
            return col
    return None


def _update_hk_derived(ws2, wb_val):
    """更新港股数据派生列：实时汇率、F 列分红（从股票数据复制）、
    按 A/H 溢价率降序重排，所有公式列按新行号重写。"""
    from openpyxl.utils import get_column_letter

    # 1. 汇率：找到 '汇率' 标签列，值在右邻列
    fx_label_col = _find_col_by_header(ws2, '汇率')
    if fx_label_col:
        fx_value_col = fx_label_col + 1
        new_rate = _fetch_hkd_cny_rate()
        old_rate = ws2.cell(1, fx_value_col).value
        if new_rate:
            ws2.cell(1, fx_value_col).value = new_rate
            print(f'  汇率 {old_rate} → {new_rate} (HKD→CNY 实时)')
        else:
            print(f'  汇率获取失败，沿用 {old_rate}')
        fx_addr = f'${get_column_letter(fx_value_col)}$1'
        fx = ws2.cell(1, fx_value_col).value
    else:
        fx_addr, fx = '$O$1', 0.8684

    # 2. 股票数据 → A股代码 → 最新已披露完整年度每股股息
    ws_a_val = wb_val['股票数据']
    a_div_map = {}
    for r in range(2, ws_a_val.max_row + 1):
        code = ws_a_val.cell(r, 3).value
        div  = ws_a_val.cell(r, 5).value
        if code is not None and div is not None:
            a_div_map[str(code).strip().zfill(6)] = div

    # 3. 列索引（按表头名查找，缺失则跳过相关写入）
    c_d = _find_col_by_header(ws2, 'H股价格HKD')
    c_e = _find_col_by_header(ws2, 'A股价格CNY')
    c_f = _find_col_by_header(ws2, '最新年度分红（RMB）') or _find_col_by_header(ws2, '25年分红（RMB）')
    c_g = _find_col_by_header(ws2, 'A/H溢价率')
    c_h = _find_col_by_header(ws2, 'A股股息率')
    c_i = _find_col_by_header(ws2, '港股股息率')
    c_j = _find_col_by_header(ws2, '港户股息率')
    c_k = _find_col_by_header(ws2, '港股通股息率')
    c_l = _find_col_by_header(ws2, '港股通税率')
    c_m = _find_col_by_header(ws2, '最近除息日')

    if not (c_d and c_e and c_g):
        return  # 关键列缺失，不动

    # 4. 读所有数据行 + 计算 G，收集静态列值
    static_cols = [c for c in [1, 2, 3, c_d, c_e, c_f, c_l, c_m] if c]
    rows = []
    for r in range(2, ws2.max_row + 1):
        d = ws2.cell(r, c_d).value
        e = ws2.cell(r, c_e).value
        if not isinstance(d, (int, float)) or not isinstance(e, (int, float)):
            continue
        # F 列用股票数据覆盖
        if c_f:
            a_code = ws2.cell(r, 3).value
            if a_code is not None:
                key = str(a_code).strip().zfill(6)
                if key in a_div_map:
                    ws2.cell(r, c_f).value = a_div_map[key]
        g_val = e / (d * fx) - 1
        statics = {c: ws2.cell(r, c).value for c in static_cols}
        rows.append((g_val, statics))

    # 5. 按 G 降序排
    rows.sort(key=lambda x: -x[0])

    # 6. 清空数据区并按新顺序重写（含所有公式列）
    for r in range(2, ws2.max_row + 1):
        for c in range(1, ws2.max_column + 1):
            ws2.cell(r, c).value = None

    def cl(c): return get_column_letter(c)
    for i, (g_val, statics) in enumerate(rows):
        nr = i + 2
        for c, v in statics.items():
            ws2.cell(nr, c).value = v
        if c_g:
            ws2.cell(nr, c_g).value = f'={cl(c_e)}{nr}/({cl(c_d)}{nr}*{fx_addr})-1'
            if g_val >= 0.30:
                row_fill = FILL_GREEN
            elif g_val >= 0.20:
                row_fill = FILL_ORANGE
            else:
                row_fill = FILL_CLEAR
            for col in range(1, 12):  # A 到 K
                ws2.cell(nr, col).fill = row_fill
        if c_h and c_f:
            ws2.cell(nr, c_h).value = f'={cl(c_f)}{nr}/{cl(c_e)}{nr}'
        if c_i and c_f:
            ws2.cell(nr, c_i).value = f'={cl(c_f)}{nr}/({cl(c_d)}{nr}*{fx_addr})'
        if c_j and c_h:
            ws2.cell(nr, c_j).value = f'={cl(c_h)}{nr}*(1+{cl(c_g)}{nr})*0.9'
        if c_k and c_h and c_l:
            ws2.cell(nr, c_k).value = f'={cl(c_h)}{nr}*(1+{cl(c_g)}{nr})*{cl(c_l)}{nr}'

# ─── 分红检查 ────────────────────────────────────────────────────

# Annual periods are selected from the latest disclosed year-end report.
# No unscoped manual additions: stale adjustments can duplicate dividends.


def _parse_dps(item):
    profile = str(item.get("IMPL_PLAN_PROFILE", "") or "")
    m = re.search(r"10派(\d+\.?\d*)", profile)
    if m:
        return float(m.group(1)) / 10
    pretax = item.get("PRETAX_BONUS_RMB")
    return float(pretax) / 10 if pretax else 0.0


def _fetch_div_ashare(code):
    """东方财富：返回 (impl, ann, impl_date, ann_date)
    impl/ann 为年度合计每股分红，date 为最近一笔的除息日或报告期。"""
    url = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    params = {
        "reportName": "RPT_SHAREBONUS_DET",
        "columns": "ALL",
        "filter": f'(SECURITY_CODE="{code}")',
        "pageNumber": 1, "pageSize": 50,
        "sortColumns": "REPORT_DATE", "sortTypes": -1,
    }
    try:
        from data_sources import cached_dividends
        cached = cached_dividends(code)
        items = cached[0] if cached is not None else requests.get(url, params=params, timeout=10).json() \
                        .get("result", {}).get("data") or []
    except Exception:
        return None, None, None, None

    from rolling_dividend import select_annual, supplement_missing
    try:
        annual = select_annual(supplement_missing(items, code))
    except ValueError:
        return None, None, None, None
    impl_parts = [p for p in annual['parts'] if p['implemented']]
    ann_parts = [p for p in annual['parts'] if not p['implemented']]
    return (sum(p['dps'] for p in impl_parts) if impl_parts else None,
            sum(p['dps'] for p in ann_parts) if ann_parts else None,
            max((p['date'] for p in impl_parts), default=None),
            max((p['date'] for p in ann_parts), default=None))


def _fetch_div_hkshare(code_raw):
    """Yahoo Finance：返回 (impl, None, impl_date, None)"""
    ticker = str(code_raw).strip().zfill(4) + ".HK"
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    try:
        data = requests.get(url, params={"interval": "1d", "range": "10y", "events": "div"},
                            headers={"User-Agent": "Mozilla/5.0"}, timeout=10).json()
        divs = data["chart"]["result"][0]["events"]["dividends"]
    except Exception:
        return None, None, None, None

    total = 0.0
    latest_date = None
    for v in divs.values():
        if datetime.datetime.fromtimestamp(v["date"]).year == datetime.date.today().year - 1:
            total += v["amount"]
            latest_date = datetime.datetime.fromtimestamp(v["date"]).strftime("%Y-%m-%d")
    return (total if total > 0 else None), None, latest_date, None


def check_dividends(wb_val):
    """遍历股票数据，返回分红结论"""
    ws = wb_val["股票数据"]

    # F=1：已确认，按核查结果分组
    ok, up, down, no_data = [], [], [], []
    # F=0：未确认，按是否有新公告分组；has_ann 存 (sort_date, text) 供排序
    has_ann, no_ann = [], []

    for ri in range(2, ws.max_row + 1):
        name     = ws.cell(row=ri, column=2).value
        code_raw = ws.cell(row=ri, column=3).value
        estimate = ws.cell(row=ri, column=5).value
        flag     = ws.cell(row=ri, column=6).value

        if not name or not code_raw:
            continue

        code_str = str(code_raw).strip()
        is_hk    = len(code_str) <= 5 and not code_str.startswith("6")
        code_fmt = code_str.zfill(5 if is_hk else 6)
        if ws.cell(ri, 14).value == '待核实':
            no_data.append(f"  {name}({code_fmt})：最新年度数据待核实，未沿用旧值判断")
            continue
        fetch    = _fetch_div_hkshare if is_hk else _fetch_div_ashare
        impl, ann, impl_date, ann_date = fetch(code_raw if is_hk else code_fmt)

        if flag == 1:
            annual = (impl or 0) + (ann or 0)
            actual = annual if impl is not None or ann is not None else None
            if actual is None or not isinstance(estimate, (int, float)):
                no_data.append(f"  {name}({code_fmt})：暂无数据")
                continue
            if estimate == 0:
                if actual == 0:
                    ok.append(f"  {name}({code_fmt})")
                else:
                    up.append(f"  {name}({code_fmt})：表格为0元，接口合计{actual:.3f}元，请核实")
                continue
            diff_pct = (actual - estimate) / estimate * 100
            if abs(diff_pct) < 1:
                ok.append(f"  {name}({code_fmt})")
            else:
                detail = []
                if impl: detail.append(f"已实施 {impl:.3f}")
                if ann:  detail.append(f"已公告 {ann:.3f}")
                line = (f"  {name}({code_fmt})\n"
                        f"    表格股息：{estimate:.3f} 元\n"
                        f"    接口获取：{actual:.3f} 元（{'，'.join(detail)}）\n"
                        f"    差异：{diff_pct:+.1f}%")
                if diff_pct > 0:
                    up.append(line)
                else:
                    down.append(line)
        else:
            cur_year = str(datetime.datetime.now().year)
            # 只看当年（除息日/公告日在当年）的分红
            impl_cur = impl if impl_date and impl_date.startswith(cur_year) else None
            ann_cur  = ann  if ann_date  and ann_date.startswith(cur_year)  else None
            if impl_cur or ann_cur:
                actual = (impl_cur or 0) + (ann_cur or 0)
                lines = [f"  {name}({code_fmt})"]
                if impl_cur: lines.append(f"    已实施：{impl_cur:.3f} 元（{impl_date}）")
                if ann_cur:  lines.append(f"    已公告：{ann_cur:.3f} 元（{ann_date}）")
                if impl_cur and ann_cur:
                    lines.append(f"    合计：  {actual:.3f} 元")
                if estimate:
                    diff_pct = (actual - estimate) / estimate * 100
                    lines.append(f"    表格预估：{estimate:.3f} 元  差异：{diff_pct:+.1f}%")
                sort_date = impl_date or ann_date or ""
                has_ann.append((sort_date, "\n".join(lines)))
            else:
                no_ann.append(f"  {name}({code_fmt})")

    parts = []

    # ── 问题一：已确认的数值对不对 ──
    parts.append(f"{'='*48}")
    parts.append("口径：每家公司最新已披露完整年度，所属年度见表格N列；不按到账年份归集。")
    parts.append(f"一、已实施股票（F=1）年度合计核查  共{len(ok)+len(up)+len(down)+len(no_data)}支")
    parts.append(f"{'='*48}")
    if ok:
        parts.append(f"✓ 与最新年度股息一致（{len(ok)}支）：" + "、".join(s.strip() for s in ok))
    if up:
        parts.append(f"\n↑ 高于表格股息（{len(up)}支）")
        parts.extend(up)
    if down:
        parts.append(f"\n↓ 低于表格股息（{len(down)}支）")
        parts.extend(down)
    if no_data:
        parts.append(f"\n? 暂无数据（{len(no_data)}支）")
        parts.extend(no_data)

    # ── 问题二：未确认的是否有新公告 ──
    parts.append(f"\n{'='*48}")
    parts.append(f"二、未确认股票（F=0）新公告检查  共{len(has_ann)+len(no_ann)}支")
    parts.append(f"{'='*48}")
    if has_ann:
        has_ann.sort(key=lambda x: x[0], reverse=True)
        parts.append(f"★ 有新分红公告（{len(has_ann)}支）")
        parts.extend(text for _, text in has_ann)
    if no_ann:
        parts.append(f"\n— 暂无新公告（{len(no_ann)}支）")
        parts.extend(no_ann)

    return "\n".join(parts)


# ─── 股息率日报 Markdown ─────────────────────────────────────────

def _update_prev_ashare():
    """管理前一交易日收盘价缓存。

    两步：
    1. 把前日 closing_snapshot 升级为 prev_ashare_prices（次日首次运行时触发）
    2. 收盘后（≥15:00）把当日价格存入 closing_snapshot（每天只存一次）
    """
    today = datetime.date.today()
    now   = datetime.datetime.now()

    # 1. 前日快照 → prev
    snap = CACHE.get("closing_snapshot", {})
    snap_date_str = snap.get("date")
    if snap_date_str and datetime.date.fromisoformat(snap_date_str) < today:
        prev = CACHE.get("prev_ashare_prices", {})
        if prev.get("date") != snap_date_str:
            CACHE["prev_ashare_prices"] = {
                "ts":   snap.get("ts"),
                "date": snap_date_str,
                "data": dict(snap["data"]),
            }
            print(f'【prev A股】升级快照 {snap_date_str} → prev（{len(snap["data"])} 支）')

    # 2. 收盘后保存今日收盘快照（要求 ashare_prices 是今天 15:00 之后抓的；
    #    允许同日内多次覆盖，以 ts 较新者为准）
    if now.time() >= datetime.time(15, 0):
        curr = CACHE.get("ashare_prices", {})
        curr_ts = curr.get("ts")
        if curr_ts and curr.get("data"):
            curr_dt = datetime.datetime.fromtimestamp(float(curr_ts))
            if curr_dt.date() == today and curr_dt.time() >= datetime.time(15, 0):
                existing_ts = float(CACHE.get("closing_snapshot", {}).get("ts") or 0)
                if float(curr_ts) > existing_ts:
                    CACHE["closing_snapshot"] = {
                        "ts":   curr_ts,
                        "date": today.isoformat(),
                        "data": dict(curr["data"]),
                    }
                    print(f'【closing A股】已保存今日收盘快照（{len(curr["data"])} 支，{curr_dt.strftime("%H:%M")}）')


def _yield_status(gh):
    if gh is None:    return "—"
    if gh >= 0:       return "🟢"
    if gh >= -0.0025: return "🔵"
    if gh >= -0.003:  return "🟠"
    return "⚪"


def _build_yield_rows(ws, as_of_date):
    """从「股票数据」sheet 构建股息率行数据，供 Markdown 报告和卡片共用。"""
    prev = CACHE.get("prev_ashare_prices", {}).get("data", {})
    api_pct_chg = CACHE.get("ashare_pct_chg", {}).get("data", {})

    rows = []
    cur_sector = None
    for ri in range(2, ws.max_row + 1):
        sec   = ws.cell(row=ri, column=1).value
        if sec:
            cur_sector = sec
        name     = ws.cell(row=ri, column=2).value
        code     = ws.cell(row=ri, column=3).value
        price    = ws.cell(row=ri, column=4).value
        div_e    = ws.cell(row=ri, column=5).value
        tgt_h    = ws.cell(row=ri, column=8).value
        ex_date  = ws.cell(row=ri, column=12).value
        if not name or not price or div_e is None or ws.cell(ri, 14).value == '待核实':
            continue
        code6      = str(code).strip().zfill(6)
        div_entry  = CACHE.get("ashare_dividends", {}).get("data", {}).get(code6)
        div_dps    = div_entry.get("dps") if isinstance(div_entry, dict) else None
        curr_yield = div_e / price
        gh         = curr_yield - tgt_h if tgt_h else None
        status     = _yield_status(gh)
        prev_price = float(prev[code6]) if prev.get(code6) else None
        prev_yield = div_e / prev_price if prev_price else None
        prev_gh    = prev_yield - tgt_h if (prev_yield and tgt_h) else None
        prev_st    = _yield_status(prev_gh) if prev_price else None
        # 涨跌幅优先用腾讯接口（除权日已自动按除权后基准），无则回退到两日对比
        api_pct = api_pct_chg.get(code6)
        if api_pct is not None:
            pct_chg = api_pct
        elif prev_price:
            pct_chg = (price - prev_price) / prev_price
        else:
            pct_chg = None
        today_str = as_of_date.isoformat()
        is_ex_today = ex_date and str(ex_date)[:10] == today_str
        rows.append(dict(
            name=name, code=code6, price=price, sector=cur_sector,
            curr_yield=curr_yield, tgt_h=tgt_h, gh=gh, status=status,
            prev_price=prev_price, prev_yield=prev_yield,
            prev_st=prev_st, pct_chg=pct_chg, ex_date=ex_date,
            is_ex_today=is_ex_today, div_dps=div_dps, div_e=div_e,
        ))
    return rows


def _stats_line(rows):
    """概览一行（含昨日对比），主卡片和除息日独立卡片共用。"""
    cnt      = {"🟢": 0, "🔵": 0, "🟠": 0, "⚪": 0}
    prev_cnt = {"🟢": 0, "🔵": 0, "🟠": 0, "⚪": 0}
    for r in rows:
        cnt[r["status"]] = cnt.get(r["status"], 0) + 1
        if r["prev_st"]:
            prev_cnt[r["prev_st"]] = prev_cnt.get(r["prev_st"], 0) + 1
    has_prev_cnt = any(prev_cnt.values())
    parts = []
    for sym in ["🟢", "🔵", "🟠", "⚪"]:
        delta = cnt[sym] - prev_cnt.get(sym, 0)
        delta_str = f"({'+'if delta>0 else ''}{delta})" if (has_prev_cnt and delta != 0) else ""
        parts.append(f"{sym} {cnt[sym]}支{delta_str}")
    return "  ".join(parts)


def generate_yield_markdown(wb_val):
    """生成股息率日报 Markdown：概览 + 颜色跃迁 + 今日大涨大跌 + 近期除息日。"""
    ws   = wb_val["股票数据"]
    as_of_date = ashare_price_date()
    rows = _build_yield_rows(ws, as_of_date)
    summary = _stats_line(rows)

    lines = [
        f"# 股息率日报 — {as_of_date.isoformat()}",
        "",
        summary,
        "",
    ]

    has_prev = any(r["prev_price"] for r in rows)
    if not has_prev:
        lines.extend([
            "## 首次运行",
            "",
            "- 已记录今日收盘价；明日起将展示颜色跃迁和涨跌幅对比。",
            "",
        ])

    # ── 颜色跃迁 ──
    transitions = [r for r in rows if r["prev_st"] and r["prev_st"] != r["status"]]
    _ST_LEVEL = {"🟢": 3, "🔵": 2, "🟠": 1, "⚪": 0}
    if transitions:
        lines.append("## 颜色跃迁")
        lines.append("")
        improving = [r for r in transitions if _ST_LEVEL.get(r["status"], 0) > _ST_LEVEL.get(r["prev_st"], 0)]
        worsening = [r for r in transitions if _ST_LEVEL.get(r["status"], 0) < _ST_LEVEL.get(r["prev_st"], 0)]

        def _fmt_transition(r):
            pct   = f"{r['pct_chg']:+.2%}" if r["pct_chg"] is not None else "—"
            diff  = f"{r['gh'] * 100:+.2f}pp" if r["gh"] is not None else "—"
            price = f"¥{r['price']:.2f}"
            tag   = "（除权）" if r.get("is_ex_today") else ""
            return (f"- {r['prev_st']}→{r['status']} {r['name']}  {price}  "
                    f"{pct}{tag}  股息率 {r['curr_yield']:.2%}（差目标 {diff}）")

        if improving:
            if len(improving) >= 2:
                lines.append("**股息率改善**")
                lines.append("")
            for r in sorted(improving, key=lambda x: _ST_LEVEL.get(x["status"], 0) - _ST_LEVEL.get(x["prev_st"], 0), reverse=True):
                lines.append(_fmt_transition(r))
            lines.append("")
        if worsening:
            if len(worsening) >= 2:
                lines.append("**股息率下滑**")
                lines.append("")
            for r in sorted(worsening, key=lambda x: x["pct_chg"] or 0, reverse=True):
                lines.append(_fmt_transition(r))
            lines.append("")

    # ── 今日大涨大跌（≥2%，无则取涨最多/跌最多各一） ──
    shown = {r["code"] for r in transitions}
    has_pct = [r for r in rows if r["pct_chg"] is not None and r["code"] not in shown]
    big_movers = [r for r in has_pct if abs(r["pct_chg"]) >= 0.02]
    if big_movers:
        _sort_movers = lambda lst: sorted(lst, key=lambda x: (x["pct_chg"] < 0, -abs(x["pct_chg"])))
        if len(big_movers) > 10:
            display = _sort_movers(big_movers)[:10]
            title = f"## 今日大涨大跌（≥2%，取幅度最大10支，共{len(big_movers)}支）"
        else:
            display = _sort_movers(big_movers)
            title = "## 今日大涨大跌（≥2%）"
    elif has_pct:
        best  = max(has_pct, key=lambda x: x["pct_chg"])
        worst = min(has_pct, key=lambda x: x["pct_chg"])
        display = [worst, best] if worst["code"] != best["code"] else [best]
        title = "## 今日大涨大跌（今日最大涨跌）"
    else:
        display = []
        title = "## 今日大涨大跌"
    lines.append(title)
    lines.append("")
    if display:
        for r in display:
            emoji = "📉" if r["pct_chg"] < 0 else "📈"
            yld_chg = r["curr_yield"] - r["prev_yield"] if r["prev_yield"] else None
            yld_str = (f"股息率{'↑' if yld_chg > 0 else '↓'}{abs(yld_chg * 100):.2f}pp"
                       if yld_chg is not None else "")
            price = f"¥{r['price']:.2f}"
            tag   = "（除权）" if r.get("is_ex_today") else ""
            lines.append(
                f"- {emoji} {r['name']}  {price}  "
                f"{r['pct_chg']:+.2%}{tag}  {yld_str}  现{r['curr_yield']:.2%}"
            )
    else:
        lines.append("- 暂无数据")
    lines.append("")

    # ── 近期除息日（30天内） ──
    today = as_of_date
    upcoming = []
    for r in rows:
        if not r["ex_date"]:
            continue
        try:
            d = datetime.date.fromisoformat(str(r["ex_date"]))
        except (ValueError, TypeError):
            continue
        delta = (d - today).days
        if 0 <= delta <= 30:
            upcoming.append((delta, d, r))
    if upcoming:
        upcoming.sort(key=lambda x: x[0])
        # 条目 >5 时收窄到 7 天内，避免近期除息日撑长把卡片挤到折叠
        window = 30
        if len(upcoming) > 5:
            upcoming = [u for u in upcoming if u[0] <= 7]
            window = 7
    if upcoming:
        lines.append(f"## 近期除息日（{window}天内）")
        lines.append("")
        for delta, d, r in upcoming:
            day_str = "今天" if delta == 0 else f"{delta}天后"
            price, dps = r["price"], r.get("div_dps")
            if dps and price > dps:
                ex_yield = r["div_e"] / (price - dps)
                yld_str = (f"每股{dps:.3f}元  "
                           f"现价股息率 {r['curr_yield']:.2%} → 除息后 {ex_yield:.2%}")
            else:
                yld_str = f"股息率 {r['curr_yield']:.2%}"
            lines.append(
                f"- 📅 {r['name']}  ¥{price:.2f}  "
                f"{d.strftime('%m/%d')}（{day_str}）  {yld_str}"
            )
        lines.append("")


    return "\n".join(lines)


def exdiv_card_md(wb_val):
    """近期除息日超过阈值时生成独立卡片，避免挤占主卡片空间；≤5 支返回 None。"""
    ws   = wb_val["股票数据"]
    as_of_date = ashare_price_date()
    rows = _build_yield_rows(ws, as_of_date)
    today = as_of_date

    upcoming = []
    for r in rows:
        if not r["ex_date"]:
            continue
        try:
            d = datetime.date.fromisoformat(str(r["ex_date"]))
        except (ValueError, TypeError):
            continue
        delta = (d - today).days
        if 0 <= delta <= 7:
            upcoming.append((delta, d, r))
    if len(upcoming) <= 5:
        return None

    upcoming.sort(key=lambda x: x[0])
    summary = _stats_line(rows)

    lines = [
        f"# 股息率日报 — {as_of_date.isoformat()}",
        "",
        summary,
        "",
        f"## 近期除息日（7天内，{len(upcoming)}支）",
        "",
    ]

    for delta, d, r in upcoming:
        day_str = "今天" if delta == 0 else f"{delta}天后"
        price, dps = r["price"], r.get("div_dps")
        if dps and price > dps:
            ex_yield = r["div_e"] / (price - dps)
            yld_str = (f"每股{dps:.3f}元  "
                       f"现价股息率 {r['curr_yield']:.2%} → 除息后 {ex_yield:.2%}")
        else:
            yld_str = f"股息率 {r['curr_yield']:.2%}"
        lines.append(
            f"- 📅 {r['name']}  ¥{price:.2f}  "
            f"{d.strftime('%m/%d')}（{day_str}）  {yld_str}"
        )

    return "\n".join(lines)


# ─── 入口 ────────────────────────────────────────────────────────

def main():
    from data_sources import reset_run
    reset_run()
    load_cache()
    print(f'读取文件: {FILE_PATH}\n')
    from rolling_dividend import refresh as refresh_dividends
    dividend_records = refresh_dividends()
    wb_val = openpyxl.load_workbook(FILE_PATH, data_only=True)
    wb     = openpyxl.load_workbook(FILE_PATH)

    ws_val  = wb_val['股票数据']
    ws2_val = wb_val['港股数据']

    # 收集所有 A股代码（股票数据 + 港股数据 A股列）
    all_a_codes = set()
    for row_idx in range(2, ws_val.max_row + 1):
        c = ws_val.cell(row=row_idx, column=3).value
        if c:
            all_a_codes.add(c)
    for row_idx in range(2, ws2_val.max_row + 1):
        c = ws2_val.cell(row=row_idx, column=3).value
        if c and isinstance(ws2_val.cell(row=row_idx, column=1).value, str):
            all_a_codes.add(c)

    _update_prev_ashare()
    ashare_prices = get_ashare_prices(list(all_a_codes))
    _update_prev_ashare()   # 收盘后保存快照（价格拉取后再执行一次）
    print()

    update_ashare_sheet(wb, wb_val, ashare_prices)
    update_hkstock_sheet(wb, wb_val, ashare_prices)

    fit_col_widths_by_header(wb['股票数据'])
    fit_col_widths_by_header(wb['港股数据'])

    wb.save(FILE_PATH)
    # Restore calculated results after openpyxl saves, using the same fetched data.
    refresh_dividends(records=dividend_records, percentile_as_of=ashare_price_date())
    save_cache()
    print(f'\n✅ 已保存: {FILE_PATH}')

    return check_dividends(openpyxl.load_workbook(FILE_PATH, data_only=True))


if __name__ == '__main__':
    main()
