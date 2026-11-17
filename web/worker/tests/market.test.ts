import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarketSeries, fetchIndexHistory, MARKET_INDICES, MarketService, marketEnd, parseIndexHistory } from "../market.ts";
import type { IndexBar } from "../market-types.ts";

function bars(count = 90): IndexBar[] {
  const rows: IndexBar[] = [];
  for (let day = Date.parse("2026-01-01"); rows.length < count; day += 86_400_000) {
    const date = new Date(day);
    if ([0, 6].includes(date.getUTCDay())) continue;
    rows.push({ date: date.toISOString().slice(0, 10), close: 100 + rows.length });
  }
  return rows;
}
const end = "2026-11-16";
const payload = (rows: IndexBar[], code: string = MARKET_INDICES.dividend) => ({ code: "200", data: rows.map(row => ({ tradeDate: row.date.replaceAll("-", ""), close: row.close, indexCode: code })) });

test("40-day spread uses 41 closes, identical dates and subtraction in the required direction", () => {
  const dividend = bars(41), a500 = bars(41).map(row => ({ ...row, close: 100 }));
  const result = buildMarketSeries(dividend, a500, end);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].spread - 0.4) < 1e-12);
  assert.equal(result[0].start_date, dividend[0].date);
  assert.equal(result[0].date, dividend[40].date);
  assert.ok(Date.parse(result[0].date) - Date.parse(result[0].start_date) > 40 * 86_400_000);
  assert.ok(buildMarketSeries(a500, dividend, end)[0].spread < 0);
  const bothFalling = buildMarketSeries(dividend.map((row, i) => ({ ...row, close: 100 - i / 4 })), dividend.map((row, i) => ({ ...row, close: 100 - i / 2 })), end)[0];
  assert.ok(bothFalling.dividend_return < 0 && bothFalling.a500_return < 0 && bothFalling.spread > 0);
  assert.throws(() => buildMarketSeries(bars(40), bars(40), end), /41/);
});

test("parsing sorts and deduplicates dates; rejects wrong codes, invalid dates, zeros and conflicting closes", () => {
  const rows = bars(45), input = payload([...rows].reverse().concat(rows[0]));
  assert.deepEqual(parseIndexHistory(input, MARKET_INDICES.dividend, rows[0].date, end), rows);
  assert.throws(() => parseIndexHistory(payload(rows, "000922"), MARKET_INDICES.dividend, rows[0].date, end), /代码/);
  for (const patch of [{ tradeDate: "20260230" }, { close: null }, { close: "" }, { close: 0 }, { close: -1 }, { close: true }, { close: Infinity }]) {
    const invalid = payload(rows); Object.assign(invalid.data[0], patch);
    assert.throws(() => parseIndexHistory(invalid, MARKET_INDICES.dividend, rows[0].date, end));
  }
  assert.throws(() => parseIndexHistory(payload([...rows, { ...rows[0], close: 999 }]), MARKET_INDICES.dividend, rows[0].date, end), /冲突/);
  assert.throws(() => parseIndexHistory({ code: "500", data: [] }, MARKET_INDICES.dividend, rows[0].date, end));
});

test("missing sessions are not compressed; mismatched latest dates align and incomplete current windows fail", () => {
  const rows = bars(100), missing = rows.filter((_, i) => i !== 45);
  const result = buildMarketSeries(rows, missing, end);
  assert.equal(result.filter(row => row.date >= rows[45].date && row.date <= rows[85].date).length, 0);
  assert.equal(result.at(-1)!.date, rows.at(-1)!.date);
  assert.equal(buildMarketSeries(rows, rows.slice(0, -1), end).at(-1)!.date, rows.at(-2)!.date);
  assert.throws(() => buildMarketSeries(rows, rows.filter((_, i) => i !== 80), end), /近期/);
  const cutoff = rows[70].date;
  assert.equal(buildMarketSeries(rows, rows, cutoff).at(-1)!.date, cutoff);
  assert.equal(buildMarketSeries([...rows].reverse(), rows, end).at(-1)!.date, rows.at(-1)!.date);
});

test("completed-session cutoff uses CST and a 16:00 publication buffer", () => {
  assert.equal(marketEnd(new Date("2026-11-17T07:59:59Z")), "2026-11-16");
  assert.equal(marketEnd(new Date("2026-11-17T08:00:00Z")), "2026-11-17");
  assert.equal(marketEnd(new Date("2026-11-17T16:30:00Z")), "2026-11-17");
});

test("public cache observes TTL, throttles force, preserves stale verified data, and recovers", async () => {
  let now = Date.parse("2026-11-17T08:30:00Z"), calls = 0, fail = false;
  const service = new MarketService(async () => { calls++; if (fail) throw new Error("timeout"); return bars(); }, () => now);
  const initial = await service.get(); assert.equal(calls, 2); assert.equal(initial.cached, false);
  initial.series[0].spread = 99;
  const hit = await service.get(true); assert.equal(calls, 2); assert.notEqual(hit.series[0].spread, 99);
  now += 60_001; await service.get(true); assert.equal(calls, 4);
  now += 31 * 60_000; fail = true;
  const stale = await service.get(); assert.equal(stale.stale, true); assert.ok(stale.warning); assert.equal(calls, 6);
  await service.get(true); assert.equal(calls, 6);
  now += 60_001; fail = false;
  assert.equal((await service.get()).stale, false); assert.equal(calls, 8);
});

test("first failure returns no fabricated data; publication mismatch warns; regressed history retains cache", async () => {
  const failed = new MarketService(async () => { throw new Error("bad upstream"); });
  await assert.rejects(failed.get(), /暂未取得/);
  await assert.rejects(failed.get(true), /一分钟/);
  let now = Date.now(), count = 90;
  const service = new MarketService(async code => bars(code === MARKET_INDICES.dividend ? count : count - 1), () => now);
  const first = await service.get(); assert.ok(first.warning); assert.equal(first.latest.date, bars(89).at(-1)!.date);
  now += 31 * 60_000; count = 80;
  const stale = await service.get(); assert.equal(stale.stale, true); assert.equal(stale.latest.date, first.latest.date);
});

test("provider requests only official total return codes, handles HTTP and bounds bodies", async t => {
  const rows = bars(45);
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, options?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.csindex.com.cn");
    assert.equal(url.searchParams.get("indexCode"), MARKET_INDICES.a500);
    assert.equal(url.searchParams.get("startDate"), "20260101");
    assert.ok(options?.signal);
    return Response.json(payload(rows, MARKET_INDICES.a500));
  });
  assert.deepEqual(await fetchIndexHistory(MARKET_INDICES.a500, "2026-01-01", end), rows);
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(fetchIndexHistory(MARKET_INDICES.a500, "2026-01-01", end), /503/);
  t.mock.method(globalThis, "fetch", async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(fetchIndexHistory(MARKET_INDICES.a500, "2026-01-01", end), /过大/);
});
