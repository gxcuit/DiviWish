import csv
from io import StringIO
from unittest import TestCase

import test_api
from backend.app import create_app
from backend.calculations import derive, yield_grid


class YieldBasisTests(TestCase):
    setUp = test_api.ApiTests.setUp
    tearDown = test_api.ApiTests.tearDown

    def test_rolling_basis_changes_targets_and_grid_but_not_annual_history(self):
        before = self.client.get("/api/stocks/1").json
        self.assertEqual(self.client.patch("/api/stocks/1", json={"yield_basis": "rolling"}).status_code, 200)
        stock = self.client.get("/api/stocks/1").json
        self.assertEqual(stock["selected_yield"], 0.06)
        self.assertEqual(stock["dividend_yield"], 0.05)
        self.assertAlmostEqual(stock["target_price"], 12)
        self.assertAlmostEqual(stock["yield_gap"], 0.01)
        self.assertEqual(stock["percentile"], before["percentile"])
        self.assertEqual(stock["quantile_90_price"], before["quantile_90_price"])
        self.assertAlmostEqual(stock["yield_grid"][0]["price"], 0.6 / 0.03)

    def test_custom_percent_is_stored_independently_per_stock_and_survives_restart(self):
        response = self.client.patch("/api/stocks/1", json={"yield_basis": "custom", "custom_yield": 0.08})
        self.assertEqual(response.status_code, 200)
        client = create_app(self.config).test_client()
        stock = client.get("/api/stocks/1").json
        self.assertEqual(stock["selected_yield"], 0.08)
        self.assertEqual(stock["percentile"], 0.75)
        self.assertAlmostEqual(stock["basis_dividend"], 0.8)
        self.assertAlmostEqual(stock["target_price"], 16)
        self.assertEqual(client.get("/api/stocks/2").json["yield_basis"], "annual")
        self.client.patch("/api/stocks/1", json={"price": 20})
        updated = self.client.get("/api/stocks/1").json
        self.assertEqual(updated["selected_yield"], 0.08)
        self.assertAlmostEqual(updated["target_price"], 32)
        self.assertAlmostEqual(updated["dividend_yield"], 0.025)

    def test_missing_rolling_values_do_not_fall_back_to_annual(self):
        stock = {**test_api.sample_seed()["stocks"][0], "yield_basis": "rolling", "rolling_dividend": None}
        result = derive(stock, 0.8)
        self.assertIsNone(result["selected_yield"])
        self.assertIsNone(result["target_price"])
        self.assertIsNone(yield_grid(stock, 0.8)[0]["price"])
        self.assertEqual(result["dividend_yield"], 0.05)

    def test_hk_rolling_uses_fx_and_custom_percent_uses_quote_currency(self):
        stock = {**test_api.sample_seed()["stocks"][1], "yield_basis": "rolling"}
        self.assertAlmostEqual(derive(stock, 0.8)["selected_yield"], 0.6 / 8 / 0.8)
        self.assertIsNone(derive(stock, None)["selected_yield"])
        custom = {**stock, "yield_basis": "custom", "custom_yield": 0.1}
        result = derive(custom, None)
        self.assertEqual(result["selected_yield"], 0.1)
        self.assertAlmostEqual(result["target_price"], 16)
        self.assertAlmostEqual(yield_grid(custom, None)[0]["price"], 0.8 / 0.03)

    def test_invalid_basis_or_custom_yield_cannot_overwrite_existing_values(self):
        before = self.client.get("/api/stocks/1").json
        for invalid in [{"yield_basis": "invalid"}, {"yield_basis": []}, {"yield_basis": "custom"}, {"custom_yield": -0.01},
                        {"custom_yield": 1.1}, {"custom_yield": "0.05"}, {"custom_yield": True},
                        {"custom_yield": float("nan")}]:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.client.patch("/api/stocks/1", json=invalid).status_code, 400)
        self.assertEqual(self.client.get("/api/stocks/1").json, before)

    def test_restart_preserves_zero_custom_rate(self):
        self.client.patch("/api/stocks/1", json={"yield_basis": "custom", "custom_yield": 0})
        stock = create_app(self.config).test_client().get("/api/stocks/1").json
        self.assertEqual(stock["yield_basis"], "custom")
        self.assertEqual(stock["selected_yield"], 0)
        self.assertEqual(stock["target_price"], 0)

    def test_custom_rate_without_quote_cannot_invent_target_prices(self):
        stock = {**test_api.sample_seed()["stocks"][0], "yield_basis": "custom", "custom_yield": 0.05, "price": None}
        self.assertEqual(derive(stock, 0.8)["selected_yield"], 0.05)
        self.assertIsNone(derive(stock, 0.8)["target_price"])
        self.assertIsNone(yield_grid(stock, 0.8)[0]["price"])

    def test_csv_includes_selected_basis_without_relabelling_annual_values(self):
        self.client.patch("/api/stocks/1", json={"yield_basis": "custom", "custom_yield": 0.08})
        response = self.client.get("/api/export")
        rows = list(csv.DictReader(StringIO(response.get_data(as_text=True).lstrip("\ufeff"))))
        self.assertEqual(rows[0]["选用股息率口径"], "custom")
        self.assertEqual(rows[0]["选用股息率"], "0.08")
        self.assertEqual(rows[0]["年度股息率"], "0.05")

    def test_changing_security_resets_the_previous_custom_estimate(self):
        self.client.patch("/api/stocks/1", json={"yield_basis": "custom", "custom_yield": 0.08})
        response = self.client.patch("/api/stocks/1", json={"code": "600009"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["yield_basis"], "annual")
        self.assertIsNone(response.json["custom_yield"])
