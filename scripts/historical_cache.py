"""Validated, atomic caches for closed daily prices and dividend-yield distributions."""
import bisect
import calendar
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading

SCHEMA=1
SOURCE='akshare-tencent-daily-unadjusted-v1'
FULL_CHECK_DAYS=30
OVERLAP_CHECK_DAYS=7
OVERLAP_DAYS=30


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def iso_date(value):
    return dt.date.fromisoformat(str(value)[:10])


def full_start(as_of):
    return as_of.replace(year=as_of.year-5,day=min(as_of.day,calendar.monthrange(as_of.year-5,as_of.month)[1]))


def history_start(as_of):
    # During a session the effective window ends at the previous completed day.
    return full_start(as_of)-dt.timedelta(days=14)


def normalize_prices(rows):
    result={}
    for row in rows:
        day=iso_date(row['date'])
        price=row.get('close')
        if not isinstance(price,(int,float)) or isinstance(price,bool) or not math.isfinite(price) or price<=0:
            raise ValueError(f'{day}历史收盘价无效')
        price=float(price)
        if day in result and abs(result[day]-price)>1e-8:
            raise ValueError(f'{day}历史收盘价冲突')
        result[day]=price
    if not result:
        raise ValueError('历史行情返回空数据')
    return [{'date':day.isoformat(),'close':price} for day,price in sorted(result.items())]


class HistoricalCache:
    def __init__(self,folder,today=None,source=SOURCE):
        self.folder=Path(folder)
        self.today=today or dt.date.today()
        self.source=source

    def path(self,kind,code):
        if not re.fullmatch(r'\d{6}',str(code)):
            raise ValueError('历史缓存股票代码必须为6位数字')
        return self.folder/f'{kind}_{code}.json'

    def read(self,kind,code):
        try:
            record=json.loads(self.path(kind,code).read_text(encoding='utf-8'))
            payload=record['payload']
            if record.get('schema')!=SCHEMA or record.get('source')!=self.source or record['digest']!=digest(payload):
                return None
            return payload
        except (OSError,ValueError,KeyError,TypeError):
            return None

    def write(self,kind,code,payload):
        path=self.path(kind,code)
        path.parent.mkdir(parents=True,exist_ok=True)
        temp=path.with_suffix(f'.{os.getpid()}.{threading.get_ident()}.tmp')
        data={'schema':SCHEMA,'source':self.source,'digest':digest(payload),'payload':payload}
        temp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf-8')
        temp.replace(path)

    def seed_prices(self,code,rows,quote_date,requested_start=None):
        rows=[r for r in normalize_prices(rows) if iso_date(r['date'])<=quote_date]
        if not rows or iso_date(rows[-1]['date'])!=quote_date:
            raise ValueError('初始化历史缓存的最后日期与行情日期不一致')
        payload={'rows':rows,'coverage_start':(requested_start or history_start(quote_date)).isoformat(),
                 'full_checked_on':self.today.isoformat(),'overlap_checked_on':self.today.isoformat(),
                 'checked_quote_date':quote_date.isoformat(),'checked_intraday':False}
        self.write('prices',code,payload)
        return rows

    def prices(self,code,quote_date,market_open,fetch,force=False):
        cached=self.read('prices',code)
        start=history_start(quote_date)
        try:
            if cached:
                cached['rows']=normalize_prices(cached['rows'])
                full_due=(self.today-iso_date(cached['full_checked_on'])).days>=FULL_CHECK_DAYS
                overlap_due=(self.today-iso_date(cached['overlap_checked_on'])).days>=OVERLAP_CHECK_DAYS
                required_start=start if market_open else full_start(quote_date)
                lacks_coverage=iso_date(cached['coverage_start'])>required_start
            else:
                full_due=lacks_coverage=True
                overlap_due=True
        except (KeyError,ValueError,TypeError):
            cached=None
            full_due=lacks_coverage=overlap_due=True
        mode='full' if force or not cached or full_due or lacks_coverage else 'incremental'
        if mode!='full':
            latest=iso_date(cached['rows'][-1]['date'])
            covered=(latest>=quote_date or (market_open and cached.get('checked_intraday')
                     and cached.get('checked_quote_date')==quote_date.isoformat()))
            if covered and not overlap_due:
                return cached['rows'],{'prices':'hit','network_checked':False,'changed':False}
            start=max(start,latest-dt.timedelta(days=OVERLAP_DAYS))
        incoming=normalize_prices(fetch(code,start,quote_date))
        incoming=[r for r in incoming if start<=iso_date(r['date'])<=quote_date
                  and not (market_open and iso_date(r['date'])==quote_date)]
        if not incoming:
            raise ValueError('请求范围内没有已完成交易日的日线')
        if mode=='full':
            rows=incoming
        else:
            merged={r['date']:r for r in cached['rows']}
            merged.update({r['date']:r for r in incoming})
            rows=[merged[d] for d in sorted(merged) if history_start(quote_date)<=iso_date(d)<=quote_date]
        if not market_open and iso_date(rows[-1]['date'])!=quote_date:
            raise ValueError('增量历史行情缺少最新交易日，保留旧缓存但不作为本次新数据使用')
        changed=not cached or digest(rows)!=digest(cached['rows'])
        payload={'rows':rows,
                 'coverage_start':history_start(quote_date).isoformat() if mode=='full' else max(iso_date(cached['coverage_start']),history_start(quote_date)).isoformat(),
                 'full_checked_on':self.today.isoformat() if mode=='full' else cached['full_checked_on'],
                 'overlap_checked_on':self.today.isoformat(),'checked_quote_date':quote_date.isoformat(),
                 'checked_intraday':market_open}
        self.write('prices',code,payload)
        return rows,{'prices':mode,'network_checked':True,'changed':changed,
                     'requested_start':start.isoformat(),'requested_end':quote_date.isoformat()}

    def distribution(self,code,items,rows,current_yield,as_of,algorithm,builder,force=False):
        if not isinstance(current_yield,(int,float)) or not math.isfinite(current_yield) or current_yield<0:
            raise ValueError('当前股息率无效')
        ordered=sorted(items,key=lambda item:json.dumps(item,ensure_ascii=False,sort_keys=True))
        key=digest({'dividends':ordered,'prices':normalize_prices(rows),
                    'as_of':as_of.isoformat(),'algorithm':algorithm})
        cached=None if force else self.read('distribution',code)
        hit=bool(cached and cached.get('key')==key)
        if not hit:
            result=builder(items,rows,current_yield,as_of)
            series={k:v for k,v in result.items() if k not in ['percentile','current_yield','less_equal']}
            values=sorted(s['yield'] for s in series['samples'])
            if not values or any(not math.isfinite(v) or v<0 for v in values):
                raise ValueError('历史股息率序列无效')
            cached={'key':key,'series':series,'sorted_yields':values}
            self.write('distribution',code,cached)
        result=dict(cached['series'])
        values=cached['sorted_yields']
        count=bisect.bisect_right(values,current_yield+1e-12)
        result.update(current_yield=current_yield,less_equal=count,percentile=count/len(values))
        return result,{'calculation':'hit' if hit else 'rebuilt','distribution_key':key}
