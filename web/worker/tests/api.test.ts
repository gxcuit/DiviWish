import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { fixture } from "./helpers.ts";

test("stock CRUD, duplicates, light list and detailed history retain the API contract", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  assert.equal((await (await f.request("/api/health")).json()).count, 2);
  const list = await (await f.request("/api/stocks")).json();
  assert.equal(list.stocks[0].dividend_yield, 0.05);
  assert.ok(!("history" in list.stocks[0]));
  assert.ok(!("connect_factor" in list.stocks[1]));
  assert.equal((await (await f.request("/api/stocks/1")).json()).history.length, 80);
  const payload = { code: "600002", name: "手动标的", market: "A", sector: "电力", price: 5, annual_dividend: 0.3, target_yield: 0.05 };
  const added = await f.request("/api/stocks", "POST", payload);
  assert.equal(added.status, 201);
  const stock = await added.json(); assert.equal(stock.dividend_yield, 0.06);
  assert.equal((await f.request("/api/stocks", "POST", payload)).status, 409);
  assert.equal((await f.request(`/api/stocks/${stock.id}`, "PATCH", { watched: true })).status, 200);
  const restarted = createHandler(f.source);
  const saved = await (await restarted(new Request(`http://localhost/api/stocks/${stock.id}`), f.env)).json();
  assert.equal(saved.watched, true);
  assert.equal((await f.request(`/api/stocks/${stock.id}`, "DELETE")).status, 200);
  assert.equal((await f.request(`/api/stocks/${stock.id}`)).status, 404);
  for (const path of ["/api/import", "/api/export"]) assert.equal((await f.request(path)).status, 404);
});

test("invalid updates leave the full saved document unchanged", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const before = await (await f.request("/api/stocks/1")).json();
  for (const invalid of [{ price: 0 }, { price: true }, { price: "5" }, { annual_dividend: -1 }, { target_yield: 5 },
    { confirmed: "yes" }, { ex_dividend_date: "2026-02-30" }, { code: "123" }, { grid_start: 0 }, { grid_end: 0.02 },
    { grid_step: -0.01 }, { grid_step: 0.00001 }, { grid_end: "0.05" }, { grid_end: 1.1 },
    { yield_basis: [] }, { yield_basis: "invalid" }, { yield_basis: "custom" }, { custom_yield: -0.01 }, { custom_yield: true },
    { custom_yield: 1.1 }, { custom_yield: "0.05" }, { unknown: 1 }]) {
    assert.equal((await f.request("/api/stocks/1", "PATCH", invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.deepEqual(await (await f.request("/api/stocks/1")).json(), before);
});

test("basis, grid, zero custom rates and security edits preserve the established calculation rules", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  let response = await f.request("/api/stocks/1", "PATCH", { yield_basis: "rolling", grid_start: 0.04, grid_end: 0.06, grid_step: 0.005 });
  assert.equal(response.status, 200);
  let detail = await (await f.request("/api/stocks/1")).json();
  assert.equal(detail.selected_yield, 0.06); assert.equal(detail.dividend_yield, 0.05); assert.ok(Math.abs(detail.target_price - 12) < 1e-12);
  assert.equal(detail.percentile, 0.75); assert.deepEqual(detail.yield_grid.map((row: { yield: number }) => row.yield), [0.04, 0.045, 0.05, 0.055, 0.06]);
  assert.equal((await (await f.request("/api/stocks/2")).json()).grid_start, 0.03);
  await f.request("/api/stocks/1", "PATCH", { yield_basis: "custom", custom_yield: 0.08 });
  response = await f.request("/api/stocks/1", "PATCH", { price: 20 });
  detail = await response.json(); assert.equal(detail.selected_yield, 0.08); assert.equal(detail.target_price, 32);
  await f.request("/api/stocks/1", "PATCH", { custom_yield: 0 });
  detail = await (await f.request("/api/stocks/1")).json(); assert.equal(detail.selected_yield, 0); assert.equal(detail.target_price, 0);
  await f.request("/api/stocks/1", "PATCH", { code: "600009" });
  detail = await (await f.request("/api/stocks/1")).json();
  for (const field of ["price", "annual_dividend", "rolling_dividend", "quote_date", "percentile", "custom_yield"]) assert.equal(detail[field], null, field);
  assert.equal(detail.yield_basis, "annual"); assert.deepEqual(detail.history, []); assert.deepEqual(detail.dividends, []);
});

test("dividend edits clear history and allow explicitly reverified rolling amounts", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const response = await f.request("/api/stocks/1", "PATCH", { annual_dividend: 0.8, rolling_dividend: 0.9 });
  const stock = await response.json(); assert.equal(stock.rolling_dividend, 0.9); assert.equal(stock.percentile, null);
  assert.equal(stock.confirmed, false); assert.equal((await (await f.request("/api/stocks/1")).json()).history.length, 0);
});

test("empty sectors, renames and deletes survive handler restart and retain stock settings", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  assert.equal((await f.request("/api/sectors", "POST", { name: "新板块" })).status, 201);
  assert.equal((await f.request("/api/sectors", "POST", { name: "新板块" })).status, 409);
  let sectors = (await (await f.request("/api/sectors")).json()).sectors;
  const bank = sectors.find((row: { name: string }) => row.name === "银行");
  await f.request("/api/stocks/1", "PATCH", { watched: true, grid_step: 0.01 });
  assert.equal((await f.request(`/api/sectors/${bank.id}`, "PATCH", { name: "金融" })).status, 200);
  assert.equal((await (await f.request("/api/stocks/1")).json()).sector, "金融");
  assert.equal((await (await f.request(`/api/sectors/${bank.id}`, "DELETE")).json()).moved, 2);
  const restarted = createHandler(f.source);
  const detail = await (await restarted(new Request("http://localhost/api/stocks/1"), f.env)).json();
  assert.equal(detail.sector, "未分类"); assert.equal(detail.watched, true); assert.equal(detail.grid_step, 0.01);
  sectors = (await (await f.request("/api/sectors")).json()).sectors;
  assert.ok(sectors.some((row: { name: string }) => row.name === "新板块"));
  assert.ok(!sectors.some((row: { name: string }) => row.name === "金融"));
  const protectedId = sectors.find((row: { protected: boolean }) => row.protected).id;
  assert.equal((await f.request(`/api/sectors/${protectedId}`, "DELETE")).status, 400);
  assert.equal((await f.request(`/api/sectors/${protectedId}`, "PATCH", { name: "新名称" })).status, 400);
  for (const name of ["", "全部", "中".repeat(31), null]) assert.equal((await f.request("/api/sectors", "POST", { name })).status, 400);
});

