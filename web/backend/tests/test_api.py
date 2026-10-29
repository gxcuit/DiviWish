import json
import sqlite3
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app import create_app
from backend.calculations import derive, yield_status
from backend import providers


def sample_seed():
    return {"meta": {"quote_date": "2026-10-20", "imported_at": "2026-10-20T18:00:00+08:00", "fx_rate": 0.8,
                     "last_refresh": None, "source": "test fixture"},
            "stocks": [
                {"market": "A", "code": "600001", "name": "测试股票", "sector": "银行", "price": 10,
                 "annual_dividend": 0.5, "rolling_dividend": 0.6, "target_yield": 0.05,
                 "quote_date": "2026-10-20", "updated_at": "2026-10-20T18:00:00+08:00",
                 "confirmed": True, "percentile_start": "2021-10-20", "percentile_end": "2026-10-20",
                 "history": [{"date": f"2026-{6 + index // 28:02d}-{index % 28 + 1:02d}", "yield": value, "close": 10}
                             for index, value in enumerate([0.02, 0.03, 0.05, 0.06] * 20)],
                 "dividends": [{"period": "2025-12-31", "dps": 0.5, "status": "实施分配", "date": "2026-07-01"}]},
                {"market": "HK", "code": "00001", "a_code": "600001", "name": "测试港股", "sector": "银行", "price": 8,
                 "annual_dividend": 0.5, "rolling_dividend": 0.6, "target_yield": 0.05, "connect_factor": 0.72,
                 "quote_date": "2026-10-20", "updated_at": "2026-10-20T18:00:00+08:00"},
            ]}


class CalculationTests(unittest.TestCase):
    def test_exact_status_boundaries_and_missing_target(self):
        self.assertEqual([yield_status(value) for value in [None, 0, -0.0025, -0.003, -0.0031]],
                         ["neutral", "green", "blue", "orange", "neutral"])

    def test_annual_rolling_percentile_and_inverse_quantile(self):
        result = derive(sample_seed()["stocks"][0], 0.8)
        self.assertAlmostEqual(result["dividend_yield"], 0.05)
        self.assertAlmostEqual(result["rolling_yield"], 0.06)
        self.assertAlmostEqual(result["target_price"], 10)
        self.assertAlmostEqual(result["percentile"], 0.75)
        self.assertAlmostEqual(result["quantile_60_yield"], 0.05)
        self.assertAlmostEqual(result["quantile_90_price"], 0.5 / 0.06)

    def test_hk_currency_tax_and_ah_premium(self):
        result = derive(sample_seed()["stocks"][1], 0.8, {"600001": 10})
        self.assertAlmostEqual(result["dividend_yield"], 0.5 / (8 * 0.8))
        self.assertAlmostEqual(result["ah_premium"], 10 / (8 * 0.8) - 1)
        self.assertAlmostEqual(result["target_price"], 12.5)
        self.assertAlmostEqual(result["connect_yield"], 0.5 / (8 * 0.8) * 0.72)

    def test_missing_fx_and_dividend_stay_unavailable(self):
        self.assertIsNone(derive(sample_seed()["stocks"][1], None)["dividend_yield"])
        stock = {**sample_seed()["stocks"][0], "annual_dividend": None}
        self.assertIsNone(derive(stock, 0.8)["dividend_yield"])

    def test_missing_connect_coefficient_cannot_imply_a_tax_rate(self):
        stock = {**sample_seed()["stocks"][1], "connect_factor": None}
        self.assertIsNone(derive(stock, 0.8)["connect_yield"])

    def test_less_than_sixty_samples_cannot_claim_a_historical_percentile(self):
        stock = sample_seed()["stocks"][0]
        stock["history"] = stock["history"][:59]
        result = derive(stock, 0.8)
        self.assertIsNone(result["percentile"])
        self.assertIsNone(result["quantile_60_yield"])
        self.assertEqual(result["percentile_count"], 59)


