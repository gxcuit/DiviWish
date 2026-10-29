import datetime
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import render_card
import update_dy


class FirstRunCardTest(unittest.TestCase):
    def test_first_run_keeps_content_sections(self):
        row = {
            "name": "测试股票", "code": "600000", "status": "🟢", "prev_price": None,
            "prev_st": None, "pct_chg": None, "prev_yield": None, "curr_yield": 0.05,
            "price": 10.0, "gh": 0.01, "is_ex_today": False, "ex_date": "2026-08-28",
            "div_dps": 0.1, "div_e": 0.5,
        }
        with patch.object(update_dy, "ashare_price_date", return_value=datetime.date(2026, 8, 27)), \
             patch.object(update_dy, "_build_yield_rows", return_value=[row]):
            markdown = update_dy.generate_yield_markdown({"股票数据": object()})

        self.assertIn("## 首次运行", markdown)
        self.assertIn("## 近期除息日", markdown)
        self.assertGreaterEqual(len(render_card._parse(markdown)["sections"]), 2)


if __name__ == "__main__":
    unittest.main()
