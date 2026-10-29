import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from historical_cache import HistoricalCache,history_start
from history_percentile import backcast


class HistoricalCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.day=dt.date(2026,10,16)
        self.cache=HistoricalCache(self.temp.name,today=dt.date(2026,10,18))
        self.rows=[{'date':'2026-10-15','close':10},{'date':'2026-10-16','close':20}]

    def seed(self):
        return self.cache.seed_prices('601318',self.rows,self.day)

    def test_no_new_trade_date_reuses_history_without_request(self):
        self.seed();fetch=Mock()
        rows,status=self.cache.prices('601318',self.day,False,fetch)
        fetch.assert_not_called()
        self.assertEqual(status['prices'],'hit')
        self.assertEqual(rows,self.rows)

    def test_new_date_fetches_overlap_and_merges_corrections(self):
        self.seed()
        fetch=Mock(return_value=[{'date':'2026-10-16','close':21},{'date':'2026-10-19','close':22}])
        rows,status=self.cache.prices('601318',dt.date(2026,10,19),False,fetch)
        self.assertEqual(status['prices'],'incremental')
        self.assertEqual(fetch.call_args.args[1],dt.date(2026,9,16))
        self.assertEqual([r['close'] for r in rows],[10,21,22])

    def test_empty_increment_does_not_overwrite_valid_file(self):
        self.seed();before=self.cache.path('prices','601318').read_bytes()
        with self.assertRaises(ValueError):
            self.cache.prices('601318',dt.date(2026,10,19),False,Mock(return_value=[]))
        self.assertEqual(before,self.cache.path('prices','601318').read_bytes())

    def test_failure_does_not_overwrite_valid_file(self):
        self.seed();before=self.cache.path('prices','601318').read_bytes()
        with self.assertRaises(TimeoutError):
            self.cache.prices('601318',dt.date(2026,10,19),False,Mock(side_effect=TimeoutError()))
        self.assertEqual(before,self.cache.path('prices','601318').read_bytes())

    def test_missing_newest_day_does_not_claim_freshness(self):
        self.seed()
        with self.assertRaisesRegex(ValueError,'最新交易日'):
            self.cache.prices('601318',dt.date(2026,10,19),False,Mock(return_value=self.rows))

    def test_corruption_requests_full_history(self):
        self.seed()
        self.cache.path('prices','601318').write_text('{bad',encoding='utf-8')
        fetch=Mock(return_value=self.rows)
        _,status=self.cache.prices('601318',self.day,False,fetch)
        self.assertEqual(status['prices'],'full')
        self.assertEqual(fetch.call_args.args[1],history_start(self.day))

    def test_valid_json_with_changed_content_fails_digest(self):
        self.seed();path=self.cache.path('prices','601318')
        record=json.loads(path.read_text(encoding='utf-8'))
        record['payload']['rows'][0]['close']=99
        path.write_text(json.dumps(record),encoding='utf-8')
        self.assertIsNone(self.cache.read('prices','601318'))

    def test_provider_version_change_invalidates_history(self):
        self.seed()
        cache=HistoricalCache(self.temp.name,today=self.cache.today,source='other-version')
        _,status=cache.prices('601318',self.day,False,Mock(return_value=self.rows))
        self.assertEqual(status['prices'],'full')

    def test_weekly_overlap_and_monthly_full_checks(self):
        self.seed()
        weekly=HistoricalCache(self.temp.name,today=dt.date(2026,10,25))
        _,status=weekly.prices('601318',self.day,False,Mock(return_value=self.rows))
        self.assertEqual(status['prices'],'incremental')
        monthly=HistoricalCache(self.temp.name,today=dt.date(2026,11,18))
        _,status=monthly.prices('601318',self.day,False,Mock(return_value=self.rows))
        self.assertEqual(status['prices'],'full')

    def test_intraday_bar_not_persisted_and_close_refetched(self):
        self.seed()
        monday=dt.date(2026,10,19)
        fetch=Mock(return_value=self.rows+[{'date':monday.isoformat(),'close':30}])
        rows,_=self.cache.prices('601318',monday,True,fetch)
        self.assertEqual(rows,self.rows)
        self.cache.prices('601318',monday,True,Mock(side_effect=AssertionError('unexpected request')))
        rows,status=self.cache.prices('601318',monday,False,fetch)
        self.assertEqual(rows[-1]['date'],monday.isoformat())
        self.assertEqual(status['prices'],'incremental')

    def test_force_bypasses_history_cache(self):
        self.seed();fetch=Mock(return_value=self.rows)
        _,status=self.cache.prices('601318',self.day,False,fetch,force=True)
        self.assertEqual(status['prices'],'full')
        fetch.assert_called_once()

    def test_fingerprint_reuses_series_but_recalculates_price_dependent_rank(self):
        items=[{'REPORT_DATE':'2025-12-31','ASSIGN_PROGRESS':'实施分配','PLAN_NOTICE_DATE':'2026-03-01','PRETAX_BONUS_RMB':10}]
        builder=Mock(side_effect=lambda i,p,y,d:backcast(i,p,y,d,min_samples=1))
        result,status=self.cache.distribution('601318',items,self.rows,.05,self.day,'v1',builder)
        self.assertEqual(result['percentile'],.5)
        result,status=self.cache.distribution('601318',list(reversed(items)),self.rows,.1,self.day,'v1',builder)
        self.assertEqual(status['calculation'],'hit')
        self.assertEqual(result['percentile'],1)
        self.assertEqual(builder.call_count,1)
        revised=[{**items[0],'PRETAX_BONUS_RMB':20}]
        self.cache.distribution('601318',revised,self.rows,.1,self.day,'v1',builder)
        self.assertEqual(builder.call_count,2)
        self.cache.distribution('601318',revised,self.rows,.1,self.day,'v2',builder)
        self.assertEqual(builder.call_count,3)

    def test_announcement_date_or_historical_price_change_rebuilds(self):
        items=[{'REPORT_DATE':'2025-12-31','ASSIGN_PROGRESS':'实施分配','PLAN_NOTICE_DATE':'2026-03-01','PRETAX_BONUS_RMB':10}]
        builder=Mock(side_effect=lambda i,p,y,d:backcast(i,p,y,d,min_samples=1))
        self.cache.distribution('601318',items,self.rows,.1,self.day,'v1',builder)
        revised=[{**items[0],'PLAN_NOTICE_DATE':'2026-03-02'}]
        self.cache.distribution('601318',revised,self.rows,.1,self.day,'v1',builder)
        prices=[{**self.rows[0],'close':11},self.rows[1]]
        self.cache.distribution('601318',revised,prices,.1,self.day,'v1',builder)
        self.assertEqual(builder.call_count,3)

    def test_invalid_calculation_does_not_replace_good_distribution(self):
        items=[{'REPORT_DATE':'2025-12-31','ASSIGN_PROGRESS':'实施分配','PLAN_NOTICE_DATE':'2026-03-01','PRETAX_BONUS_RMB':10}]
        builder=lambda i,p,y,d:backcast(i,p,y,d,min_samples=1)
        self.cache.distribution('601318',items,self.rows,.1,self.day,'v1',builder)
        before=self.cache.path('distribution','601318').read_bytes()
        with self.assertRaises(ValueError):
            self.cache.distribution('601318',items,self.rows,.1,self.day,'bad',Mock(side_effect=ValueError('missing data')))
        self.assertEqual(before,self.cache.path('distribution','601318').read_bytes())
