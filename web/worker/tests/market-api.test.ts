import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { MarketService } from "../market.ts";
import { fixture } from "./helpers.ts";

test("market API serves verified data, restricts methods, reports failure, and does not change the portfolio", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const before = await (await f.request("/api/stocks")).json();
  const service = new MarketService(async () => Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.parse("2026-01-01") + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i })));
  const handler = createHandler(f.source, service);
  const request = (method = "GET") => handler(new Request("http://localhost/api/market", { method }), f.env);
  const response = await request(); assert.equal(response.status, 200);
  const snapshot = await response.json(); assert.equal(snapshot.latest.spread, 0); assert.equal(snapshot.window, 40); assert.equal(snapshot.series.length, 50);
  assert.equal((await request("DELETE")).status, 405);
  assert.deepEqual(await (await f.request("/api/stocks")).json(), before);
  const failed = createHandler(f.source, new MarketService(async () => { throw new Error("timeout"); }));
  assert.equal((await failed(new Request("http://localhost/api/market"), f.env)).status, 502);
});

test("market API validates A/B before fetching and returns metadata matching each allowed combination", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  let calls = 0;
  const service = new MarketService(async code => { calls++; return Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.parse("2025-01-01") + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i * (code === "H20955" ? 3 : code === "H20269" ? 2 : 1) })); });
  const handler = createHandler(f.source, service);
  const request = (query: string) => handler(new Request(`http://localhost/api/market?${query}`), f.env);
  for (const query of ["a=000922", "a=H30269", "a=930955", "b=H00922", "b=000510", "a=", "b="]) assert.equal((await request(query)).status, 400, query);
  assert.equal(calls, 0);
  for (const code of ["H00922", "H20269", "H20955"]) {
    const response = await request(`a=${code}&b=000510CNY010`); assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.selection.a.code, code); assert.equal(data.selection.b.code, "000510CNY010");
    assert.equal(data.relative.window, 242); assert.equal(data.regression.count, 300);
  }
  assert.equal(calls, 4);
});
