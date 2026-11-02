import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { fixture } from "./helpers.ts";

test("slow portfolio refresh resumes after the last batch across handler restarts and deleted cursor stocks", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls: string[] = [];
  const f = fixture({ fetchQuotes: async () => ({ quotes: new Map(), errors: [] }), fetchDividends: async stock => {
    calls.push(stock.code);
    if (calls.length % 4 === 0) now += 20_000;
    return { annual_dividend: 0.5, rolling_dividend: 0.6, annual_year: 2025, confirmed: true,
      ex_dividend_date: null, dividends: [], dividend_source: "test", dividend_updated_at: "2026-11-02", dividend_fx_rate: null };
  } });
  t.after(() => f.db.sqlite.close());
  await f.request("/api/health");
  f.db.sqlite.exec("DELETE FROM stocks");
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) {
    const response = await f.request("/api/stocks", "POST", { code: String(600001 + i), market: "A", name: `股票${i}`, sector: "银行" });
    assert.equal(response.status, 201);
    ids.push((await response.json()).id);
  }
  const first = await (await f.request("/api/refresh", "POST", {})).json();
  assert.equal(first.dividends_updated, 8);
  assert.ok(first.errors.some((error: string) => error.includes("其余 4 支")));
  assert.deepEqual(calls, Array.from({ length: 8 }, (_, i) => String(600001 + i)));
  // Refreshing a different single stock must not move the portfolio cursor.
  await f.request(`/api/stocks/${ids[11]}/refresh`, "POST", {});
  await f.request(`/api/stocks/${ids[7]}`, "DELETE");
  calls = [];
  const restarted = createHandler(f.source);
  const response = await restarted(new Request("http://localhost/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.slice(0, 4), ["600009", "600010", "600011", "600012"]);
  for (const id of ids.slice(8)) assert.equal((await (await f.request(`/api/stocks/${id}`)).json()).annual_dividend, 0.5);
});

test("failed batches advance continuation without changing saved data or the last successful refresh time", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls: string[] = [];
  const f = fixture({ fetchQuotes: async () => ({ quotes: new Map(), errors: [] }), fetchDividends: async stock => {
    calls.push(stock.code);
    now += 40_000;
    throw new Error("offline");
  } });
  t.after(() => f.db.sqlite.close());
  const added = await (await f.request("/api/stocks", "POST", { code: "600003", market: "A", name: "尾部股票", sector: "银行", annual_dividend: 0.8 })).json();
  for (let i = 4; i <= 5; i++) await f.request("/api/stocks", "POST", { code: `60000${i}`, market: "A", name: `股票${i}`, sector: "银行" });
  const before = await (await f.request(`/api/stocks/${added.id}`)).json();
  assert.equal((await f.request("/api/refresh", "POST", {})).status, 502);
  assert.equal(calls.length, 4);
  assert.deepEqual(await (await f.request(`/api/stocks/${added.id}`)).json(), before);
  assert.equal((await (await f.request("/api/stocks")).json()).meta.last_refresh, null);
  calls = [];
  assert.equal((await f.request("/api/refresh", "POST", {})).status, 502);
  assert.equal(calls[0], "600005");
});
