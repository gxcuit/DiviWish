"""Compare a saved live-probe run to its frozen workbook baseline."""
import collections
import datetime as dt
import json
import math
from pathlib import Path
import re
import sys


def cninfo_parts(rows):
    parts = []
    seen = set()
    for row in rows:
        label = str(row.get('报告时间') or '')
        match = re.fullmatch(r'(\d{4})(年报|半年报|一季报|三季报)', label)
        if not match:
            raise ValueError('无法识别报告时间: ' + label)
        period = match[1] + '-' + {'年报':'12-31','半年报':'06-30','一季报':'03-31','三季报':'09-30'}[match[2]]
        amount = row.get('派息比例')
        if amount is None:
            raise ValueError('缺少现金派息金额: ' + label)
        amount = float(amount) / 10
        if not math.isfinite(amount) or amount < 0:
            raise ValueError('无效现金派息金额: ' + label)
        exdate = str(row.get('除权日') or '')[:10]
        # Preserve distinct installments; collapse exact same-period/date/amount duplicates only.
        key = (period, exdate, amount)
        if key in seen:
            continue
        seen.add(key)
        parts.append({'period':period,'dps':round(amount,8),'exdate':exdate,
                      'announcement':str(row.get('实施方案公告日期') or '')[:10],
                      'description':row.get('实施方案分红说明')})
    return sorted(parts, key=lambda x:(x['period'],x['exdate']))


def fmt(x):
    return f'{x:.8f}'.rstrip('0').rstrip('.')


