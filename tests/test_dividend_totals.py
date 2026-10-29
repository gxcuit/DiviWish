"""Regression checks for dividend totals and stale announcement overrides."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_dy


class DividendTotalsTest(unittest.TestCase):
    def fetch(self, records):
        response = Mock()
        response.json.return_value = {"result": {"data": records}}
        with patch.object(update_dy.requests, "get", return_value=response):
            return update_dy._fetch_div_ashare("600941")

    def test_china_mobile_2025_total_excludes_2026_and_old_override(self):
        records = [
            {"REPORT_DATE": "2026-06-30", "ASSIGN_PROGRESS": "实施分配", "PRETAX_BONUS_RMB": 25.1},
            {"REPORT_DATE": "2025-12-31", "ASSIGN_PROGRESS": "实施分配", "PRETAX_BONUS_RMB": 22.012},
            {"REPORT_DATE": "2025-06-30", "ASSIGN_PROGRESS": "实施分配", "PRETAX_BONUS_RMB": 25.025},
        ]
        impl, ann, _, _ = self.fetch(records)
        self.assertAlmostEqual(impl, 4.7037)
        self.assertIsNone(ann)

    def test_stale_override_cannot_create_an_announcement(self):
        self.assertIsNone(self.fetch([])[1])

    def test_live_announcement_amount_is_used_without_manual_addition(self):
        record = {"REPORT_DATE": "2025-12-31", "ASSIGN_PROGRESS": "董事会决议通过", "PRETAX_BONUS_RMB": 20}
        self.assertAlmostEqual(self.fetch([record])[1], 2)
