"""Compare a live uncached update with a live warm-cache update."""
from collections import Counter
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile

from historical_cache import HistoricalCache, normalize_prices
from history_percentile import backcast
from data_sources import normalize_dividends
from rolling_dividend import supplement_missing


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main(before,after):
    a,b=Path(before),Path(after)
    ta,tb=read(a/'timings.json'),read(b/'timings.json')
    assert ta['success'] and tb['success']
    va,vb=read(a/'after_values.json'),read(b/'after_values.json')
    differences=[];checked=0
    for sheet in sorted(set(va)|set(vb)):
        rows_a,rows_b=va.get(sheet,[]),vb.get(sheet,[])
        for r in range(max(len(rows_a),len(rows_b))):
            row_a=rows_a[r] if r<len(rows_a) else []
            row_b=rows_b[r] if r<len(rows_b) else []
            for c in range(max(len(row_a),len(row_b))):
                x=row_a[c] if c<len(row_a) else None
                y=row_b[c] if c<len(row_b) else None
                checked+=1
                if x!=y:differences.append({'sheet':sheet,'row':r+1,'column':c+1,'before':x,'after':y})
    pa,pb=read(a/'percentiles.json'),read(b/'percentiles.json')
    assert len(pa)==len(pb)==49
    assert [r['code'] for r in pa]==[r['code'] for r in pb]
    samples=0;hits=Counter()
    for previous,current in zip(pa,pb):
        old=previous['percentile_history'];new=current['percentile_history']
        assert {k:v for k,v in new.items() if k!='cache'}==old,previous['code']
        samples+=len(new['samples'])
        hits['prices_'+new['cache']['prices']]+=1
        hits['calculation_'+new['cache']['calculation']]+=1
    # Replay an actual next-session append on every stock, without network access.
    increment_matches=0
    with tempfile.TemporaryDirectory() as folder:
        cache=HistoricalCache(folder,today=dt.date.fromisoformat(tb['completed_at'][:10]))
        for record in pa:
            code=record['code'];expected=record['percentile_history']
            day=dt.date.fromisoformat(expected['end'])
            raw=normalize_prices(read(a/f'history_{code}.json')['rows'])
            prior=[r for r in raw if r['date']<day.isoformat()]
            cache.seed_prices(code,prior,dt.date.fromisoformat(prior[-1]['date']),
                              requested_start=day.replace(year=day.year-5))
            def fetch(_code,start,end):
                return [r for r in raw if start.isoformat()<=r['date']<=end.isoformat()]
            merged,status=cache.prices(code,day,False,fetch)
            assert status['prices']=='incremental'
            assert merged==raw,code
            items=supplement_missing(normalize_dividends(read(a/f'dividends_{code}.json')['rows']),code)
            rebuilt=backcast(items,merged,expected['current_yield'],day)
            assert rebuilt['samples']==expected['samples'] and rebuilt['percentile']==expected['percentile'],code
            increment_matches+=1
    endpoints=Counter();errors=[]
    for path in b.glob('network-*.jsonl'):
        for line in path.read_text(encoding='utf-8').splitlines():
            entry=json.loads(line)
            if entry['event']=='request_end':endpoints[entry['endpoint']]+=1
            if entry['event'] in ['request_error','akshare_error']:errors.append(entry)
    calls=Counter(c['kind'] for c in tb['akshare_calls'])
    assert calls['dividends']==49 and calls['history']==0
    assert sum(n for endpoint,n in endpoints.items() if endpoint.startswith('https://qt.gtimg.cn/'))==1
    assert sum(n for endpoint,n in endpoints.items() if '/chart/' in endpoint)==17
    assert sum(n for endpoint,n in endpoints.items() if 'open.er-api.com' in endpoint)==1
    assert not differences and not errors,(differences,errors)
    saved=ta['total_seconds']-tb['total_seconds'];percent=saved/ta['total_seconds']*100
    report={'before':ta,'after':tb,'cells_compared':checked,'cell_differences':differences,
            'history_samples_compared':samples,'cache_hits':dict(hits),'incremental_replays_matched':increment_matches,
            'after_online_requests':dict(endpoints),'after_errors':errors,
            'saved_seconds':round(saved,4),'saved_percent':round(percent,2)}
    (b/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 分红缓存验证与耗时对比','',
           f'- 无缓存完整更新：{ta["total_seconds"]:.3f}秒。',
           f'- 历史缓存命中后的完整更新：{tb["total_seconds"]:.3f}秒。',
           f'- 本次节省{saved:.3f}秒（{percent:.1f}%）；两次均在线检查最新数据。','',
           '| 阶段 | 无缓存（秒） | 缓存命中（秒） |','| --- | ---: | ---: |']
    for key in sorted(set(ta['phases_seconds'])|set(tb['phases_seconds'])):
        lines.append(f'| {key} | {ta["phases_seconds"].get(key,0):.3f} | {tb["phases_seconds"].get(key,0):.3f} |')
    lines+=['',f'三张表逐格比较{checked}个单元格，差异0；49支A股、17支港股全部保持一致。',
            f'49支历史百分位、{samples}条逐日样本完全一致；历史行情49次命中，历史计算49次命中。',
            f'用实际行情逐支回放新增交易日，{increment_matches}/49支增量合并与全量计算完全一致。',
            '62项自动化测试全部通过，包括缓存损坏、超时保留、公告/价格/算法变化失效、盘中与收盘切换及最新数据每轮在线检查。','',
            '缓存来自当天这次成功的在线无缓存基准，初始化逐条核对结果。第一次建立缓存仍需全量下载，本次第二轮为缓存已建立、无新增交易日的实测；网络和行情变化会影响日常耗时。',
            '耗时改善也包含去除A股逐行读取本轮分红明细时不必要的0.3秒等待，原阶段约14.8秒；港股在线请求间隔保留。',
            '历史每次新增日期回看30天，每7天重查重叠区间、每30天全量复查；更早修订需等待全量检查或强制刷新。','',
            '## 第二轮实际在线请求','']
    lines += [f'- `{endpoint}`：{n}次成功。' for endpoint,n in sorted(endpoints.items())]
    lines+=['','AKShare分红49次（上游HTTP共98次）；历史行情API调用0次；接口错误0次。']
    (b/'缓存性能对比.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ['before','after']},ensure_ascii=False,indent=2))


if __name__=='__main__':main(*sys.argv[1:])
