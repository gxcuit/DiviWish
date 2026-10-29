"""A股除息日抓取回归测试。

锁死修复：当同一只股票既有「当年已实施」的过去除息日、又有「已公告」的未来除息日
（典型如中国平安 601318：末期分红除息日已过 + 中期分红除息日将至）时，
_fetch_ashare_div 必须返回最近的那个「未来」除息日，而不是被过去日期遮挡。
"""
import datetime
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import update_dy


def _iso(d):
    return d.strftime("%Y-%m-%d %H:%M:%S")


def _rec(report_date, progress, ex_date=None, record_date=None, pretax=10.0):
    return {
        "REPORT_DATE": _iso(report_date),
        "ASSIGN_PROGRESS": progress,
        "EX_DIVIDEND_DATE": _iso(ex_date) if ex_date else None,
        "EQUITY_RECORD_DATE": _iso(record_date) if record_date else None,
        "PRETAX_BONUS_RMB": pretax,
        "IMPL_PLAN_PROFILE": "",
    }


def _payload(records):
    return json.dumps({"result": {"data": records}})


class AShareExDivDateTest(unittest.TestCase):
    def setUp(self):
        self.today = datetime.date.today()
        self.cur_year = self.today.year

    def _run(self, records):
        with patch.object(update_dy, "http_get", return_value=_payload(records)):
            return update_dy._fetch_ashare_div("601318")

    def test_future_announced_beats_past_implemented(self):
        """核心回归：过去已实施 + 未来已公告 → 返回未来除息日。"""
        past_impl = _rec(
            datetime.date(self.cur_year, 1, 1), "实施分配",
            ex_date=self.today - datetime.timedelta(days=80), pretax=17.5,
        )
        future_ann = _rec(
            datetime.date(self.cur_year, 6, 30), "董事会决议通过",
            ex_date=self.today + datetime.timedelta(days=9), pretax=9.8,
        )
        date_str, dps = self._run([future_ann, past_impl])
        self.assertEqual(date_str, (self.today + datetime.timedelta(days=9)).isoformat())
        self.assertAlmostEqual(dps, 0.98)

    def test_only_past_implemented_falls_back(self):
        """无未来除息日时，回退到当年已实施的最近一笔，避免整列为空。"""
        past_impl = _rec(
            datetime.date(self.cur_year - 1, 12, 31), "实施分配",
            ex_date=self.today - datetime.timedelta(days=30),
        )
        date_str, _ = self._run([past_impl])
        self.assertEqual(date_str, (self.today - datetime.timedelta(days=30)).isoformat())

    def test_multiple_future_returns_soonest(self):
        """存在多个未来除息日时，取最近的那个。"""
        near = _rec(datetime.date(self.cur_year, 6, 30), "董事会决议通过",
                    ex_date=self.today + datetime.timedelta(days=5))
        far = _rec(datetime.date(self.cur_year, 12, 31), "股东大会通过",
                   ex_date=self.today + datetime.timedelta(days=200))
        date_str, _ = self._run([far, near])
        self.assertEqual(date_str, (self.today + datetime.timedelta(days=5)).isoformat())

    def test_record_date_plus_one_when_no_ex_date(self):
        """只有股权登记日、无除息日时，按登记日 +1 天推算除息日。"""
        future_rec = _rec(
            datetime.date(self.cur_year, 6, 30), "实施分配",
            ex_date=None, record_date=self.today + datetime.timedelta(days=3),
        )
        date_str, _ = self._run([future_rec])
        self.assertEqual(date_str, (self.today + datetime.timedelta(days=4)).isoformat())

    def test_no_dividend_returns_none(self):
        """完全没有分红记录时返回 None，不抛异常。"""
        date_str, dps = self._run([])
        self.assertIsNone(date_str)
        self.assertIsNone(dps)


if __name__ == "__main__":
    unittest.main()
