import sys
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import data_sources as ds
import update_dy


class DataSourcesTest(unittest.TestCase):
    def setUp(self):
        ds.reset_run()

    def tearDown(self):
        ds.reset_run()

    def test_dividend_units_and_report_period_preserved(self):
        item = ds.normalize_dividends([{'报告期':'2025-12-31', '方案进度':'实施分配',
                                       '现金分红-现金分红比例':22.012,
                                       '除权除息日':'2026-06-05'}])[0]
        self.assertEqual(item['REPORT_DATE'], '2025-12-31')
        self.assertAlmostEqual(update_dy._parse_dps(item), 2.2012)

    def test_empty_response_uses_fallback(self):
        fallback = Mock(return_value=([{'REPORT_DATE':'2025-12-31'}], 'legacy'))
        with patch.object(ds, '_run_ak', return_value={'rows':[], 'version':'test'}):
            self.assertEqual(ds.dividend_records('600941', fallback)[1], 'legacy')
            ds.dividend_records('600941', fallback)
        fallback.assert_called_once()

    def test_exception_uses_fallback(self):
        fallback = Mock(return_value=([], 'legacy'))
        with patch.object(ds, '_run_ak', side_effect=TimeoutError('timeout')):
            self.assertEqual(ds.dividend_records('601318', fallback)[1], 'legacy')

    def test_production_quotes_use_tencent_without_akshare(self):
        expected = {'601318':(51.88,.01,'2026-10-16'),'600941':(101.4,.02,'2026-10-16')}
        with patch.object(ds, 'ashare_quotes') as akshare, \
             patch.object(update_dy, '_fetch_ashare_prices_legacy', return_value=expected) as legacy:
            result = update_dy._fetch_ashare_prices_batch(['601318','600941'])
        legacy.assert_called_once_with(['601318','600941'])
        akshare.assert_not_called()
        self.assertEqual(result, expected)

    def test_percentage_is_converted_once(self):
        with patch.object(ds, '_run_ak', return_value={'rows':[{'代码':'601318','最新价':51.88,'涨跌幅':2.27}], 'trade_date':'2026-10-16'}):
            self.assertAlmostEqual(ds.ashare_quotes(['601318'])['601318'][1], .0227)

    def test_quotes_request_only_unique_requested_codes_and_one_calendar(self):
        def response(kind, code=None):
            if kind == 'calendar':
                return {'trade_date':'2026-10-16'}
            return {'rows':[{'代码':code,'最新价':50,'涨跌幅':-2}]}
        with patch.object(ds, '_run_ak', side_effect=response) as run:
            result = ds.ashare_quotes(['601318','000001','601318'])
        self.assertEqual(set(result), {'601318','000001'})
        self.assertCountEqual([c.args for c in run.call_args_list],
                              [('ashare','601318'),('ashare','000001'),('calendar',)])
        self.assertEqual(result['000001'], (50,-.02,'2026-10-16'))

    def test_single_ak_quote_failure_preserves_other_experimental_quotes(self):
        def response(kind, code=None):
            if kind == 'calendar':
                return {'trade_date':'2026-10-16'}
            if code == '600941':
                raise TimeoutError('test')
            return {'rows':[{'代码':code,'最新价':51.88,'涨跌幅':1}]}
        with patch.object(ds, '_run_ak', side_effect=response):
            result = ds.ashare_quotes(['601318','600941'])
        self.assertNotIn('600941', result)
        self.assertEqual(result['601318'], (51.88,.01,'2026-10-16'))

    def test_tencent_quote_price_percentage_date_and_symbol_scope(self):
        fields = [''] * 33
        fields[2], fields[3], fields[30], fields[32] = '601318', '51.88', '20261016150000', '2.27'
        payload = ('v_sh601318="' + '~'.join(fields) + '";').encode('gbk')
        with patch.object(update_dy, 'http_get', return_value=payload) as get:
            result = update_dy._fetch_ashare_prices_batch(['601318'])
        get.assert_called_once_with('https://qt.gtimg.cn/q=sh601318')
        self.assertEqual(result['601318'], (51.88,.0227,'2026-10-16'))

    def test_hk_uses_requested_symbol_without_akshare_market_scan(self):
        import json
        payload = {'chart':{'result':[{'meta':{'regularMarketPrice':8.48}}]}}
        with patch.object(update_dy, 'http_get', return_value=json.dumps(payload).encode()) as get, \
             patch.object(ds, '_run_ak') as run:
            price, _ = update_dy._fetch_hk_info('03328')
        self.assertEqual(price, 8.48)
        self.assertIn('/chart/3328.HK?', get.call_args.args[0])
        run.assert_not_called()

    def test_repeated_timeouts_open_circuit(self):
        with patch.object(ds.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker',40)) as run:
            for _ in range(3):
                with self.assertRaises(subprocess.TimeoutExpired):
                    ds._run_ak('ashare')
            with self.assertRaises(RuntimeError):
                ds._run_ak('ashare')
        self.assertEqual(run.call_count, 3)

    def test_latest_quotes_online_even_when_old_snapshot_is_valid(self):
        old={'ashare_prices':{'ts':9999999999,'data':{'601318':1}}}
        with patch.object(update_dy,'CACHE',old), patch.object(update_dy,'price_cache_valid',return_value=True), \
             patch.object(update_dy,'_fetch_ashare_prices_batch',return_value={'601318':(50,0,'2026-10-16')}) as fetch:
            self.assertEqual(update_dy.get_ashare_prices(['601318'])['601318'],50)
        fetch.assert_called_once_with(['601318'])

    def test_hk_quotes_and_dates_online_despite_old_snapshot(self):
        import openpyxl
        wb=openpyxl.Workbook();wb.active.title='港股数据'
        ws=wb.active
        ws.append(['名称','港股代码','A股代码']);ws.append(['平安','02318','601318'])
        old={'hk_prices':{'ts':9999999999,'data':{'02318':1}},
             'hk_dividends':{'ts':9999999999,'data':{'02318':'old'}}}
        with patch.object(update_dy,'CACHE',old),patch.object(update_dy,'price_cache_valid',return_value=True), \
             patch.object(update_dy,'_fetch_hk_info',return_value=(60,'2026-10-01')) as fetch, \
             patch.object(update_dy,'_update_hk_derived') as fx,patch.object(update_dy.time,'sleep'):
            update_dy.update_hkstock_sheet(wb,wb,{'601318':50})
        fetch.assert_called_once_with('02318');fx.assert_called_once()
        self.assertEqual(ws.cell(2,4).value,60)

    def test_history_date_range_passed_to_worker(self):
        response=Mock(stdout='AKSHARE_RESULT={"rows":[]}',stderr='')
        with patch.object(ds.subprocess,'run',return_value=response) as run:
            ds._run_ak('history','601318',start_date='2026-09-01',end_date='2026-10-16')
        self.assertEqual(run.call_args.args[0][-3:],['601318','2026-09-01','2026-10-16'])

    def test_dividends_rechecked_in_next_run(self):
        valid={'rows':[{'报告期':'2025-12-31','方案进度':'实施分配','现金分红-现金分红比例':10}],'version':'test'}
        with patch.object(ds,'_run_ak',return_value=valid) as fetch:
            ds.dividend_records('601318',Mock());ds.dividend_records('601318',Mock())
            self.assertEqual(fetch.call_count,1)
            ds.reset_run();ds.dividend_records('601318',Mock())
            self.assertEqual(fetch.call_count,2)

    def test_malformed_cash_amount_falls_back(self):
        bad = {'rows':[{'报告期':'2025-12-31','方案进度':'实施分配'}], 'version':'test'}
        fallback = Mock(return_value=([], 'legacy'))
        with patch.object(ds, '_run_ak', return_value=bad):
            self.assertEqual(ds.dividend_records('601318', fallback)[1], 'legacy')
        fallback.assert_called_once()
