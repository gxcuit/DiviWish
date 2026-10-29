"""Fill missing year-start prices using the first market session's raw close."""
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import math
import re


def positive_number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>0


def year_from_header(header,today=None):
    today=today or dt.date.today()
    match=re.search(r'(?<!\d)(\d{4}|\d{2})\s*初',str(header or ''))
    if match:
        year=int(match[1])
        return year+2000 if year<100 else year
    if '年初' in str(header or ''):
        return today.year
    raise ValueError('年初价格表头没有可识别的年份')


def first_session(rows,year,today):
    days=[]
    for row in rows:
        try:day=dt.date.fromisoformat(str(row['trade_date'])[:10])
        except (KeyError,ValueError,TypeError):continue
        if day.year==year and day<=today:days.append(day)
    if not days:raise ValueError(f'交易日历中没有{year}年已发生的交易日')
    return min(days)


def session_close(rows,day):
    values=[r.get('close') for r in rows if str(r.get('date',''))[:10]==day.isoformat()]
    if not values:raise ValueError(f'缺少{day}收盘价，可能停牌或当时尚未上市')
    if any(not positive_number(v) for v in values):raise ValueError('年初收盘价无效')
    if max(values)-min(values)>1e-8:raise ValueError('年初收盘价记录冲突')
    return float(values[0])


def prepare(records,existing,header,today=None):
    from data_sources import _run_ak
    from history_percentile import cache_settings
    from historical_cache import FULL_CHECK_DAYS
    today=today or dt.date.today()
    try:year=year_from_header(header,today)
    except ValueError as exc:
        for record in records:record['year_start']={'error':str(exc),'price':None}
        return records
    pending=[]
    for record in records:
        # The final authoring pass reuses the same run's result, including errors.
        if record.get('year_start',{}).get('year')==year:continue
        old=existing.get(record['code'])
        if positive_number(old):
            record['year_start']={'year':year,'price':old,'status':'preserved','source':'现有工作簿'}
        else:pending.append(record)
    if not pending:return records
    print(f'\n【年初价格】补齐{year}年首个交易日收盘价，共{len(pending)}支',flush=True)
    try:
        day=first_session(_run_ak('calendar')['rows'],year,today)
        cache,_,force=cache_settings()
    except Exception as exc:
        for record in pending:
            record['year_start']={'year':year,'price':None,'error':str(exc)}
            print(f'  {record["name"]}: 年初价格待核实（{exc}）',flush=True)
        return records
    def fetch(record):
        code=record['code']
        try:
            cached=None if force else cache.read('prices',code)
            try:
                age=(today-dt.date.fromisoformat(cached['full_checked_on'])).days if cached else None
                fresh=age is not None and 0<=age<FULL_CHECK_DAYS
            except (KeyError,ValueError,TypeError):fresh=False
            try:
                price=session_close(cached['rows'],day) if fresh else None
            except (KeyError,ValueError,TypeError):price=None
            status='history_cache'
            if price is None:
                raw=_run_ak('history',code,start_date=day.isoformat(),end_date=day.isoformat())
                price=session_close(raw['rows'],day)
                status='online'
            record['year_start']={'year':year,'date':day.isoformat(),'price':price,'status':status,
                                  'source':'AKShare:stock_zh_a_hist_tx(adjust="") / Tencent',
                                  'calendar_source':'AKShare:tool_trade_date_hist_sina'}
            print(f'  {record["name"]} ({code}) → {day} ¥{price:.2f}（{status}）',flush=True)
        except Exception as exc:
            record['year_start']={'year':year,'date':day.isoformat(),'price':None,'error':str(exc)}
            print(f'  {record["name"]}: 年初价格待核实（{exc}）',flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(fetch,pending))
    return records