test("refresh failure preserves every value; partial success keeps old missing quotes and history dates", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const before = await (await f.request("/api/stocks")).json();
  assert.equal((await f.request("/api/refresh", "POST", {})).status, 502);
  assert.deepEqual(await (await f.request("/api/stocks")).json(), before);
  f.source.fetchQuotes = async () => ({ quotes: new Map([[1, { price: 8, change_pct: -0.01, quote_date: "2026-10-21" }]]), errors: ["hk00001 缺失"] });
  const response = await f.request("/api/refresh", "POST", {});
  assert.equal(response.status, 200); assert.equal((await response.json()).updated, 1);
  const after = await (await f.request("/api/stocks")).json();
  assert.equal(after.stocks[0].price, 8); assert.equal(after.stocks[0].quote_date, "2026-10-21");
  assert.equal(after.stocks[0].percentile_end, "2026-10-20");
  for (const field of ["price", "quote_date", "updated_at", "annual_dividend"]) assert.equal(after.stocks[1][field], before.stocks[1][field]);
  assert.equal(after.stocks[1].ah_premium, 8 / (8 * 0.8) - 1);
});

test("refresh merges quotes without overwriting concurrent edits and skips changed identities", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.source.fetchQuotes = async () => {
    await f.request("/api/stocks/1", "PATCH", { watched: true, yield_basis: "custom", custom_yield: 0.08 });
    await f.request("/api/stocks/2", "PATCH", { code: "00002" });
    return { quotes: new Map([[1, { price: 9, quote_date: "2026-10-21" }], [2, { price: 20, quote_date: "2026-10-21" }]]), errors: [] };
  };
  const response = await f.request("/api/refresh", "POST", {});
  assert.equal((await response.json()).updated, 1);
  const stock = await (await f.request("/api/stocks/1")).json();
  assert.equal(stock.watched, true); assert.equal(stock.price, 9); assert.equal(stock.selected_yield, 0.08);
  assert.equal((await (await f.request("/api/stocks/2")).json()).price, null);
});

test("search merges local and remote results and falls back on network failures", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.source.searchStocks = async () => [
    { name: "测试股票", market: "A", code: "600001" }, { name: "测试新股", market: "A", code: "600003" },
    { name: "测试港股", market: "HK", code: "00001" },
  ];
  const result = await (await f.request("/api/stocks/search?q=测试")).json();
  assert.equal(result.suggestions.length, 3); assert.equal(result.suggestions[0].sector, "银行");
  assert.equal(result.suggestions[2].existing, false);
  f.source.searchStocks = async () => { throw new Error("timeout"); };
  const failed = await (await f.request("/api/stocks/search?q=600001")).json();
  assert.equal(failed.suggestions[0].code, "600001"); assert.match(failed.message, /手动填写/);
  assert.deepEqual((await (await f.request("/api/stocks/search?q=%20")).json()).suggestions, []);
  assert.equal((await f.request("/api/stocks/search?q=" + "中".repeat(41))).status, 400);
});

test("refresh applies no stale quote or freshness metadata when every fetched security changes identity", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const before = (await (await f.request("/api/stocks")).json()).meta;
  f.source.fetchQuotes = async () => {
    await f.request("/api/stocks/1", "PATCH", { code: "600009" });
    return { quotes: new Map([[1, { price: 9, quote_date: "2026-10-21" }]]), errors: [] };
  };
  f.source.fetchFx = async () => 0.9;
  const response = await f.request("/api/refresh", "POST", {});
  assert.equal(response.status, 502); assert.equal((await response.json()).updated, 0);
  assert.deepEqual((await (await f.request("/api/stocks")).json()).meta, before);
  assert.equal((await (await f.request("/api/stocks/1")).json()).price, null);
});

test("standalone API needs no login and protects same-origin JSON writes", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  for (const route of ["/api/auth/login", "/api/auth/register", "/api/auth/session", "/api/auth/linuxdo/start"]) {
    assert.equal((await f.request(route)).status, 404);
  }
  const write = (origin: string, extra = {}) => f.handler(new Request("http://localhost/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extra }, body: "{}",
  }), f.env);
  assert.equal((await write("https://evil.example")).status, 403);
  assert.equal((await write("http://localhost", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await write("http://localhost")).status, 502);
  assert.equal((await f.request("/api/refresh", "POST")).status, 415);
  assert.equal((await f.handler(new Request("http://localhost/api/stocks", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(128 * 1024 + 1),
  }), f.env)).status, 413);
  assert.equal((await f.handler(new Request("http://localhost/api/stocks", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  }), f.env)).status, 400);
});
