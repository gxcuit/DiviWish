import json
from unittest import TestCase
from unittest.mock import Mock, patch

from backend import providers
import test_api


class SearchApiTests(TestCase):
    setUp = test_api.ApiTests.setUp
    tearDown = test_api.ApiTests.tearDown

    @patch("backend.app.providers.search_stocks")
    def test_name_search_merges_local_and_remote_without_duplicates(self, search):
        search.return_value = [{"name": "测试股票", "code": "600001", "market": "A"},
                               {"name": "测试新股", "code": "600003", "market": "A"},
                               {"name": "测试港股", "code": "00001", "market": "HK"}]
        response = self.client.get("/api/stocks/search", query_string={"q": "测试"})
        self.assertEqual(response.status_code, 200)
        suggestions = response.json["suggestions"]
        self.assertEqual(len(suggestions), 3)
        self.assertEqual(suggestions[0]["sector"], "银行")
        self.assertTrue(suggestions[0]["existing"])
        self.assertFalse(next(stock for stock in suggestions if stock["code"] == "600003")["existing"])

    @patch("backend.app.providers.search_stocks", side_effect=providers.requests.Timeout)
    def test_network_failure_keeps_local_code_matches_and_allows_manual_entry(self, _search):
        response = self.client.get("/api/stocks/search?q=600001")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["suggestions"][0]["name"], "测试股票")
        self.assertIn("手动填写", response.json["message"])

    @patch("backend.app.providers.search_stocks")
    def test_empty_and_oversized_queries_do_not_call_provider(self, search):
        self.assertEqual(self.client.get("/api/stocks/search?q=%20").json["suggestions"], [])
        self.assertEqual(self.client.get("/api/stocks/search", query_string={"q": "中" * 41}).status_code, 400)
        search.assert_not_called()

    @patch("backend.app.providers.search_stocks", return_value=[])
    def test_no_match_returns_empty_suggestions(self, _search):
        self.assertEqual(self.client.get("/api/stocks/search?q=nonexistent").json["suggestions"], [])


class SearchProviderTests(TestCase):
    @patch("backend.providers.requests.get")
    def test_decodes_unicode_filters_supported_markets_and_keeps_code_zeros(self, get):
        content = "sh~601088~中国神华~zgsh~GP-A^hk~01088~中国神华~zgsh~GP^us~csuay~中国神华~zgsh~GP^sh~601088~中国神华~zgsh~GP-A^sh~510300~基金~jj~ETF^sz~200002~万科B~wkb~GP-B"
        get.return_value = Mock(text="v_hint=" + json.dumps(content, ensure_ascii=True))
        self.assertEqual(providers.search_stocks("中国神华"), [
            {"name": "中国神华", "code": "601088", "market": "A"},
            {"name": "中国神华", "code": "01088", "market": "HK"}])
        self.assertEqual(get.call_args.kwargs["params"], {"q": "中国神华", "t": "all"})

    @patch("backend.providers.requests.get")
    def test_empty_and_invalid_response(self, get):
        get.return_value = Mock(text='v_hint="N"')
        self.assertEqual(providers.search_stocks("none"), [])
        get.return_value = Mock(text="unexpected provider response")
        with self.assertRaises(ValueError):
            providers.search_stocks("query")