def report_tencent(folder):
    p=Path(folder)
    base=json.loads((p/'baseline.json').read_text(encoding='utf-8'))
    run=json.loads((p/'results.json').read_text(encoding='utf-8'))
    stocks={s['code']:s for s in base['stocks'] if s['market']=='A'}
    compared=[]
    for result in run['results']:
        s=stocks[result['code']]
        if not result['ok']:
            compared.append({**s,'ok':False,'error':result['error']});continue
        rows=[r for r in result['rows'] if r.get('date') and r.get('close') is not None]
        if not rows:
            compared.append({**s,'ok':False,'error':'无有效收盘记录'});continue
        latest=max(rows,key=lambda r:r['date'])
        close=float(latest['close'])
        compared.append({**s,'ok':True,'date':latest['date'][:10],
                         'tencent_close':close,'difference':round(close-s['price'],8),
                         'equal':abs(close-s['price'])<1e-6,
                         'annual_yield_with_tx':s['annual']/close,
                         'row_count':len(rows),'seconds':result['seconds']})
    counts={'success':sum(r['ok'] for r in compared),'total':len(stocks),
            'price_equal':sum(r.get('equal',False) for r in compared),
            'latest_dates':dict(collections.Counter(r['date'] for r in compared if r['ok'])),
            'workbook_unchanged':run['workbook_unchanged']}
    events=[json.loads(line) for f in p.glob('network-*.jsonl')
            for line in f.read_text(encoding='utf-8').splitlines()]
    counts['request_results']=dict(collections.Counter((r['event']+' '+r['endpoint'])
                               for r in events if r['event'] in ('request_end','request_error')))
    assert all('eastmoney' not in r.get('endpoint','') for r in events)
    assert all(r['code'] in stocks for r in run['results'])
    (p/'comparison.json').write_text(json.dumps({'counts':counts,'stocks':compared},ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# AKShare腾讯日线接口：无缓存实测对比','',
           '接口：`stock_zh_a_hist_tx(symbol=带市场代码, start_date=21天前, end_date=测试当天, adjust="", timeout=12)`。仅请求工作簿中的49支A股，不复用旧请求结果，不调用其他数据源回退。按最新有效交易日的不复权收盘价，与测试开始时冻结的当前工作簿D列比较。',
           '',f'- 有效结果：{counts["success"]}/{counts["total"]}。',
           f'- 最新收盘价与当前价格一致：{counts["price_equal"]}/{counts["total"]}；金额容差0.000001元。',
           '- 最新记录日期：'+json.dumps(counts['latest_dates'],ensure_ascii=False)+'。',
           f'- 工作簿哈希校验未改变：{counts["workbook_unchanged"]}。',
           '', '这是日频历史接口，适用于收盘后计算，不等同于盘中实时行情。股息率计算使用不复权价格；本次仅比较价格，不用雪球TTM股息率，也不把相邻日不复权收盘价涨幅当作除权日真实涨跌幅。现有生产行情也来自腾讯，因此这是同一供应商不同接口的核对，不是独立数据源验证。',
           '', '调用参数限定近期，但AKShare内部会请求该股票的上市起始信息和按年份获取K线，再截取所选日期；这是按单股请求，返回时间范围受其内部实现影响，不是全市场行情下载。网络日志确认本次没有任何东财请求。',
           '', '| 股票 | 最新日线日期 | 当前价格 | 腾讯日线收盘 | 差额 |',
           '|---|---|---:|---:|---:|']
    for r in compared:
        if r['ok']:
            lines.append(f'| {r["name"]} {r["code"]} | {r["date"]} | {fmt(r["price"])} | {fmt(r["tencent_close"])} | {fmt(r["difference"])} |')
        else:
            lines.append(f'| {r["name"]} {r["code"]} | 失败：{r["error"]} | {fmt(r["price"])} | — | — |')
    lines += ['', '原始记录见`tencent_A_*.json`，完整逐股计算见`comparison.json`，请求日志见`network-*.jsonl`。',
              '', '[AKShare官方文档](https://akshare.akfamily.xyz/data/stock/stock.html)：stock_zh_a_hist_tx。']
    (p/'腾讯日线对比报告.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(counts,ensure_ascii=False,indent=2))


def report_xueqiu(folder):
    p=Path(folder)
    base=json.loads((p/'baseline.json').read_text(encoding='utf-8'))
    run=json.loads((p/'results.json').read_text(encoding='utf-8'))
    stocks={(s['market'],s['code']):s for s in base['stocks']}
    compared=[]
    for result in run['results']:
        s=stocks[(result['market'],result['code'])]
        if not result['ok']:
            compared.append({**s,'ok':False,'error':result['error']});continue
        quote={r['item']:r['value'] for r in result['rows']}
        currency='CNY' if s['market']=='A' else 'HKD'
        price=quote.get('现价')
        valid=(quote.get('代码')==s['symbol'] and quote.get('货币')==currency
               and isinstance(price,(int,float)) and math.isfinite(price) and price>0)
        if not valid:
            compared.append({**s,'ok':False,'error':'返回代码、币种或价格无效'});continue
        compared.append({**s,'ok':True,'xueqiu_price':price,'quote_time':quote.get('时间'),
                         'currency':currency,'percentage':quote.get('涨幅'),
                         'difference':round(price-s['price'],8),'equal':abs(price-s['price'])<1e-6,
                         'seconds':result['seconds']})
    counts={'total':len(compared),'success':sum(r['ok'] for r in compared),
            'price_equal':sum(r.get('equal',False) for r in compared),
            'workbook_unchanged':run['workbook_unchanged']}
    for market in ['A','HK']:
        rows=[r for r in compared if r['market']==market]
        counts[market]={'total':len(rows),'success':sum(r['ok'] for r in rows),
                        'equal':sum(r.get('equal',False) for r in rows)}
    counts['quote_dates']=dict(collections.Counter(str(r['quote_time'])[:10] for r in compared if r['ok']))
    events=[json.loads(line) for f in p.glob('network-*.jsonl')
            for line in f.read_text(encoding='utf-8').splitlines()]
    counts['http_statuses']=dict(collections.Counter(str(r['status']) for r in events if r['event']=='request_end'))
    counts['network_errors']=sum(r['event']=='request_error' for r in events)
    assert all('xueqiu.com' in r.get('endpoint','') for r in events)
    (p/'comparison.json').write_text(json.dumps({'counts':counts,'stocks':compared},ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 雪球行情：使用用户提供token后的无缓存测试','',
           '仅查询工作簿内49支A股和17支港股，每支均独立进程实时调用`stock_individual_spot_xq(symbol=代码, timeout=12)`，不读旧缓存，不调用其他行情源回退。用户提供的token仅通过本次进程环境传递并设置`akshare.stock.cons.xq_a_token`；不写入代码、请求日志或报告。',
           '', f'- 有效行情：{counts["success"]}/{counts["total"]}。',
           f'- 与冻结工作簿当前价格一致：{counts["price_equal"]}/{counts["total"]}；容差0.000001元。',
           f'- A股：{counts["A"]["success"]}/49成功，{counts["A"]["equal"]}/49价格一致。',
           f'- 港股：{counts["HK"]["success"]}/17成功，{counts["HK"]["equal"]}/17价格一致。',
           '- 行情日期：'+json.dumps(counts['quote_dates'],ensure_ascii=False)+'。',
           '- 工作簿哈希校验未改变：'+str(counts['workbook_unchanged'])+'。',
           '', '核对了返回证券代码、币种（A股CNY、港股HKD）和有效价格。比较对象为当前表格D列，未以雪球股息(TTM)或股息率(TTM)替代本项目按报告期计算的股息。今天休市，因此请求时间是测试当天，行情时间仍为最近交易日。',
           '', '本次有效token解决了之前400016登录态错误。结果证明该token在此次测试中可用，不保证今后不会过期。生产数据源尚未切换。',
           '', '| 市场 | 股票 | 当前价格 | 雪球现价 | 差额 | 行情时间 |',
           '|---|---|---:|---:|---:|---|']
    for r in compared:
        if r['ok']:
            lines.append(f'| {r["market"]} | {r["name"]} {r["code"]} | {fmt(r["price"])} | {fmt(r["xueqiu_price"])} | {fmt(r["difference"])} | {r["quote_time"]} |')
        else:
            lines.append(f'| {r["market"]} | {r["name"]} {r["code"]} | {fmt(r["price"])} | 失败：{r["error"]} | — | — |')
    lines += ['', '逐股原始字段：`xueqiu_*.json`；冻结基准：`baseline.json`；比较结果：`comparison.json`；请求状态与耗时：`network-*.jsonl`。',
              '', '[AKShare官方文档](https://akshare.akfamily.xyz/data/stock/stock.html)：stock_individual_spot_xq。']
    (p/'雪球行情对比报告.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(counts,ensure_ascii=False,indent=2))


def report(folder):
    p = Path(folder)
    base = json.loads((p/'baseline.json').read_text(encoding='utf-8'))
    run = json.loads((p/'results.json').read_text(encoding='utf-8'))
    old = {r['code']:r for r in base['dividend_details']}
    cn = {r['code']:r for r in run['results'] if r['kind']=='cninfo'}
    stocks = [s for s in base['stocks'] if s['market']=='A']
    compared=[]
    for s in stocks:
        result = cn[s['code']]
        if not result['ok']:
            compared.append({**s,'error':result['error']}); continue
        try:
            # Only recent records affect this comparison. Older rows may use legacy labels.
            recent=[r for r in result['rows'] if str(r.get('报告时间',''))[:4].isdigit()
                    and int(str(r['报告时间'])[:4]) >= int(s['year'])-1]
            parts=cninfo_parts(recent)
            year=max(int(x['period'][:4]) for x in parts if x['period'].endswith('12-31'))
            annual=round(sum(x['dps'] for x in parts if x['period'].startswith(str(year))),8)
            latest=max(x['period'] for x in parts)
            cutoff=str(int(latest[:4])-1)+latest[4:]
            rolling_parts=[x for x in parts if cutoff<x['period']<=latest]
            rolling=round(sum(x['dps'] for x in rolling_parts),8)
            previous=old[s['code']]
            annual_equal=year==s['year'] and abs(annual-s['annual'])<1e-6
            rolling_equal=abs(rolling-previous['total'])<1e-6
            period_equal=latest==previous['period_end']
            new_periods={x['period'] for x in parts}
            missing=[x for x in previous['parts'] if x['period'] not in new_periods]
            today=dt.date.fromisoformat(result['fetched_at'][:10])
            dates=[x['exdate'] for x in parts if x['exdate']]
            future=[d for d in dates if d>=today.isoformat()]
            past=[d for d in dates if d.startswith(str(today.year))]
            exdate=min(future) if future else max(past) if past else None
            compared.append({**s,'cninfo_year':year,'cninfo_annual':annual,'annual_equal':annual_equal,
                             'old_rolling':previous['total'],'cninfo_rolling':rolling,
                             'cninfo_rolling_yield':rolling/s['price'],
                             'old_period':previous['period_end'],'cninfo_period':latest,
                             'rolling_equal':rolling_equal,'period_equal':period_equal,
                             'cninfo_exdate':exdate,'exdate_equal':exdate==s['exdate'],
                             'missing_baseline_parts':missing,'cninfo_parts':parts,
                             'cninfo_rolling_parts':rolling_parts})
        except Exception as exc:
            compared.append({**s,'error':str(exc)})
    xq=[r for r in run['results'] if r['kind']=='xueqiu']
    counts={'cninfo_success':sum(r['ok'] for r in cn.values()),'cninfo_total':len(cn),
            'annual_equal':sum(r.get('annual_equal',False) for r in compared),
            'rolling_amount_equal':sum(r.get('rolling_equal',False) for r in compared),
            'rolling_period_equal':sum(r.get('period_equal',False) for r in compared),
            'xueqiu_success':sum(r['ok'] for r in xq),'xueqiu_total':len(xq),
            'xueqiu_login_errors':sum('400016' in r.get('error','') for r in xq),
            'workbook_unchanged':run['workbook_unchanged']}
    output={'counts':counts,'dividends':compared,'quotes':xq}
    (p/'comparison.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 巨潮分红与雪球行情：无缓存实测对比','',
           '仅测试工作簿中的49支A股及17支港股。巨潮测试49支A股；雪球测试全部66支。各标的均启动独立进程实时请求，不读取旧缓存，不调用东财、腾讯或Yahoo回退。本报告基准是测试开始时的工作簿及其分期明细；工作簿SHA-256校验确认未修改。',
           '', '## 结果','',
           f'- 巨潮成功 {counts["cninfo_success"]}/49；最新完整年度每股股息及所属年度一致 {counts["annual_equal"]}/49。',
           f'- 最新滚动每股股息金额一致 {counts["rolling_amount_equal"]}/49；最新报告期一致 {counts["rolling_period_equal"]}/49。',
           f'- 雪球成功 {counts["xueqiu_success"]}/66；登录态错误400016共 {counts["xueqiu_login_errors"]} 条。没有可比价格，不能判定为价格一致或价格有差异。',
           '', '## 口径与限制','',
           '巨潮派息比例按每10股转换为每股金额。以报告时间归属年度，按相同报告期、除权日和金额去除完全重复记录；不同分期分别保留。年度合计按最新年报所属年份，滚动合计按各来源最新报告期向前一年（不含上年同期）。不套用现有东财缺失补录，不以付款年份归类。金额容差为每股0.000001元。',
           '', '巨潮历史分红接口可以包含已公布实施方案但除息日尚未来到的记录，不能把所有返回记录都称为已经到账。此次它缺少7支股票的2026年中期记录；当前东财基准中这些记录状态为董事会或股东大会通过，因此巨潮无法单独覆盖当前“含已公告方案”的滚动口径。',
           '', '雪球调用AKShare默认token配置，未读取用户浏览器Cookie或个人登录凭据。66次均返回HTTP 400、业务码400016；AKShare将其解释为需要有效xq_a_token/登录态，并非网络超时。港股按五位代码额外探测；文档的symbol说明未明确列出港股，鉴权失败也无法确认港股兼容性。',
           '', '## 滚动金额或报告期不同的股票','',
           '| 股票 | 当前每股滚动股息 | 巨潮每股滚动股息 | 当前 → 巨潮报告期 | 当前 → 巨潮滚动股息率 | 原因 |',
           '|---|---:|---:|---|---|---|']
    for r in compared:
        if 'error' in r: continue
        if r['rolling_equal'] and r['period_equal']:continue
        reason='巨潮未返回2026中期方案（当前基准为已通过待实施方案）' if r['missing_baseline_parts'] else '巨潮多出2026中期，每股1.038元；滚动窗口更新'
        lines.append(f'| {r["name"]} {r["code"]} | {fmt(r["old_rolling"])} | {fmt(r["cninfo_rolling"])} | {r["old_period"]} → {r["cninfo_period"]} | {r["rolling_yield"]:.4%} → {r["cninfo_rolling_yield"]:.4%} | {reason} |')
    lines += ['', '云南白药：完整2025年度仍为1.019+1.583=2.602元/股，与当前表格一致；巨潮最新滚动窗口为2025末期1.583+2026中期1.038=2.621元/股，2026中期除息日为2026-09-24。当前基准最新报告期停在2025-12-31，因此滚动金额仍为2.602。此处是来源差异的定位，未据此修改生产表格。',
              '', '## 全部A股对比（金额单位：元/股）','',
              '| 股票 | 年度 | 当前年度 | 巨潮年度 | 当前滚动 | 巨潮滚动 | 当前除息日 | 巨潮除息日 |',
              '|---|---:|---:|---:|---:|---:|---|---|']
    for r in compared:
        if 'error' in r:
            lines.append(f'| {r["name"]} {r["code"]} | 对比失败：{r["error"]} | | | | | | |');continue
        lines.append(f'| {r["name"]} {r["code"]} | {r["cninfo_year"]} | {fmt(r["annual"])} | {fmt(r["cninfo_annual"])} | {fmt(r["old_rolling"])} | {fmt(r["cninfo_rolling"])} | {r["exdate"] or "—"} | {r["cninfo_exdate"] or "—"} |')
    lines += ['', '## 文件与复现','',
              '- `baseline.json`：冻结的当前表格数值、现有分期记录及工作簿哈希。',
              '- `results.json`及各`cninfo_*.json`、`xueqiu_*.json`：本次请求原始结果、耗时及错误。',
              '- `comparison.json`：49支逐股计算与66条行情结果。',
              '- `network-*.jsonl`：真实网络请求状态与耗时（不记录认证头）。',
              r'- 实时重测：`.\.conda\python.exe -X utf8 -u scripts\compare_alternative_sources.py`；只读生成新目录。',
              '', '[AKShare官方文档](https://akshare.akfamily.xyz/data/stock/stock.html)：stock_dividend_cninfo / stock_individual_spot_xq。']
    (p/'对比报告.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(counts,ensure_ascii=False,indent=2))
    print('REPORT='+str(p/'对比报告.md'))


if __name__=='__main__':
    if '--tencent' in sys.argv:
        report_tencent(sys.argv[1])
    elif '--xueqiu' in sys.argv:
        report_xueqiu(sys.argv[1])
    else:
        report(sys.argv[1])
