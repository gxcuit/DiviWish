import datetime as dt
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from history_percentile import backcast,historical_end


def plan(period,amount,notice,**extra):
    return {'REPORT_DATE':period,'PRETAX_BONUS_RMB':amount*10,
            'PLAN_NOTICE_DATE':notice,'ASSIGN_PROGRESS':'实施分配',**extra}


class HistoricalPercentileTest(unittest.TestCase):
    def test_intraday_reference_excludes_incomplete_current_bar(self):
        rows=[{'date':'2026-10-15','close':10},{'date':'2026-10-16','close':11}]
        self.assertEqual(historical_end(rows,dt.date(2026,10,16),True),dt.date(2026,10,15))
        self.assertEqual(historical_end(rows,dt.date(2026,10,16),False),dt.date(2026,10,16))

    def test_annual_amount_changes_only_after_announcement(self):
        items=[plan('2023-12-31',1,'2024-03-01'),plan('2024-06-30',.5,'2024-08-01'),
               plan('2024-12-31',1.5,'2025-03-01')]
        rows=[{'date':d,'close':10} for d in ['2025-02-28','2025-03-01','2025-03-03']]
        result=backcast(items,rows,.2,dt.date(2025,3,3),min_samples=1)
        self.assertEqual([s['annual'] for s in result['samples']],[1,1,2])
        self.assertEqual([s['year'] for s in result['samples']],[2023,2023,2024])
        self.assertEqual(result['percentile'],1)

    def test_future_dividend_never_applied_to_past_prices(self):
        items=[plan('2024-12-31',1,'2025-03-01'),plan('2025-12-31',9,'2026-03-01')]
        result=backcast(items,[{'date':'2025-03-03','close':10}],.1,dt.date(2025,3,3),min_samples=1)
        self.assertEqual(result['samples'][0]['annual'],1)

    def test_interim_does_not_replace_complete_fiscal_year(self):
        items=[plan('2024-12-31',1,'2025-03-01'),plan('2025-06-30',5,'2025-08-01')]
        result=backcast(items,[{'date':'2025-08-04','close':10}],.1,dt.date(2025,8,4),min_samples=1)
        self.assertEqual(result['samples'][0]['annual'],1)

    def test_percentile_uses_distribution_and_counts_equal_values(self):
        items=[plan('2024-12-31',1,'2025-03-01')]
        rows=[{'date':'2025-03-03','close':20},{'date':'2025-03-04','close':10},{'date':'2025-03-05','close':5}]
        result=backcast(items,rows,.1,dt.date(2025,3,5),min_samples=1)
        self.assertAlmostEqual(result['percentile'],2/3)

    def test_missing_dates_are_not_guessed_from_reporting_period(self):
        with self.assertRaisesRegex(ValueError,'披露日期'):
            backcast([plan('2024-12-31',1,None)],[{'date':'2025-03-03','close':10}],.1,dt.date(2025,3,3),min_samples=1)

    def test_undated_legacy_supplement_uses_exdate_conservatively(self):
        items=[plan('2024-06-30',.5,None,EX_DIVIDEND_DATE='2024-09-01'),plan('2024-12-31',1,'2025-03-01')]
        result=backcast(items,[{'date':'2025-03-03','close':10}],.15,dt.date(2025,3,3),min_samples=1)
        self.assertEqual(result['samples'][0]['annual'],1.5)
        self.assertTrue(result['warnings'])

    def test_stale_history_is_unavailable(self):
        with self.assertRaisesRegex(ValueError,'估值日'):
            backcast([plan('2024-12-31',1,'2025-03-01')],[{'date':'2025-03-03','close':10}],.1,dt.date(2025,3,4),min_samples=1)

    def test_samples_before_first_complete_year_are_excluded(self):
        result=backcast([plan('2024-12-31',1,'2025-03-01')],
                        [{'date':'2025-02-28','close':10},{'date':'2025-03-03','close':10}],.1,dt.date(2025,3,3),min_samples=1)
        self.assertEqual(result['count'],1)
        self.assertEqual(result['start'],'2025-03-03')

    def test_zero_dividend_and_leap_year_window(self):
        items=[plan('2023-12-31',0,'2024-02-27')]
        result=backcast(items,[{'date':'2024-02-29','close':10}],0,dt.date(2024,2,29),min_samples=1)
        self.assertEqual(result['requested_start'],'2019-02-28')
        self.assertEqual(result['percentile'],1)

    def test_explicit_share_only_scheme_has_zero_cash(self):
        item=plan('2024-12-31',0,'2025-03-01',PRETAX_BONUS_RMB=None,IMPL_PLAN_PROFILE='10转3.00')
        result=backcast([item],[{'date':'2025-03-03','close':10}],0,dt.date(2025,3,3),min_samples=1)
        self.assertEqual(result['samples'][0]['annual'],0)

    def test_missing_cash_without_explicit_scheme_remains_unavailable(self):
        item=plan('2024-12-31',0,'2025-03-01',PRETAX_BONUS_RMB=None,IMPL_PLAN_PROFILE='')
        with self.assertRaisesRegex(ValueError,'每股金额'):
            backcast([item],[{'date':'2025-03-03','close':10}],0,dt.date(2025,3,3),min_samples=1)
