from unittest import TestCase

import test_api
from backend.app import create_app
from backend.calculations import GRID_DEFAULTS, grid_levels, yield_grid


class GridAndSectorTests(TestCase):
    setUp = test_api.ApiTests.setUp
    tearDown = test_api.ApiTests.tearDown

    def test_each_stock_keeps_its_own_grid_after_restart(self):
        settings = {"grid_start": 0.04, "grid_end": 0.06, "grid_step": 0.005}
        self.assertEqual(self.client.patch("/api/stocks/1", json=settings).status_code, 200)
        restarted = create_app(self.config).test_client()
        detail = restarted.get("/api/stocks/1").json
        self.assertEqual([row["yield"] for row in detail["yield_grid"]], [0.04, 0.045, 0.05, 0.055, 0.06])
        self.assertAlmostEqual(detail["yield_grid"][0]["price"], 12.5)
        self.assertTrue(detail["yield_grid"][0]["reached"])
        self.assertFalse(detail["yield_grid"][-1]["reached"])
        for key, value in GRID_DEFAULTS.items():
            self.assertEqual(restarted.get("/api/stocks/2").json[key], value)

    def test_invalid_grid_changes_do_not_overwrite_saved_settings(self):
        before = self.client.get("/api/stocks/1").json
        for invalid in [{"grid_start": 0}, {"grid_end": 0.02}, {"grid_step": -0.01},
                        {"grid_step": 0.00001}, {"grid_start": True}, {"grid_end": "0.05"},
                        {"grid_step": float("nan")}, {"grid_end": 1.1}]:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.client.patch("/api/stocks/1", json=invalid).status_code, 400)
        self.assertEqual(self.client.get("/api/stocks/1").json, before)

    def test_hk_grid_uses_fx_and_keeps_unknown_values_missing(self):
        stock = {"market": "HK", "annual_dividend": 0.5, "price": 8,
                 "grid_start": 0.05, "grid_end": 0.05, "grid_step": 0.005}
        self.assertAlmostEqual(yield_grid(stock, 0.8)[0]["price"], 12.5)
        self.assertIsNone(yield_grid(stock, None)[0]["price"])
        self.assertIsNone(yield_grid({**stock, "annual_dividend": None}, 0.8)[0]["reached"])
        self.assertEqual(grid_levels({"grid_start": 0.03, "grid_end": 0.05, "grid_step": 0.006}), [0.03, 0.036, 0.042, 0.048])

    def test_empty_sector_is_saved_and_stock_form_can_use_it(self):
        created = self.client.post("/api/sectors", json={"name": "新板块"})
        self.assertEqual(created.status_code, 201)
        self.assertIn("新板块", self.client.get("/api/stocks").json["sectors"])
        restarted = create_app(self.config).test_client()
        self.assertIn("新板块", restarted.get("/api/stocks").json["sectors"])
        self.assertEqual(self.client.post("/api/sectors", json={"name": "新板块"}).status_code, 409)

    def test_rename_and_delete_sector_keep_all_stocks_and_watchlists(self):
        self.client.patch("/api/stocks/1", json={"watched": True, "grid_step": 0.01})
        category = next(sector for sector in self.client.get("/api/sectors").json["sectors"] if sector["name"] == "银行")
        self.assertEqual(self.client.patch(f"/api/sectors/{category['id']}", json={"name": "金融"}).status_code, 200)
        self.assertEqual({stock["sector"] for stock in self.client.get("/api/stocks").json["stocks"]}, {"金融"})
        response = self.client.delete(f"/api/sectors/{category['id']}")
        self.assertEqual(response.json["moved"], 2)
        stocks = self.client.get("/api/stocks").json["stocks"]
        self.assertEqual(len(stocks), 2)
        self.assertEqual({stock["sector"] for stock in stocks}, {"未分类"})
        self.assertTrue(stocks[0]["watched"])
        self.assertEqual(stocks[0]["grid_step"], 0.01)
        self.assertNotIn("金融", self.client.get("/api/stocks").json["sectors"])

    def test_restart_preserves_grid_and_removed_sector_assignments(self):
        self.client.patch("/api/stocks/1", json={"grid_step": 0.01})
        sector_id = next(sector["id"] for sector in self.client.get("/api/sectors").json["sectors"] if sector["name"] == "银行")
        self.client.delete(f"/api/sectors/{sector_id}")
        restarted = create_app(self.config).test_client()
        stock = restarted.get("/api/stocks/1").json
        self.assertEqual(stock["grid_step"], 0.01)
        self.assertEqual(stock["sector"], "未分类")
        self.assertNotIn("银行", restarted.get("/api/stocks").json["sectors"])

    def test_reserved_and_invalid_sector_operations_are_rejected(self):
        unclassified = next(sector for sector in self.client.get("/api/sectors").json["sectors"] if sector["protected"])
        self.assertEqual(self.client.delete(f"/api/sectors/{unclassified['id']}").status_code, 400)
        self.assertEqual(self.client.patch(f"/api/sectors/{unclassified['id']}", json={"name": "新名称"}).status_code, 400)
        for name in ["", "全部", "中" * 31, None]:
            self.assertEqual(self.client.post("/api/sectors", json={"name": name}).status_code, 400)
        category = next(sector for sector in self.client.get("/api/sectors").json["sectors"] if sector["name"] == "银行")
        self.assertEqual(self.client.patch(f"/api/sectors/{category['id']}", json={"name": "未分类"}).status_code, 409)
