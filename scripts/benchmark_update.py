"""Time a real complete update and retain read-only comparison evidence."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time

ROOT=Path(__file__).resolve().parents[1]


def snapshot(path):
    import openpyxl
    wb=openpyxl.load_workbook(path,data_only=True)
    result={s.title:[[c.value for c in row] for row in s] for s in wb
            if s.title in ['股票数据','港股数据','股息率历史']}
    wb.close()
    return result


def seed_from_baseline(folder):
    """Initialize caches only from a verified successful live benchmark."""
    import data_sources,history_percentile,rolling_dividend
    folder=Path(folder)
    meta=json.loads((folder/'timings.json').read_text(encoding='utf-8'))
    if not meta['success']:
        raise ValueError('不能使用失败的基准运行初始化缓存')
    records=json.loads((folder/'percentiles.json').read_text(encoding='utf-8'))
    cache,algorithm,_=history_percentile.cache_settings()
    completed=dt.datetime.fromisoformat(meta['completed_at']).date()
    if completed!=dt.date.today():
        raise ValueError('仅允许使用当天在线基准数据初始化缓存')
    start=completed.replace(year=completed.year-5,day=min(completed.day,28))-dt.timedelta(days=14)
    for record in records:
        code=record['code'];expected=record['percentile_history']
        as_of=dt.date.fromisoformat(expected['end'])
        rows=json.loads((folder/f'history_{code}.json').read_text(encoding='utf-8'))['rows']
        items=data_sources.normalize_dividends(json.loads((folder/f'dividends_{code}.json').read_text(encoding='utf-8'))['rows'])
        items=rolling_dividend.supplement_missing(items,code)
        rows=cache.seed_prices(code,rows,as_of,requested_start=start)
        result,_=cache.distribution(code,items,rows,expected['current_yield'],as_of,algorithm,history_percentile.backcast)
        for key in ['percentile','count','less_equal','start','end','requested_start','samples','warnings','method','limitation']:
            if result[key]!=expected[key]:
                raise AssertionError(f'{code} 缓存初始化与在线基准不一致: {key}')
    print(f'CACHE_SEEDED={len(records)}; 每日样本及百分位与在线基准完全一致',flush=True)


def main():
    label=sys.argv[1] if len(sys.argv)>1 else 'run'
    folder=ROOT/'pictures'/dt.date.today().strftime('%Y%m%d')/('cache_benchmark_'+dt.datetime.now().strftime('%H%M%S')+'_'+label)
    folder.mkdir(parents=True)
    os.environ['DIVIDEND_DIAGNOSTICS_DIR']=str(folder)
    from network_diagnostics import install
    install()
    import data_sources,history_percentile,rolling_dividend,update_dy,export_sheet_pic
    workbook=ROOT/'data/daily-dy.xlsx'
    shutil.copyfile(workbook,folder/'before.xlsx')
    (folder/'before_values.json').write_text(json.dumps(snapshot(workbook),ensure_ascii=False,indent=2,default=str),encoding='utf-8')
    phases={}
    calls=[]
    lock=threading.Lock()
    def timing(module,name,title):
        original=getattr(module,name)
        def measured(*args,**kwargs):
            start=time.perf_counter()
            try:return original(*args,**kwargs)
            finally:
                with lock:phases[title]=phases.get(title,0)+time.perf_counter()-start
        setattr(module,name,measured)
    for module,name,title in [
        (update_dy,'get_ashare_prices','a_quotes'),
        (update_dy,'update_ashare_sheet','a_dates_and_format'),
        (update_dy,'update_hkstock_sheet','hk_quotes_dates_fx'),
        (history_percentile,'prepare','historical_prices_and_calculation'),
        (rolling_dividend,'merge_authored_column','xlsx_merge'),
        (export_sheet_pic,'screenshot_html','screenshots'),
    ]:timing(module,name,title)
    original=data_sources._run_ak
    def capture(kind,code=None,**kwargs):
        start=time.perf_counter()
        try:
            data=original(kind,code,**kwargs)
            if kind in ['history','dividends']:
                (folder/f'{kind}_{code}.json').write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            return data
        finally:
            with lock:calls.append({'kind':kind,'code':code,'seconds':round(time.perf_counter()-start,4),**kwargs})
    data_sources._run_ak=capture
    print('BENCHMARK_DIR='+str(folder),flush=True)
    start=time.perf_counter()
    success=False
    try:
        export_sheet_pic.main()
        success=True
    finally:
        seconds=time.perf_counter()-start
        metadata={'label':label,'success':success,'total_seconds':round(seconds,4),
                  'phases_seconds':{k:round(v,4) for k,v in phases.items()},'akshare_calls':calls,
                  'completed_at':dt.datetime.now().isoformat()}
        (folder/'timings.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
        (folder/'after_values.json').write_text(json.dumps(snapshot(workbook),ensure_ascii=False,indent=2,default=str),encoding='utf-8')
        if (ROOT/'pictures'/dt.date.today().strftime('%Y%m%d')/'dividend_percentiles.json').exists():
            shutil.copyfile(ROOT/'pictures'/dt.date.today().strftime('%Y%m%d')/'dividend_percentiles.json',folder/'percentiles.json')
        print('BENCHMARK_SECONDS='+str(round(seconds,3)),flush=True)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--seed':seed_from_baseline(sys.argv[2])
    else:main()
