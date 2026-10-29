import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from rolling_dividend import select_rolling, select_annual, supplement_missing


def record(period, dps, status="实施分配"):
    return {"REPORT_DATE": period, "PRETAX_BONUS_RMB": dps * 10, "ASSIGN_PROGRESS": status}


class RollingDividendTest(unittest.TestCase):
    def test_missing_amount_is_not_treated_as_zero(self):
        with self.assertRaises(ValueError):
            select_annual([{'REPORT_DATE':'2025-12-31', 'ASSIGN_PROGRESS':'实施分配'}], datetime.date(2026, 10, 18))

    def test_zero_distribution_replaces_prior_annual_year(self):
        result = select_annual([record("2025-12-31", 1.75),
                               record("2026-12-31", 0, "不分配不转增")], datetime.date(2027, 3, 30))
        self.assertEqual(result['year'], 2026)
        self.assertEqual(result['total'], 0)

    def test_legacy_supplement_is_period_scoped_and_deduplicated(self):
        items = [record('2025-06-30', 1.019), record('2025-12-31', 1.583)]
        self.assertEqual(len(supplement_missing(items, '000538')), 2)
        result = select_annual(supplement_missing([record('2026-12-31', 2)], '000538'), datetime.date(2027, 3, 30))
        self.assertEqual(result['total'], 2)

    def test_old_annual_history_is_marked_unavailable(self):
        with self.assertRaises(ValueError):
            select_annual([record('2022-12-31', 1)], datetime.date(2026, 10, 18))

    def test_interim_does_not_replace_latest_complete_fiscal_year(self):
        result = select_annual([record("2025-06-30", .95), record("2025-12-31", 1.75),
                                record("2026-06-30", .98)], datetime.date(2026, 10, 18))
        self.assertEqual(result['year'], 2025)
        self.assertAlmostEqual(result['total'], 2.7)

    def test_rolls_forward_when_next_annual_plan_is_announced(self):
        result = select_annual([record("2025-12-31", 1.75), record("2026-06-30", .98),
                                record("2026-12-31", 1.82, "董事会决议通过")], datetime.date(2027, 3, 30))
        self.assertEqual(result['year'], 2026)
        self.assertAlmostEqual(result['total'], 2.8)
        self.assertEqual(result['confirmed'], 0)

    def test_new_year_uses_reporting_period_not_payment_date(self):
        item = record("2026-12-31", 1.82)
        item['EX_DIVIDEND_DATE'] = '2027-06-10'
        result = select_annual([record("2026-06-30", .98), item], datetime.date(2027, 6, 11))
        self.assertEqual(result['year'], 2026)
        self.assertEqual(result['confirmed'], 1)

    def test_partial_year_is_not_reported_as_full_year(self):
        with self.assertRaises(ValueError):
            select_annual([record("2026-06-30", .98)], datetime.date(2026, 10, 18))

    def test_replaces_old_interim_instead_of_adding_three_payments(self):
        result = select_rolling([record("2025-06-30", .95), record("2025-12-31", 1.75),
                                 record("2026-06-30", .98)], datetime.date(2026, 10, 18))
        self.assertAlmostEqual(result["total"], 2.73)
        self.assertEqual(len(result["parts"]), 2)

    def test_implemented_supersedes_announcement(self):
        result = select_rolling([record("2025-12-31", 1.75),
                                 record("2025-12-31", 1.7, "董事会决议通过")], datetime.date(2026, 10, 18))
        self.assertEqual(result["total"], 1.75)

    def test_includes_quarterly_dividends(self):
        result = select_rolling([record(d, .1) for d in
                                ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]],
                                datetime.date(2026, 10, 18))
        self.assertAlmostEqual(result["total"], .4)

    def test_missing_is_not_zero(self):
        with self.assertRaises(ValueError):
            select_rolling([])