class ApiTests(unittest.TestCase):
    @patch("backend.app.providers.fetch_fx", return_value=0.8)
    @patch("backend.app.providers.fetch_quotes")
    def test_refresh_preserves_watchlist_changed_during_network_request(self, quote_provider, _fx_provider):
        def during_request(_stocks):
            with closing(sqlite3.connect(self.config["DATABASE"])) as connection:
                connection.execute("UPDATE stocks SET watched=1 WHERE id=1")
                connection.commit()
            return {1: {"price": 9, "change_pct": -0.01, "quote_date": "2026-10-20"}}, []
        quote_provider.side_effect = during_request
        self.assertEqual(self.client.post("/api/refresh", json={}).status_code, 200)
        stock = self.client.get("/api/stocks/1").json
        self.assertTrue(stock["watched"])
        self.assertEqual(stock["price"], 9)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.seed_path = self.root / "seed.json"
        self.seed_path.write_text(json.dumps(sample_seed()), encoding="utf-8")
        self.config = {"TESTING": True, "DATABASE": str(self.root / "test.sqlite3"), "SEED_PATH": str(self.seed_path)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()

    def tearDown(self):
        self.directory.cleanup()

    def test_seed_loaded_once_and_watchlist_persists_restart(self):
        self.assertEqual(self.client.get("/api/health").json["count"], 2)
        self.assertEqual(self.client.patch("/api/stocks/1", json={"watched": True}).status_code, 200)
        restarted = create_app(self.config).test_client()
        self.assertTrue(restarted.get("/api/stocks/1").json["watched"])
        self.assertEqual(restarted.get("/api/health").json["count"], 2)

    def test_list_does_not_leak_heavy_history_but_detail_keeps_it(self):
        item = self.client.get("/api/stocks").json["stocks"][0]
        self.assertNotIn("history", item)
        self.assertEqual(len(self.client.get("/api/stocks/1").json["history"]), 80)

    def test_crud_and_duplicate_code(self):
        payload = {"code": "600002", "name": "手动标的", "market": "A", "sector": "电力", "price": 5,
                   "annual_dividend": 0.3, "target_yield": 0.05}
        created = self.client.post("/api/stocks", json=payload)
        self.assertEqual(created.status_code, 201)
        stock_id = created.json["id"]
        self.assertAlmostEqual(created.json["dividend_yield"], 0.06)
        self.assertEqual(self.client.post("/api/stocks", json=payload).status_code, 409)
        self.assertEqual(self.client.patch(f"/api/stocks/{stock_id}", json={"target_yield": 0.06}).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/stocks/{stock_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/stocks/{stock_id}").status_code, 404)

    def test_validation_rejects_invalid_numeric_and_date_fields(self):
        for payload in [{"price": 0}, {"price": True}, {"price": "5"}, {"price": float("nan")},
                        {"annual_dividend": -1}, {"target_yield": 5}, {"confirmed": "yes"},
                        {"ex_dividend_date": "2026-02-30"}, {"code": "123"}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.patch("/api/stocks/1", json=payload).status_code, 400)

    def test_dividend_edit_invalidates_historical_comparison(self):
        result = self.client.patch("/api/stocks/1", json={"annual_dividend": 0.8}).json
        self.assertIsNone(result["percentile"])
        self.assertIsNone(result["rolling_dividend"])
        self.assertEqual(self.client.get("/api/stocks/1").json["dividends"], [])

    def test_rolling_value_can_be_explicitly_reverified_on_dividend_edit(self):
        result = self.client.patch("/api/stocks/1", json={"annual_dividend": 0.8, "rolling_dividend": 0.9}).json
        self.assertEqual(result["rolling_dividend"], 0.9)

    def test_security_identity_change_clears_old_quotes_and_dividend_values(self):
        result = self.client.patch("/api/stocks/1", json={"code": "600009"}).json
        for field in ("price", "annual_dividend", "rolling_dividend", "quote_date", "percentile"):
            self.assertIsNone(result[field])

    def test_cross_site_and_form_writes_are_rejected(self):
        self.assertEqual(self.client.post("/api/refresh", json={}, headers={"Origin": "https://example.com"}).status_code, 403)
        self.assertEqual(self.client.post("/api/refresh", data="").status_code, 415)

    def test_removed_import_endpoint_cannot_change_existing_data(self):
        before = self.client.get("/api/stocks").json
        self.assertEqual(self.client.post("/api/import", json={}).status_code, 404)
        self.assertEqual(self.client.get("/api/stocks").json, before)

    @patch("backend.providers.fetch_quotes", side_effect=providers.requests.Timeout("timeout"))
    def test_failed_refresh_preserves_values_and_timestamps(self, _quotes):
        before = self.client.get("/api/stocks").json
        response = self.client.post("/api/refresh", json={})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json["updated"], 0)
        self.assertEqual(self.client.get("/api/stocks").json, before)

    @patch("backend.providers.fetch_fx", return_value=0.81)
    @patch("backend.providers.fetch_quotes", return_value=({1: {"price": 8, "change_pct": -0.01, "quote_date": "2026-10-21"}}, ["hk00001 缺失"]))
    def test_partial_refresh_only_updates_valid_quotes(self, _quotes, _fx):
        previous_hk = self.client.get("/api/stocks/2").json
        response = self.client.post("/api/refresh", json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["updated"], 1)
        changed = self.client.get("/api/stocks/1").json
        self.assertEqual(changed["price"], 8)
        self.assertEqual(changed["quote_date"], "2026-10-21")
        self.assertEqual(changed["percentile_end"], "2026-10-20")
        unchanged = self.client.get("/api/stocks/2").json
        self.assertEqual(unchanged["price"], previous_hk["price"])
        self.assertEqual(unchanged["updated_at"], previous_hk["updated_at"])

    def test_csv_includes_bom_and_source_dates(self):
        response = self.client.get("/api/export")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data.startswith(b"\xef\xbb\xbf"))
        self.assertIn("2026-10-20", response.get_data(as_text=True))


class ProviderTests(unittest.TestCase):
    def test_timestamp_formats_and_exchange_symbols(self):
        self.assertEqual(providers.quote_date("20261020153000"), "2026-10-20")
        self.assertEqual(providers.quote_date("2026/10/20 16:00:00"), "2026-10-20")
        self.assertIsNone(providers.quote_date("missing"))
        self.assertEqual(providers.symbol_for({"market": "HK", "code": "00728"}), "hk00728")


if __name__ == "__main__":
    unittest.main()
