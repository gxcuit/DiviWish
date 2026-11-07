import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateForecast, forecastToday, forecastYear } from "../forecast.ts";
import { derive, yieldGrid } from "../calculations.ts";
import { fixture, sampleStocks } from "./helpers.ts";
import { validate } from "../validation.ts";
import type { ForecastManualInput } from "../forecast-types.ts";
const near = (a: unknown, b: number) => assert.ok(typeof a === "number" && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const input = (patch: Partial<ForecastManualInput> = {}): ForecastManualInput => ({ year: forecastYear(), kind: "per_share", value: 1.2, currency: "CNY", note: "人工判断", ...patch });
function stock() { return validate({ yield_basis: "forecast", forecast_manual: input() }, sampleStocks()[0]); }

test("manual dividends drive selected yield, targets, both grids and no historical lookahead", () => {
  const s = stock(), r = derive(s, 0.8);
  near(r.selected_yield, .12); near(r.target_price, 24); near(yieldGrid(s, .8)[0].price, 40); near(yieldGrid(s, .8, "sell")[0].price, 30);
  assert.equal(r.percentile, null); assert.equal(r.quantile_60_price, null); assert.deepEqual(r.percentile_history, []);
  assert.equal(calculateForecast(s, .8).basis, "manual"); assert.match(String(r.percentile_unavailable_reason), /历史时点/);
});

test("manual percentages anchor the dividend at the saved price and follow later quote changes", () => {
  const s = validate({ yield_basis: "forecast", forecast_manual: input({ kind: "yield", value: .08 }) }, sampleStocks()[0]);
  near(s.forecast_manual!.dividend, .8); near(s.forecast_manual!.reference_price, 10); near(calculateForecast(s, 1).yield, .08);
  const changed = validate({ price: 20 }, s); near(calculateForecast(changed, 1).dividend, .8); near(calculateForecast(changed, 1).yield, .04);
  assert.deepEqual(changed.forecast_manual, s.forecast_manual);
  assert.throws(() => validate({ price: null, forecast_manual: input({ kind: "yield", value: .05 }) }, sampleStocks()[0]), /有效股价/);
});

test("absent and cleared input never use automatic snapshots, payouts or another basis", () => {
  const s = validate({ forecast_manual: null }, stock());
  s.forecast_snapshot = { year: forecastYear(), commitments: [{ kind: "per_share", value: 100 }], consensus: { eps: 500 }, dividends: [{ amount: 9, complete: true }] };
  const d = derive(s, 1); assert.equal(d.selected_yield, null); assert.equal(d.target_price, null);
  assert.equal(calculateForecast(s, 1).dividend, null); assert.ok(yieldGrid(s, 1).every(row => row.price === null));
});

test("manual zero, missing prices, cross-year values and ETF exclusion are explicit", () => {
  const s = validate({ forecast_manual: input({ value: 0 }) }, stock()); near(calculateForecast(s, 1).yield, 0);
  s.price = null; assert.equal(calculateForecast(s, 1).yield, null); near(calculateForecast(s, 1).dividend, 0);
  assert.equal(calculateForecast(stock(), 1, `${forecastYear() + 1}-01-01`).dividend, null);
  s.instrument_type = "etf"; assert.equal(calculateForecast(s, 1).status, "unsupported");
  assert.throws(() => validate({ code: "510880", market: "A", exchange: "sh", name: "ETF", sector: "ETF", instrument_type: "etf", forecast_manual: input() }), /ETF/);
});

test("HK manual dividends use saved FX and percentage inputs require the quote currency", () => {
  const s = validate({ yield_basis: "forecast", forecast_manual: input() }, sampleStocks()[1]);
  near(calculateForecast(s, .8).dividend, 1.5); assert.equal(calculateForecast(s, null).dividend, null);
  near(calculateForecast(validate({ forecast_manual: input({ value: 0 }) }, s), null).yield, 0);
  const native = validate({ forecast_manual: input({ currency: "HKD", value: 2 }) }, s); near(calculateForecast(native, null).dividend, 2);
  assert.throws(() => validate({ forecast_manual: input({ kind: "yield", value: .1, currency: "CNY" }) }, s), /股价币种/);
});

test("malformed, blank, oversized, negative and injected calculated fields are rejected", () => {
  for (const patch of [{ value: -1 }, { value: Infinity }, { value: "" }, { kind: "ratio" }, { year: 2026.5 }, { year: 2300 }, { currency: "USD" }, { note: "x".repeat(2001) }, { dividend: 100 }, { value: 1.01, kind: "yield" }]) {
    assert.throws(() => validate({ forecast_manual: { ...input(), ...patch } }, sampleStocks()[0]));
  }
  const changed = validate({ code: "600002" }, stock()); assert.equal(changed.forecast_manual, undefined); assert.equal(changed.forecast_snapshot, undefined);
});

test("legacy manual model parameters are preserved as data without reviving the model", () => {
  const s = stock(); Object.assign(s, { forecast_manual: { year: forecastYear(), payout_ratio: .4, commitment: { kind: "per_share", value: 4 } } });
  const result = calculateForecast(s, 1); assert.equal(result.dividend, null); assert.match(result.reason, /重新手动填写/);
});

test("manual settings persist through APIs; old automatic refresh returns 410 without cache writes", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const response = await f.request("/api/stocks/1", "PATCH", { yield_basis: "forecast", forecast_manual: input({ kind: "yield", value: .05 }) });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json(); near(data.forecast.dividend, .5); assert.ok(data.forecast_manual.updated_at.startsWith(forecastToday()));
  assert.equal((await f.request("/api/stocks/1/forecast?refresh=1", "POST", {})).status, 410);
  const get = await (await f.request("/api/stocks/1/forecast")).json(); near(get.forecast.dividend, .5); assert.equal(get.forecast_snapshot, undefined);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM public_forecast_cache").get()!.n, 0);
  assert.equal((await f.request("/api/stocks/1", "PATCH", { forecast_manual: null })).status, 200);
  assert.equal((await (await f.request("/api/stocks/1")).json()).forecast.dividend, null);
});

test("quote refresh preserves a manual forecast edited while upstream requests are in flight", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.source.fetchQuotes = async () => {
    assert.equal((await f.request("/api/stocks/1", "PATCH", { forecast_manual: input({ value: 2.5 }) })).status, 200);
    return { quotes: new Map([[1, { price: 20, quote_date: forecastToday() }]]), errors: [] };
  };
  assert.equal((await f.request("/api/refresh?phase=quotes", "POST", {})).status, 200);
  const data = await (await f.request("/api/stocks/1")).json(); near(data.forecast.dividend, 2.5); near(data.forecast.yield, .125);
});
