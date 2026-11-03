import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dailyDividend, dividendAtFx, dividendCacheKey } from "../dividend-cache.ts";
import type { DividendSnapshot, Providers } from "../types.ts";
import { sampleStocks, TestDatabase } from "./helpers.ts";

const snapshot: DividendSnapshot = { annual_dividend: 0.5, rolling_dividend: 0.6, annual_year: 2025, confirmed: true,
  ex_dividend_date: null, dividends: [], dividend_source: "public test source", dividend_updated_at: "2026-11-03T10:00:00+08:00", dividend_fx_rate: null };
const sourceWith = (fetchDividends: NonNullable<Providers["fetchDividends"]>): Providers => ({ fetchDividends,
  searchStocks: async () => [], fetchQuotes: async () => ({ quotes: new Map(), errors: [] }), fetchFx: async () => 0.9,
  fetchKline: async () => ({ bars: [], adjustment: "none", quote: null }),
});

test("daily public cache survives database restart and never stores personal settings or manual dividends", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diviwish-public-cache-"));
  let db = new TestDatabase(path.join(dir, "test.sqlite3")), calls = 0;
  const stock = { ...sampleStocks()[0], annual_dividend: 999, sector: "私人板块", watched: true };
  const source = sourceWith(async identity => {
    calls++;
    assert.equal(identity.annual_dividend, null); assert.equal(identity.watched, false); assert.equal(identity.sector, "未分类");
    return { ...snapshot, annual_dividend: 0, rolling_dividend: 0, watched: true, price: 999, user_id: "private", history: ["private"] };
  });
  try {
    const first = await dailyDividend(db.binding, stock, source);
    assert.equal(first.cached, false); assert.equal(first.snapshot.annual_dividend, 0);
    db.sqlite.close(); db = new TestDatabase(path.join(dir, "test.sqlite3"));
    const second = await dailyDividend(db.binding, { ...stock, id: 999, annual_dividend: 888, watched: false }, source);
    assert.equal(second.cached, true); assert.equal(calls, 1);
    assert.equal(second.snapshot.annual_dividend, 0);
    const stored = JSON.parse(db.sqlite.prepare("SELECT snapshot FROM public_dividend_cache").get()!.snapshot as string);
    for (const key of ["watched", "price", "user_id", "history", "sector", "id"]) assert.ok(!(key in stored), key);
    second.snapshot.annual_dividend = 123;
    assert.equal((await dailyDividend(db.binding, stock, source)).snapshot.annual_dividend, 0);
    assert.equal(stock.annual_dividend, 999);
  } finally { db.sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cache day rolls over at UTC+8 midnight and distinct markets and security types do not collide", async t => {
  let now = Date.UTC(2026, 10, 2, 15, 59), calls = 0;
  t.mock.method(Date, "now", () => now);
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  const stock = sampleStocks()[0], source = sourceWith(async () => { calls++; return structuredClone(snapshot); });
  await dailyDividend(db.binding, stock, source);
  await dailyDividend(db.binding, stock, source); assert.equal(calls, 1);
  now += 120_000;
  assert.equal((await dailyDividend(db.binding, stock, source)).cached, false); assert.equal(calls, 2);
  await dailyDividend(db.binding, stock, source, true); assert.equal(calls, 3);
  assert.equal(dividendCacheKey(stock), dividendCacheKey({ ...stock, exchange: "sh" }));
  assert.notEqual(dividendCacheKey(stock), dividendCacheKey({ ...stock, market: "HK" }));
  assert.notEqual(dividendCacheKey(stock), dividendCacheKey({ ...stock, instrument_type: "etf", exchange: "sh" }));
});

test("database leases deduplicate concurrent requests and a late expired holder cannot overwrite newer facts", async t => {
  let now = Date.UTC(2026, 10, 3), calls = 0;
  t.mock.method(Date, "now", () => now);
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  const stock = sampleStocks()[0];
  let release = () => {}, started = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const source = sourceWith(async () => {
    calls++;
    if (calls === 1) { started(); await gate; return { ...snapshot, annual_dividend: 1 }; }
    return { ...snapshot, annual_dividend: 2 };
  });
  const first = dailyDividend(db.binding, stock, source);
  try {
    await ready;
    await assert.rejects(dailyDividend(db.binding, stock, source), /正在更新/);
    assert.equal(calls, 1);
    now += 61_000;
    assert.equal((await dailyDividend(db.binding, stock, source)).snapshot.annual_dividend, 2);
    release();
    assert.equal((await first).snapshot.annual_dividend, 2);
    assert.equal((await dailyDividend(db.binding, stock, source)).snapshot.annual_dividend, 2);
    assert.equal(calls, 2);
  } finally { release(); await first; }
});

test("failed daily updates preserve the verified cache, back off retries and recover after the delay", async t => {
  let now = Date.UTC(2026, 10, 3), calls = 0, fail = false;
  t.mock.method(Date, "now", () => now);
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  const source = sourceWith(async () => { calls++; if (fail) throw new Error("offline"); return structuredClone(snapshot); });
  const stock = sampleStocks()[0];
  await dailyDividend(db.binding, stock, source);
  const before = db.sqlite.prepare("SELECT snapshot,cache_day FROM public_dividend_cache").get();
  now += 86_400_000; fail = true;
  await assert.rejects(dailyDividend(db.binding, stock, source), /offline/);
  assert.deepEqual(db.sqlite.prepare("SELECT snapshot,cache_day FROM public_dividend_cache").get(), before);
  await assert.rejects(dailyDividend(db.binding, stock, source), /稍后/); assert.equal(calls, 2);
  now += 300_001; fail = false;
  assert.equal((await dailyDividend(db.binding, stock, source)).cached, false); assert.equal(calls, 3);
});

test("cached HKD cash is revalued using current FX without changing the common snapshot", () => {
  const hk = { ...snapshot, annual_dividend: 0.8, rolling_dividend: 1.6, dividend_fx_rate: 0.8,
    dividend_hkd_annual: 1, dividend_hkd_rolling: 2, dividends: [{ period: "2025-12-31", dps: 0.8, hkd_dps: 1, status: "已发放" }] };
  const current = dividendAtFx(hk, 0.9);
  assert.equal(current.annual_dividend, 0.9); assert.equal(current.rolling_dividend, 1.8);
  assert.equal(current.dividends[0].dps, 0.9); assert.equal(hk.annual_dividend, 0.8);
});

