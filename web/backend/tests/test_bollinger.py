import datetime as dt
from unittest import TestCase
from unittest.mock import Mock, patch

import test_api
from backend.bollinger import calculate_bands, price_position
from backend import providers


def candles(count=30):
    return [{"date": (dt.date(2026, 1, 1) + dt.timedelta(days=index)).isoformat(), "close": index + 1}
            for index in range(count)]


def kline_result(stock, period):
    return {"bars": candles(), "adjustment": "qfq", "quote": {"price": 28, "quote_date": "2026-01-30"}}


class BollCalculationTests(TestCase):
    def test_twenty_period_population_deviation_and_trailing_window(self):
        result = calculate_bands(candles())
        self.assertEqual(result["middle"], 20.5)  # Last 20 closes: 11 through 30.
        self.assertAlmostEqual(result["lower"], 8.967437405329203)
        self.assertAlmostEqual(result["upper"], 32.03256259467079)
        self.assertEqual(result["start_date"], "2026-01-11")
        self.assertEqual(result["last_date"], "2026-01-30")

    def test_short_history_is_not_filled_with_older_or_fake_samples(self):
        result = calculate_bands(candles(19))
        self.assertFalse(result["available"])
        self.assertNotIn("middle", result)
        self.assertIn("19", result["error"])

    def test_outside_positions_are_not_clamped_to_channel_edges(self):
        band = {"lower": 10, "middle": 20, "upper": 30}
        for price, label, percent in [(5, "below_lower", -.25), (10, "at_lower", 0),
                                      (15, "lower_half", .25), (20, "at_middle", .5),
                                      (25, "upper_half", .75), (30, "at_upper", 1), (35, "above_upper", 1.25)]:
            self.assertEqual(price_position(band, price), {"position": label, "percent_b": percent})
        self.assertEqual(price_position(band, None)["position"], "unknown")

    def test_flat_series_and_invalid_prices_do_not_produce_nan(self):
        rows = [{**bar, "close": 10} for bar in candles(20)]
        band = calculate_bands(rows)
        self.assertEqual(price_position(band, 10), {"position": "flat", "percent_b": None})
        self.assertEqual(price_position(band, 9)["position"], "below_lower")
        rows[-1]["close"] = float("nan")
        with self.assertRaises(ValueError):
            calculate_bands(rows)


class BollApiTests(TestCase):
    setUp = test_api.ApiTests.setUp
    tearDown = test_api.ApiTests.tearDown

    @patch("backend.bollinger.providers.fetch_kline", side_effect=kline_result)
    def test_lazy_endpoint_cache_force_refresh_and_database_preservation(self, fetch):
        before = self.client.get("/api/stocks/1").json
        fetch.assert_not_called()
        response = self.client.get("/api/stocks/1/boll")
        self.assertEqual(response.status_code, 200)
        result = response.json
        self.assertEqual([band["period"] for band in result["bands"]], ["day", "week", "month"])
        # The saved quote is newer than the provider fixture.
        self.assertEqual(result["price"], 10)
        self.assertEqual(result["price_source"], "本机保存报价")
        self.assertEqual(fetch.call_count, 3)
        self.assertTrue(self.client.get("/api/stocks/1/boll").json["cached"])
        self.assertEqual(fetch.call_count, 3)
        self.client.get("/api/stocks/1/boll?refresh=1")
        self.assertEqual(fetch.call_count, 6)
        self.assertEqual(self.client.get("/api/stocks/1").json, before)
        self.assertEqual(self.client.get("/api/stocks/999/boll").status_code, 404)

    @patch("backend.bollinger.providers.fetch_kline")
    def test_partial_failure_retains_other_timeframes_and_can_retry(self, fetch):
        def load(stock, period):
            if period == "week":
                raise providers.requests.Timeout("test timeout")
            data = kline_result(stock, period)
            if period == "month":
                data["bars"] = candles(5)
            return data
        fetch.side_effect = load
        result = self.client.get("/api/stocks/1/boll").json
        self.assertTrue(result["bands"][0]["available"])
        self.assertFalse(result["bands"][1]["available"])
        self.assertEqual(result["bands"][2]["count"], 5)
        self.assertNotIn("lower", result["bands"][2])
        self.assertFalse(self.client.get("/api/stocks/1/boll").json["cached"])
        self.assertEqual(fetch.call_count, 6)

    @patch("backend.bollinger.providers.fetch_kline", side_effect=kline_result)
    def test_security_change_and_other_market_have_separate_cache(self, fetch):
        self.client.get("/api/stocks/1/boll")
        self.client.get("/api/stocks/2/boll")
        self.assertEqual(fetch.call_count, 6)
        self.client.patch("/api/stocks/1", json={"code": "600003"})
        self.client.get("/api/stocks/1/boll")
        self.assertEqual(fetch.call_count, 9)


class KlineProviderTests(TestCase):
    @patch("backend.providers.requests.get")
    def test_native_timeframes_and_hk_adjustment_endpoint(self, get):
        get.return_value = Mock()
        get.return_value.json.return_value = {"code": 0, "data": {"hk03968": {
            "qfqmonth": [["2026-09-30", "50", "51.5"], ["2026-10-23", "51", "52"]],
            "qt": {"hk03968": ["", "", "", "52"] + [""] * 26 + ["2026/10/23 16:08:14"]}}}}
        result = providers.fetch_kline({"code": "03968", "market": "HK"}, "month")
        self.assertIn("/hkfqkline/", get.call_args.args[0])
        self.assertEqual(get.call_args.kwargs["params"]["param"], "hk03968,month,,,30,qfq")
        self.assertEqual(result["adjustment"], "qfq")
        self.assertEqual(result["bars"][-1], {"date": "2026-10-23", "close": 52})
        self.assertEqual(result["quote"]["quote_date"], "2026-10-23")

    @patch("backend.providers.requests.get")
    def test_bare_series_is_explicitly_labelled_and_invalid_latest_close_is_rejected(self, get):
        get.return_value = Mock()
        payload = {"code": 0, "data": {"sh600036": {"day": [["2026-10-23", "40", "42"]]}}}
        get.return_value.json.return_value = payload
        self.assertEqual(providers.fetch_kline({"code": "600036", "market": "A"}, "day")["adjustment"], "none")
        self.assertIn("/fqkline/", get.call_args.args[0])
        payload["data"]["sh600036"]["day"][-1][2] = "NaN"
        with self.assertRaises(ValueError):
            providers.fetch_kline({"code": "600036", "market": "A"}, "day")
