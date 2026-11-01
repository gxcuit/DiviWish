import assert from "node:assert/strict";
import { test } from "node:test";
import { BollStore, bollKey } from "../../src/features/dividends/boll-store.ts";
import { bollLabels } from "../../src/features/dividends/boll-labels.ts";
import type { BollResponse } from "../../src/features/dividends/types.ts";
import { sampleStocks } from "./helpers.ts";

function response(price = 50): BollResponse {
  return { window: 20, multiplier: 2, price, quote_date: "2026-10-30", price_source: "test", source: "test", cached: false,
    fetched_at: "2026-10-30T12:00:00Z", bands: [{ period: "day", label: "日线", available: true, count: 20,
      lower: 45, middle: 50, upper: 55, start_date: "2026-10-01", last_date: "2026-10-30", position: "at_middle", percent_b: 0.5 }] };
}

test("list and detail coalesce requests, reuse five-minute data and share forced updates", async t => {
  let now = 1_000_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const stock = { ...sampleStocks()[0], id: 1 }, key = bollKey(stock);
  const store = new BollStore(async () => response(++calls));
  let notifications = 0;
  const unsubscribe = store.subscribe(key, () => notifications++);
  const first = store.fetch(stock), detail = store.fetch(stock);
  assert.equal(first, detail); await first;
  await store.fetch(stock); assert.equal(calls, 1);
  now += 300_000; await store.fetch(stock); assert.equal(calls, 2);
  await store.fetch(stock, true); assert.equal(store.get(key).data!.price, 3);
  assert.ok(notifications >= 6); unsubscribe();
  assert.notEqual(bollKey({ ...stock, code: "600009" }), key);
  assert.notEqual(bollKey({ ...stock, price: 11 }), key);
});

test("visible rows use at most two concurrent requests and queued rows eventually complete", async () => {
  const stock = { ...sampleStocks()[0], id: 1 }, release: (() => void)[] = [];
  let active = 0, maximum = 0, calls = 0;
  const store = new BollStore(async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => release.push(resolve));
    active--; return response();
  });
  const requests = Array.from({ length: 5 }, (_, i) => store.fetch({ ...stock, id: i + 1 }));
  assert.equal(calls, 2);
  for (let i = 0; i < requests.length; i++) { release[i](); await requests[i]; }
  assert.equal(calls, 5); assert.equal(maximum, 2);
});

test("account teardown cancels pending work and ignores late responses; another dashboard has no cached portfolio data", async () => {
  const stock = { ...sampleStocks()[0], id: 1 }, key = bollKey(stock), releases: (() => void)[] = [], signals: AbortSignal[] = [];
  const store = new BollStore(async (_stock, signal) => {
    signals.push(signal); await new Promise<void>(resolve => releases.push(resolve)); return response();
  });
  const requests = Array.from({ length: 3 }, (_, i) => store.fetch({ ...stock, id: i + 1 }));
  store.reset(); await Promise.all(requests);
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(signals.length, 2);
  releases.forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(key).data, null);
  assert.equal(new BollStore(async () => response()).get(key).data, null);
});

test("partial histories retry and a failed update retains dated data with an explicit error", async () => {
  const stock = { ...sampleStocks()[0], id: 1 }, key = bollKey(stock);
  let calls = 0;
  const store = new BollStore(async () => {
    calls++;
    if (calls === 1) return { ...response(), bands: [{ period: "day", label: "日线", available: false, error: "不足 20 根" }] };
    if (calls === 3) throw new Error("上游暂不可用");
    return response();
  });
  await store.fetch(stock); await store.fetch(stock); assert.equal(calls, 2);
  await store.fetch(stock, true);
  assert.equal(store.get(key).data!.price, 50); assert.match(store.get(key).error, /上游暂不可用/);
  await store.fetch(stock); assert.equal(calls, 4); assert.equal(store.get(key).error, "");
});

test("all BOLL states produce exactly two-character tags while near and reached tracks remain distinguishable", () => {
  for (const label of Object.values(bollLabels)) for (const period of ["日", "周", "月"]) assert.equal(Array.from(period + label.short).length, 2);
  assert.equal(bollLabels.near_upper.short, "上"); assert.equal(bollLabels.at_upper.short, "上");
  assert.notEqual(bollLabels.near_upper.tone, bollLabels.at_upper.tone);
  assert.match(bollLabels.near_upper.text, /尚未触轨/); assert.equal(bollLabels.at_middle.short, "中");
});
