import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBands, pricePosition } from "../bollinger.ts";
import { candles, fixture } from "./helpers.ts";

test("BOLL uses the last twenty closes and population deviation; flat and out-of-band positions stay explicit", () => {
  const band = calculateBands(candles());
  assert.equal(band.middle, 20.5); assert.ok(Math.abs(band.lower! - 8.967437405329203) < 1e-12);
  assert.ok(Math.abs(band.upper! - 32.03256259467079) < 1e-12);
  assert.equal(band.start_date, "2026-01-11"); assert.equal(band.last_date, "2026-01-30");
  assert.equal(calculateBands(candles(19)).available, false);
  const plain = { available: true, lower: 10, middle: 20, upper: 30 };
  const labels = ["below_lower", "at_lower", "lower_half", "at_middle", "upper_half", "at_upper", "above_upper"];
  [5, 10, 15, 20, 25, 30, 35].forEach((price, index) => assert.deepEqual(pricePosition(plain, price), { position: labels[index], percent_b: (price - 10) / 20 }));
  assert.equal(pricePosition(plain, null).position, "unknown");
  const flat = calculateBands(candles(20).map(row => ({ ...row, close: 10 })));
  assert.deepEqual(pricePosition(flat, 10), { position: "flat", percent_b: null });
  assert.equal(pricePosition(flat, 9).position, "below_lower");
  assert.throws(() => calculateBands([...candles(19), { date: "2026-01-20", close: NaN }]));
});

test("BOLL lazily loads independent timeframes, caches successes, bypasses cache on refresh and preserves stock documents", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const original = f.source.fetchKline; let calls = 0;
  f.source.fetchKline = async (...args) => { calls++; return original(...args); };
  const before = await (await f.request("/api/stocks/1")).json(); assert.equal(calls, 0);
  const result = await (await f.request("/api/stocks/1/boll")).json();
  assert.deepEqual(result.bands.map((band: { period: string }) => band.period), ["day", "week", "month"]);
  assert.equal(result.price, 10); assert.equal(result.price_source, "本机保存报价"); assert.equal(calls, 3);
  assert.equal((await (await f.request("/api/stocks/1/boll")).json()).cached, true); assert.equal(calls, 3);
  await f.request("/api/stocks/1/boll?refresh=1"); assert.equal(calls, 6);
  await f.request("/api/stocks/2/boll"); assert.equal(calls, 9);
  assert.deepEqual(await (await f.request("/api/stocks/1")).json(), before);
  await f.request("/api/stocks/1", "PATCH", { code: "600003" });
  await f.request("/api/stocks/1/boll"); assert.equal(calls, 12);
});

test("near bands and middle use inclusive 5% full-width thresholds without confusing proximity with a touch", () => {
  const band = { available: true, lower: 45, middle: 50, upper: 55 };
  const cases: [number, string][] = [
    [44.99, "below_lower"], [45, "at_lower"], [45.5, "near_lower"], [45.50001, "lower_half"],
    [49.49999, "lower_half"], [49.5, "at_middle"], [50.5, "at_middle"], [50.50001, "upper_half"],
    [54.49999, "upper_half"], [54.5, "near_upper"], [55, "at_upper"], [55.01, "above_upper"],
  ];
  for (const [price, expected] of cases) {
    assert.equal(pricePosition(band, price).position, expected, String(price));
    const scaled = { ...band, lower: 450, middle: 500, upper: 550 };
    assert.equal(pricePosition(scaled, price * 10).position, expected);
  }
  for (const missing of [null, NaN, Infinity]) assert.equal(pricePosition(band, missing).position, "unknown");
});

test("partial failures and short histories keep valid timeframes and remain retryable", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close()); let calls = 0;
  f.source.fetchKline = async (_stock, period) => {
    calls++;
    if (period === "week") throw new Error("timeout");
    return { bars: candles(period === "month" ? 5 : 30), adjustment: "none", quote: null };
  };
  const result = await (await f.request("/api/stocks/1/boll")).json();
  assert.equal(result.bands[0].available, true); assert.equal(result.bands[1].available, false);
  assert.equal(result.bands[2].count, 5); assert.ok(!("lower" in result.bands[2]));
  assert.equal((await (await f.request("/api/stocks/1/boll")).json()).cached, false); assert.equal(calls, 6);
});
