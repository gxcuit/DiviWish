"""Live, single-stock dividend quantile experiment; does not alter the workbook."""
import bisect
import datetime as dt
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]


def worker(kind):
    socket.setdefaulttimeout(12)
    import requests
    original=requests.Session.request
    def bounded(self,method,url,**kwargs):
        kwargs.setdefault('timeout',12)
        return original(self,method,url,**kwargs)
    requests.Session.request=bounded
    import akshare as ak
    if kind=='index':
        frame=ak.stock_zh_index_value_csindex(symbol='601318')
    elif kind=='value':
        frame=ak.stock_value_em(symbol='601318')
    else:raise ValueError(kind)
    result={'rows':len(frame),'columns':list(frame.columns),
            'first':json.loads(frame.head(1).to_json(orient='records',date_format='iso')),
            'last':json.loads(frame.tail(1).to_json(orient='records',date_format='iso'))}
    print('PROBE_RESULT='+json.dumps(result,ensure_ascii=False))


def main():
    out=ROOT/'pictures'/dt.date.today().strftime('%Y%m%d')/('ping_an_quantiles_'+dt.datetime.now().strftime('%H%M%S'))
    out.mkdir(parents=True)
    os.environ['DIVIDEND_DIAGNOSTICS_DIR']=str(out)
    from network_diagnostics import install
    install()
    import akshare as ak
    from data_sources import _run_ak,normalize_dividends
    from history_percentile import backcast
    from rolling_dividend import supplement_missing,select_annual
    from update_dy import _fetch_ashare_prices_batch,is_market_open
    from concurrent.futures import ThreadPoolExecutor
    results={'akshare_version':ak.__version__,'symbol':'601318','name':'中国平安',
             'legacy_functions':{name:hasattr(ak,name) for name in ['stock_a_indicator_lg','stock_a_lg_indicator']}}
    def probe(kind):
        start=time.perf_counter()
        try:
            run=subprocess.run([sys.executable,'-X','utf8',__file__,'--worker',kind],capture_output=True,text=True,
                               encoding='utf-8',timeout=35,env={**os.environ,'PYTHONUTF8':'1'})
            if run.returncode:
                return kind,{'success':False,'error':run.stderr.strip().splitlines()[-1],
                             'seconds':round(time.perf_counter()-start,3)}
            line=next(line for line in run.stdout.splitlines() if line.startswith('PROBE_RESULT='))
            return kind,{'success':True,**json.loads(line.split('=',1)[1]),'seconds':round(time.perf_counter()-start,3)}
        except Exception as exc:
            return kind,{'success':False,'error':str(exc),'seconds':round(time.perf_counter()-start,3)}
    print('OUTPUT_DIR='+str(out),flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(probe,kind) for kind in ['index','value']]
        price,pct,quote_date=_fetch_ashare_prices_batch(['601318'])['601318']
        if is_market_open('ashare'):
            raise ValueError('本实验按完整交易日计算，请收盘后执行')
        end=dt.date.fromisoformat(quote_date)
        start=end.replace(year=end.year-5,day=min(end.day,28))-dt.timedelta(days=14)
        raw_div=_run_ak('dividends','601318')
        raw_history=_run_ak('history','601318',start_date=start.isoformat(),end_date=end.isoformat())
        (out/'dividends_raw.json').write_text(json.dumps(raw_div,ensure_ascii=False,indent=2),encoding='utf-8')
        (out/'prices_raw.json').write_text(json.dumps(raw_history,ensure_ascii=False,indent=2),encoding='utf-8')
        items=supplement_missing(normalize_dividends(raw_div['rows']),'601318')
        annual=select_annual(items,end)
        history=backcast(items,raw_history['rows'],annual['total']/price,end)
        values=sorted(row['yield'] for row in history['samples'])
        quantiles=[]
        for probability in [.3,.6]:
            rank=math.ceil(probability*len(values))
            threshold=values[rank-1]
            position=(len(values)-1)*probability
            lo=math.floor(position);hi=math.ceil(position)
            interpolated=values[lo]+(position-lo)*(values[hi]-values[lo])
            quantiles.append({'probability':probability,'yield':threshold,'yield_percent':threshold*100,
                              'sample_rank':rank,'actual_cdf':bisect.bisect_right(values,threshold)/len(values),
                              'linear_interpolated_percent':interpolated*100,
                              'equivalent_price_using_latest_annual':annual['total']/threshold})
        results.update(quote_date=quote_date,price=price,annual=annual,
                       sample_count=history['count'],sample_start=history['start'],sample_end=history['end'],
                       current_yield=history['current_yield'],current_percentile=history['percentile'],
                       quantile_method='经验分布逆函数：排序后第ceil(p*N)个值，与当前<=排名口径配套',
                       quantiles=quantiles,history_method=history['method'],limitation=history['limitation'])
        for future in futures:
            kind,result=future.result();results[kind+'_probe']=result
    path=out/'results.json'
    path.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    (out/'historical_yields.json').write_text(json.dumps(history,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 中国平安股息率分位实测','',f'AKShare {ak.__version__}，仅请求中国平安A股601318，全部在线重新获取，不读取历史缓存，不修改工作簿。',
           f'区间：{history["start"]}至{history["end"]}，有效交易日{len(values)}个。',
           f'当前价格{price}元，最新完整年度{annual["year"]}每股股息{annual["total"]}元；股息率{history["current_yield"]:.6%}，自身历史百分位{history["percentile"]:.6%}。','',
           '| 历史百分位 | 对应股息率 | 对应股价（按当前年度股息换算） |','| --- | ---: | ---: |']
    lines += [f'| {q["probability"]:.0%} | {q["yield"]:.6%} | {q["equivalent_price_using_latest_annual"]:.4f}元 |' for q in quantiles]
    lines+=['','百分位采用经验分布逆函数，升序后取ceil(p*N)个值。30%分位表示约30%的历史日股息率不高于该值。',
            '历史股息率按当时已披露最新完整年度分红除以当天不复权收盘价计算，不能用今天每股股息直接除全部历史价格。',
            '对应股价仅为当前年度股息/分位股息率的代数换算，并非预测。当前分红记录回溯不具备历史方案修订逐日快照，历史送转可能影响名义每股口径。','',
            '## 接口实测','',
            f'- 指数估值stock_zh_index_value_csindex(symbol="601318")：{json.dumps(results["index_probe"],ensure_ascii=False)}',
            f'- 个股估值stock_value_em(symbol="601318")：{json.dumps(results["value_probe"],ensure_ascii=False)}',
            f'- 旧版乐咕个股接口是否存在：{json.dumps(results["legacy_functions"],ensure_ascii=False)}',
            '- 计算所需分红stock_fhps_detail_em及腾讯日线stock_zh_a_hist_tx均在线获取成功。','',
            '用户提供旧文档：https://akshare-hh.readthedocs.io/en/latest/data/index/index.html#id65',
            '当前指数文档：https://akshare.akfamily.xyz/data/index/index.html',
            '当前个股文档：https://akshare.akfamily.xyz/data/stock/stock.html']
    (out/'中国平安股息率分位实测.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(results,ensure_ascii=False,indent=2),flush=True)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':worker(sys.argv[2])
    else:main()
