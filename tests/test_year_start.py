import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock,patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from year_start import year_from_header,first_session,session_close,prepare


class YearStartTest(unittest.TestCase):
    def test_year_comes_from_header(self):
        self.assertEqual(year_from_header('26初价格',dt.date(2027,4,1)),2026)
        self.assertEqual(year_from_header('2026初价格'),2026)
        self.assertEqual(year_from_header('年初价格',dt.date(2027,4,1)),2027)

    def test_first_market_session_handles_new_year_holiday(self):
        rows=[{'trade_date':'2026-01-06'},{'trade_date':'2026-01-05'},{'trade_date':'2025-12-31'}]
        self.assertEqual(first_session(rows,2026,dt.date(2026,10,19)),dt.date(2026,1,5))

    def test_missing_first_session_does_not_use_later_resume_or_listing(self):
        with self.assertRaisesRegex(ValueError,'缺少'):
            session_close([{'date':'2026-01-06','close':30}],dt.date(2026,1,5))

    def test_conflicting_and_invalid_prices_are_exposed(self):
        for rows in [[{'date':'2026-01-05','close':None}],
                     [{'date':'2026-01-05','close':20},{'date':'2026-01-05','close':21}]]:
            with self.subTest(rows=rows),self.assertRaises(ValueError):session_close(rows,dt.date(2026,1,5))

    def test_existing_values_are_preserved_without_network(self):
        with patch('data_sources._run_ak') as fetch:
            result=prepare([{'code':'000807','name':'云铝股份'}],{'000807':33.78},'26初价格')
        fetch.assert_not_called()
        self.assertEqual(result[0]['year_start']['price'],33.78)
        self.assertEqual(result[0]['year_start']['status'],'preserved')

    def test_fresh_history_is_reused_and_result_is_reused_in_final_pass(self):
        cache=Mock();cache.read.return_value={'full_checked_on':'2026-10-19','rows':[{'date':'2026-01-05','close':33.78}]}
        fetch=Mock(return_value={'rows':[{'trade_date':'2026-01-05'}]})
        with patch('data_sources._run_ak',fetch),patch('history_percentile.cache_settings',return_value=(cache,'v',False)):
            records=prepare([{'code':'000807','name':'云铝股份'}],{},'26初价格',dt.date(2026,10,19))
            prepare(records,{},'26初价格',dt.date(2026,10,19))
        fetch.assert_called_once_with('calendar')
        self.assertEqual(records[0]['year_start']['price'],33.78)
        self.assertEqual(records[0]['year_start']['date'],'2026-01-05')

    def test_uncached_stock_requests_exact_session_only(self):
        cache=Mock();cache.read.return_value=None
        fetch=Mock(side_effect=[{'rows':[{'trade_date':'2026-01-05'}]},
                               {'rows':[{'date':'2026-01-05','close':4.55}]}])
        with patch('data_sources._run_ak',fetch),patch('history_percentile.cache_settings',return_value=(cache,'v',False)):
            records=prepare([{'code':'000100','name':'TCL科技'}],{},'26初价格',dt.date(2026,10,19))
        self.assertEqual(records[0]['year_start']['price'],4.55)
        self.assertEqual(fetch.call_args_list[-1].kwargs,{'start_date':'2026-01-05','end_date':'2026-01-05'})

    def test_calendar_failure_keeps_missing_price_unavailable(self):
        with patch('data_sources._run_ak',side_effect=TimeoutError('calendar timeout')):
            records=prepare([{'code':'000100','name':'TCL科技'}],{},'26初价格',dt.date(2026,10,19))
        self.assertIsNone(records[0]['year_start']['price'])
        self.assertIn('timeout',records[0]['year_start']['error'])
