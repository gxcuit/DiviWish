import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MARKET_SELECTION, MARKET_A_OPTIONS, MARKET_B_OPTIONS, resolveMarketSelection } from "../market-indices.ts";
import { MarketService } from "../market.ts";
import type { MarketIndex } from "../market.ts";

function history(code: MarketIndex) {
  const step = { H00922: 1, H20269: 2, H20955: 3, "000510CNY010": 0.5 }[code];
  return Array.from({ length: 350 }, (_, i) => ({ date: new Date(Date.parse("2025-01-01") + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i * step }));
}

test("allowlists expose three total-return A choices and one B; reject price codes, swapped roles and arbitrary input", () => {
  assert.deepEqual(MARKET_A_OPTIONS.map(option => option.code), ["H00922", "H20269", "H20955"]);
  assert.deepEqual(MARKET_B_OPTIONS.map(option => option.code), ["000510CNY010"]);
  assert.deepEqual(resolveMarketSelection(), DEFAULT_MARKET_SELECTION);
  for (const code of ["000922", "H30269", "930955", "000510CNY010", "https://example.test", "", "h00922"]) assert.throws(() => resolveMarketSelection(code), /不支持/);
  for (const code of ["000510", "H00922", "", "H20269"]) assert.throws(() => resolveMarketSelection(undefined, code), /不支持/);
});

test("each combination gets distinct spread, relative bands and A regression while successful B history is reused", async () => {
  const calls: MarketIndex[] = [];
  const service = new MarketService(async code => { calls.push(code); return history(code); });
  const snapshots = [];
  for (const option of MARKET_A_OPTIONS) snapshots.push(await service.get(false, resolveMarketSelection(option.code)));
  assert.equal(calls.length, 4); assert.equal(calls.filter(code => code === "000510CNY010").length, 1);
  assert.deepEqual(snapshots.map(data => data.selection.a.code), MARKET_A_OPTIONS.map(option => option.code));
  assert.ok(snapshots[0].latest.spread < snapshots[1].latest.spread && snapshots[1].latest.spread < snapshots[2].latest.spread);
  assert.ok(snapshots[0].relative.latest.ratio < snapshots[1].relative.latest.ratio);
  assert.ok(snapshots[0].regression!.annualized_return < snapshots[1].regression!.annualized_return);
  snapshots[0].selection.a.name = "mutated"; snapshots[0].latest.spread = 99;
  const hit = await service.get();
  assert.equal(hit.cached, true); assert.equal(hit.selection.a.name, "中证红利全收益"); assert.notEqual(hit.latest.spread, 99);
  assert.equal(calls.length, 4);
});

test("a failed/new combination cannot return another A's cache, and retry cooldowns remain per-combination", async () => {
  let now = Date.parse("2026-11-17T08:30:00Z"), failCode: string | null = null, calls = 0;
  const service = new MarketService(async code => { calls++; if (code === failCode) throw new Error("upstream failed"); return history(code); }, () => now);
  const base = await service.get();
  failCode = "H20269";
  await assert.rejects(service.get(false, resolveMarketSelection("H20269")), /暂未取得/);
  const afterFailure = calls;
  await assert.rejects(service.get(true, resolveMarketSelection("H20269")), /一分钟/); assert.equal(calls, afterFailure);
  assert.equal((await service.get()).selection.a.code, "H00922");
  const third = await service.get(false, resolveMarketSelection("H20955")); assert.equal(third.stale, false);
  now += 31 * 60_000; failCode = "H00922";
  const stale = await service.get(); assert.equal(stale.stale, true); assert.equal(stale.selection.a.code, "H00922"); assert.equal(stale.latest.spread, base.latest.spread);
  assert.equal((await service.get(false, resolveMarketSelection("H20955"))).selection.a.code, "H20955");
  failCode = null; assert.equal((await service.get(false, resolveMarketSelection("H20269"))).selection.a.code, "H20269");
});
