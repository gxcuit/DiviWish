"""Backcast annual dividend yields by disclosure date, using Tencent daily prices."""
import bisect
import calendar
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
import math
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIN_SAMPLES = 60


def cache_settings():
    from importlib.metadata import version
    from historical_cache import HistoricalCache, SOURCE, digest
    # Any change to calculation/normalization code invalidates derived history.
    files=['history_percentile.py','historical_cache.py','rolling_dividend.py','data_sources.py','update_dy.py']
    algorithm=digest({'files':{f:(ROOT/'scripts'/f).read_text(encoding='utf-8') for f in files},
                      'window_years':5,'min_samples':MIN_SAMPLES})
    cache=HistoricalCache(os.environ.get('DIVIDEND_HISTORY_CACHE_DIR',str(ROOT/'data/.history_cache')),
                          source=SOURCE+':akshare-'+version('akshare'))
    force=any(os.environ.get(k)=='1' for k in ['DIVIDEND_FORCE_REFRESH','DIVIDEND_HISTORY_FORCE_REFRESH'])
    return cache,algorithm,force


def date_value(value):
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except (ValueError,TypeError):
        return None


def historical_end(prices,quote_date,market_open=False):
    if not market_open:
        return quote_date
    dates=[date_value(row.get('date')) for row in prices]
    dates=[d for d in dates if d and d<quote_date]
    if not dates or (quote_date-max(dates)).days>14:
        raise ValueError('盘中缺少最近已完成交易日的历史行情')
    return max(dates)


def backcast(items, prices, current_yield, as_of, min_samples=MIN_SAMPLES):
    from rolling_dividend import eligible_periods, installment_dps
    if not isinstance(current_yield,(int,float)) or not math.isfinite(current_yield) or current_yield<0:
        raise ValueError('当前股息率无效')
    cutoff=as_of.replace(year=as_of.year-5,
                        day=min(as_of.day,calendar.monthrange(as_of.year-5,as_of.month)[1]))
    events=[]
    warnings=[]
    for period,item in eligible_periods(items,as_of).items():
        # Older records cannot affect the latest full year inside this window.
        if period.year<cutoff.year-2:
            continue
        available=None
        basis=None
        for field in ['PLAN_NOTICE_DATE','PUBLISH_DATE','NOTICE_DATE','EX_DIVIDEND_DATE']:
            candidate=date_value(item.get(field))
            if candidate and candidate>=period:
                available,basis=candidate,field
                break
        if available is None:
            raise ValueError(f'{period}缺少可核实的分红披露日期')
        profile=str(item.get('IMPL_PLAN_PROFILE') or '').strip()
        if item.get('PRETAX_BONUS_RMB') is None and re.fullmatch(r'10(?:(?:送|转)\d+(?:\.\d+)?)+(?:股)?',profile):
            # An explicit share-only scheme has zero cash; an empty amount alone does not.
            amount=0.0
        else:
            amount=installment_dps(item)
        events.append({'period':period,'available':available,'dps':amount,'date_basis':basis})
        if basis not in ['PLAN_NOTICE_DATE','PUBLISH_DATE']:
            warnings.append(f'{period}:按{basis}保守生效')
        if (item.get('BONUS_IT_RATIO') or 0)>0 and (date_value(item.get('EX_DIVIDEND_DATE')) or dt.date.min)>=cutoff:
            warnings.append(f'{period}:历史含送转，名义每股口径可能受股本变化影响')
    events.sort(key=lambda e:(e['available'],e['period']))
    closes={}
    for row in prices:
        day=date_value(row.get('date'))
        close=row.get('close')
        if day and cutoff<=day<=as_of and isinstance(close,(int,float)) and math.isfinite(close) and close>0:
            if day in closes and abs(closes[day]-close)>1e-8:
                raise ValueError(f'{day}存在冲突的收盘价')
            closes[day]=float(close)
    if not closes:
        raise ValueError('近5年没有有效收盘价')
    if max(closes)!=as_of:
        raise ValueError(f'历史行情停在{max(closes)}，与估值日{as_of}不符')
    active={}
    samples=[]
    event_index=0
    for day,close in sorted(closes.items()):
        # Daily announcements have no intraday timestamp: activate next session.
        while event_index<len(events) and events[event_index]['available']<day:
            event=events[event_index]
            active[event['period']]=event
            event_index+=1
        years=[period.year for period in active if (period.month,period.day)==(12,31)]
        if not years:
            continue
        year=max(years)
        if day.year-year>2:
            continue
        dps=round(sum(event['dps'] for period,event in active.items() if period.year==year),8)
        samples.append({'date':day.isoformat(),'annual':dps,'year':year,
                        'close':close,'yield':dps/close})
    if len(samples)<min_samples:
        raise ValueError(f'有效历史样本仅{len(samples)}个交易日，至少需要{min_samples}个')
    # Empirical CDF: fraction of valid historical daily yields <= current yield.
    values=sorted(s['yield'] for s in samples)
    less_equal=bisect.bisect_right(values,current_yield+1e-12)
    percentile=less_equal/len(values)
    return {'percentile':percentile,'current_yield':current_yield,'count':len(samples),
            'less_equal':less_equal,'start':samples[0]['date'],'end':samples[-1]['date'],
            'requested_start':cutoff.isoformat(),'samples':samples,
            'warnings':list(dict.fromkeys(warnings)),
            'method':'已披露完整年度股息/不复权收盘价；公告后下一交易日生效；历史值<=当前值的比例',
            'limitation':'按现存分红记录回溯，非逐日方案版本快照；送转配股可能影响名义每股口径'}


