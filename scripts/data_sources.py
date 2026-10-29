"""AKShare-first adapters with bounded execution and existing-source fallback."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from network_diagnostics import record

_DIVIDENDS = {}
_FAILURES = {}
_LOCK = threading.Lock()


def reset_run():
    _DIVIDENDS.clear()
    _FAILURES.clear()


def _number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def _date(value):
    return str(value)[:10] if value and str(value) not in ('NaT', 'nan', 'None') else None


def _run_ak(kind, code=None, *, start_date=None, end_date=None):
    with _LOCK:
        if _FAILURES.get(kind, 0) >= 3:
            raise RuntimeError('本轮AKShare连续失败，已暂时熔断')
    args = [sys.executable, str(Path(__file__).with_name('akshare_worker.py')), kind]
    if code:
        args.append(code)
    if start_date is not None or end_date is not None:
        if kind != 'history' or not code or not start_date or not end_date:
            raise ValueError('历史行情需同时指定代码、开始和结束日期')
        args.extend([str(start_date), str(end_date)])
    started = time.perf_counter()
    record('akshare_start', kind=kind, code=code, timeout=40,
           start_date=start_date, end_date=end_date)
    try:
        env = {**os.environ, 'PYTHONUTF8': '1'}
        run = subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                             errors='replace', timeout=40, check=True, env=env)
        line = next((line for line in reversed(run.stdout.splitlines()) if line.startswith('AKSHARE_RESULT=')), None)
        if line is None:
            raise ValueError('AKShare未返回结构化结果')
        result = json.loads(line.split('=', 1)[1])
        record('akshare_end', kind=kind, code=code, elapsed=round(time.perf_counter()-started, 3))
        return result
    except Exception as exc:
        record('akshare_error', kind=kind, code=code, elapsed=round(time.perf_counter()-started, 3),
               error_type=type(exc).__name__, error=str(exc),
               stderr=getattr(exc, 'stderr', None))
        with _LOCK:
            _FAILURES[kind] = _FAILURES.get(kind, 0) + 1
        if isinstance(exc, subprocess.CalledProcessError):
            raise RuntimeError((exc.stderr or str(exc)).strip().splitlines()[-1]) from exc
        raise


def normalize_dividends(rows):
    records = []
    for row in rows:
        if '报告期' not in row or '方案进度' not in row:
            raise ValueError('AKShare分红字段变化')
        if not _date(row['报告期']):
            raise ValueError('AKShare缺少分红报告期')
        records.append({
            'REPORT_DATE': _date(row['报告期']),
            'ASSIGN_PROGRESS': row['方案进度'],
            # Both fields retain the upstream per-10-share unit. The common
            # dividend parser converts to per-share exactly once.
            'PRETAX_BONUS_RMB': _number(row.get('现金分红-现金分红比例')),
            'IMPL_PLAN_PROFILE': row.get('现金分红-现金分红比例描述') or '',
            'EX_DIVIDEND_DATE': _date(row.get('除权除息日')),
            'EQUITY_RECORD_DATE': _date(row.get('股权登记日')),
            'PLAN_NOTICE_DATE': _date(row.get('预案公告日')) or _date(row.get('业绩披露日期')),
            'NOTICE_DATE': _date(row.get('最新公告日期')),
            'BONUS_IT_RATIO': _number(row.get('送转股份-送转总比例')),
        })
    if not records:
        raise ValueError('AKShare分红记录为空，回退核实')
    return sorted(records, key=lambda row: row['REPORT_DATE'], reverse=True)


def cached_dividends(code):
    return _DIVIDENDS.get(str(code).zfill(6))


def dividend_records(code, fallback):
    code = str(code).zfill(6)
    if code in _DIVIDENDS:
        return _DIVIDENDS[code]
    try:
        data = _run_ak('dividends', code)
        records = normalize_dividends(data['rows'])
        # Validate the periods and amounts actually used by the calculator;
        # malformed AKShare data should also trigger the original-source fallback.
        from rolling_dividend import select_annual, select_rolling
        select_rolling(records)
        select_annual(records)
        result = (records, f'AKShare {data["version"]}:stock_fhps_detail_em({code})')
    except Exception as exc:
        print(f'  [回退] {code} AKShare分红: {exc}', flush=True)
        result = fallback()
    _DIVIDENDS[code] = result
    return result


def ashare_quotes(codes):
    wanted = list(dict.fromkeys(str(code).zfill(6) for code in codes))
    def fetch(code):
        with _LOCK:
            if _FAILURES.get('ashare', 0) >= 3:
                return None
        try:
            data = _run_ak('ashare', code)
            row = next(r for r in data['rows'] if str(r.get('代码', '')).zfill(6) == code)
            price = _number(row.get('最新价'))
            pct = _number(row.get('涨跌幅'))
            if price is None or price <= 0:
                raise ValueError('个股报价缺少有效价格')
            return code, price, pct / 100 if pct is not None else None
        except Exception as exc:
            print(f'  [回退] {code} AKShare单股行情: {exc}', flush=True)
            return None
    with ThreadPoolExecutor(max_workers=3) as pool:
        quotes = [quote for quote in pool.map(fetch, wanted) if quote is not None]
    result = {}
    if quotes:
        # The quote API has no trading date field; fetch the calendar once per batch.
        trade_date = _run_ak('calendar')['trade_date']
        result = {code: (price, pct, trade_date) for code, price, pct in quotes}
    if not result:
        raise ValueError('AKShare未返回请求股票的有效行情')
    print(f'  [AKShare] 按代码获取A股行情 {len(result)}/{len(wanted)} 支', flush=True)
    return result
