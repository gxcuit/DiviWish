import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers.ts";
import type { DividendSnapshot, HistorySnapshot } from "../types.ts";

const dividend: DividendSnapshot = { annual_dividend: 2.7, rolling_dividend: 2.8, annual_year: 2025, confirmed: true,
  ex_dividend_date: "2026-07-01", dividends: [{ period: "2025-12-31", dps: 2.7, status: "实施分配" }],
  dividend_source: "test public reports", dividend_updated_at: "2026-10-28", dividend_fx_rate: null };
const history: HistorySnapshot = { history: Array.from({ length: 80 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: 10, annual: i < 40 ? 0.5 : 1, year: 2025, yield: i < 40 ? 0.05 : 0.1,
})), percentile_start: "2026-01-01", percentile_end: "2026-03-21", history_source: "test",
  history_updated_at: "2026-03-22", history_note: "test method" };

test("single-stock refresh and preview preserve dividend features without any account", async t => {
  const f = fixture({ fetchDividends: async () => structuredClone(dividend),
    fetchQuotes: async stocks => ({ quotes: new Map(stocks.map(stock => [stock.id!, { price: 20, quote_date: "2026-10-28" }])), errors: [] }) });
  t.after(() => f.db.sqlite.close());
  const preview = await f.request("/api/stocks/preview?code=600001&market=A");
  assert.equal(preview.status, 200); assert.equal((await preview.json()).dividends.annual_dividend, 2.7);
  assert.equal((await (await f.request("/api/stocks/1")).json()).annual_dividend, 0.5);
  assert.equal((await f.request("/api/stocks/1/refresh", "GET")).status, 405);
  assert.equal((await f.request("/api/stocks/1/refresh", "POST", {}, { Origin: "https://evil.example" })).status, 403);
  const refreshed = await f.request("/api/stocks/1/refresh", "POST", {});
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  assert.equal((await refreshed.json()).dividends_updated, 1);
  const detail = await (await f.request("/api/stocks/1")).json();
  assert.equal(detail.annual_dividend, 2.7); assert.equal(detail.rolling_dividend, 2.8); assert.equal(detail.annual_year, 2025);
  assert.deepEqual(detail.dividends, dividend.dividends); assert.equal(detail.dividend_yield, 2.7 / 20);
  assert.ok(!("_refresh_id" in detail));
  f.source.fetchQuotes = async () => { throw new Error("offline"); };
  f.source.fetchDividends = async () => { throw new Error("offline"); };
  assert.equal((await f.request("/api/stocks/1/refresh", "POST", {})).status, 502);
  assert.deepEqual(await (await f.request("/api/stocks/1")).json(), detail);
});

test("refresh preserves manual dividends and quotes during upstream requests", async t => {
  const f = fixture({ fetchQuotes: async () => ({ quotes: new Map([[1, { price: 20, quote_date: "2026-10-28" }]]), errors: [] }) });
  t.after(() => f.db.sqlite.close());
  f.source.fetchDividends = async () => {
    await f.request("/api/stocks/1", "PATCH", { annual_dividend: 3, price: 70, watched: true, grid_end: 0.09 });
    return structuredClone(dividend);
  };
  assert.equal((await f.request("/api/stocks/1/refresh", "POST", {})).status, 502);
  const detail = await (await f.request("/api/stocks/1")).json();
  assert.equal(detail.annual_dividend, 3); assert.equal(detail.price, 70); assert.equal(detail.watched, true); assert.equal(detail.grid_end, 0.09);
});

test("Hong Kong refresh persists verified FX and valid zero dividends", async t => {
  const f = fixture({ fetchDividends: async () => ({ ...dividend, annual_dividend: 0, rolling_dividend: 0, dividend_fx_rate: 0.9 }),
    fetchFx: async () => { throw new Error("offline"); } });
  t.after(() => f.db.sqlite.close());
  assert.equal((await f.request("/api/stocks/2/refresh", "POST", {})).status, 200);
  const detail = await (await f.request("/api/stocks/2")).json();
  assert.equal(detail.annual_dividend, 0); assert.equal(detail.dividend_yield, 0); assert.equal(detail.rolling_yield, 0);
  assert.equal((await (await f.request("/api/stocks")).json()).meta.fx_rate, 0.9);
});

test("history backfill persists samples and retains old data on upstream failure", async t => {
  const f = fixture({ fetchHistory: async () => structuredClone(history) });
  t.after(() => f.db.sqlite.close());
  await f.request("/api/stocks/1", "PATCH", { annual_dividend: 1 });
  const response = await f.request("/api/stocks/1/history", "POST", {});
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.percentile_count, 80); assert.equal(detail.percentile, 1); assert.equal(detail.quantile_60_yield, 0.1);
  assert.equal(detail.quantile_60_price, 10);
  assert.ok(!("history" in (await (await f.request("/api/stocks")).json()).stocks[0]));
  f.source.fetchHistory = async () => { throw new Error("上游暂不可用"); };
  assert.equal((await f.request("/api/stocks/1/history", "POST", {})).status, 502);
  assert.deepEqual((await (await f.request("/api/stocks/1")).json()).history, detail.history);
});

test("history backfill retains concurrent settings and rejects changed dividends", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.source.fetchHistory = async () => {
    await f.request("/api/stocks/1", "PATCH", { watched: true, grid_end: 0.09 });
    return structuredClone(history);
  };
  assert.equal((await f.request("/api/stocks/1/history", "POST", {})).status, 200);
  let detail = await (await f.request("/api/stocks/1")).json();
  assert.equal(detail.watched, true); assert.equal(detail.grid_end, 0.09);
  f.source.fetchHistory = async () => {
    await f.request("/api/stocks/1", "PATCH", { annual_dividend: 2 }); return structuredClone(history);
  };
  assert.equal((await f.request("/api/stocks/1/history", "POST", {})).status, 409);
  detail = await (await f.request("/api/stocks/1")).json();
  assert.deepEqual(detail.history, []); assert.equal(detail.history_updated_at, undefined);
});
