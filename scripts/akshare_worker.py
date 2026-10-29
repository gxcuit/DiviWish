"""Isolate upstream calls so a stalled AKShare request can be terminated."""
import datetime as dt
import json
import sys
from network_diagnostics import install
install()
import akshare as ak

kind = sys.argv[1]
if kind == 'dividends':
    frame = ak.stock_fhps_detail_em(symbol=sys.argv[2])
elif kind == 'ashare':
    code = sys.argv[2]
    frame = ak.stock_bid_ask_em(symbol=code)
    quote = dict(zip(frame['item'], frame['value']))
    result = {'rows': [{'代码': code, '最新价': quote.get('最新'), '涨跌幅': quote.get('涨幅')}],
              'version': ak.__version__}
elif kind == 'calendar':
    frame = ak.tool_trade_date_hist_sina()
elif kind == 'history':
    today = dt.date.today()
    start = today.replace(year=today.year-5, day=min(today.day,28)) - dt.timedelta(days=14)
    if len(sys.argv) > 3:
        start = dt.date.fromisoformat(sys.argv[3])
        today = dt.date.fromisoformat(sys.argv[4])
    code = sys.argv[2]
    frame = ak.stock_zh_a_hist_tx(symbol=('sh' if code.startswith('6') else 'sz')+code,
             start_date=start.strftime('%Y%m%d'), end_date=today.strftime('%Y%m%d'),
             adjust='', timeout=12)
else:
    raise ValueError('Unsupported request')
if kind != 'ashare':
    result = {'rows': json.loads(frame.to_json(orient='records', date_format='iso')),
              'version': ak.__version__}
if kind == 'calendar':
    cutoff = dt.date.today()
    if dt.datetime.now().time() < dt.time(9, 30):
        cutoff -= dt.timedelta(days=1)
    dates = [str(d)[:10] for d in frame['trade_date'] if str(d)[:10] <= cutoff.isoformat()]
    if not dates:
        raise ValueError('Missing trading calendar')
    result['trade_date'] = max(dates)
print('AKSHARE_RESULT=' + json.dumps(result, ensure_ascii=False, allow_nan=False))