def prepare(records, as_of):
    import openpyxl
    from data_sources import _run_ak, cached_dividends
    from rolling_dividend import supplement_missing
    from update_dy import is_market_open
    from yield_quantiles import thresholds
    market_open=is_market_open('ashare')
    cache,algorithm,force=cache_settings()
    wb=openpyxl.load_workbook(ROOT/'data/daily-dy.xlsx',data_only=True,read_only=True)
    ws=wb['股票数据']
    prices={r['code']:ws.cell(r['row'],4).value for r in records}
    wb.close()
    def fetch(record):
        try:
            annual=record.get('annual')
            price=prices[record['code']]
            if annual is None or not isinstance(price,(int,float)) or price<=0:
                raise ValueError('最新年度股息或当前价格待核实')
            cached=cached_dividends(record['code'])
            if not cached:
                raise ValueError('缺少本轮刚获取的分红明细')
            items=supplement_missing(cached[0],record['code'])
            def get_prices(code,start,end):
                return _run_ak('history',code,start_date=start.isoformat(),end_date=end.isoformat())['rows']
            rows,price_status=cache.prices(record['code'],as_of,market_open,get_prices,force=force)
            end=historical_end(rows,as_of,market_open)
            result,calc_status=cache.distribution(record['code'],items,rows,annual['total']/price,
                                                 end,algorithm,backcast,force=force)
            result['cache']={**price_status,**calc_status}
            result['valuation_date']=as_of.isoformat()
            result['quantiles']=thresholds(result['samples'],annual['total'])
            if abs(result['samples'][-1]['annual']-annual['total'])>1e-7:
                raise ValueError('历史末期与当前年度股息口径不一致，需核实披露日期')
            result['price_source']='AKShare:stock_zh_a_hist_tx(adjust="") / Tencent'
            print(f'  [历史百分位] {record["name"]}: {result["percentile"]:.2%}，{result["count"]}日 '
                  f'（行情:{price_status["prices"]}，计算:{calc_status["calculation"]}）',flush=True)
        except Exception as exc:
            result={'error':str(exc)}
            print(f'  [历史百分位] {record["name"]}: 待核实（{exc}）',flush=True)
        record['percentile_history']=result
        return record
    print('\n【近5年股息率百分位】腾讯历史行情增量更新，按输入指纹复用历史计算',flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        records=list(pool.map(fetch,records))
    out=ROOT/'pictures'/dt.date.today().strftime('%Y%m%d')
    (out/'dividend_percentiles.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    return records
