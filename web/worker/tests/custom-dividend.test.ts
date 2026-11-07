import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { derive, yieldGrid } from "../calculations.ts";
import { validate } from "../validation.ts";
import { fixture, sampleStocks } from "./helpers.ts";
const near = (actual: unknown, expected: number) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const custom = (value: number | null = 1) => validate({ yield_basis: "custom", custom_dividend: value, custom_dividend_note: "全年普通股息假设" }, sampleStocks()[0]);

test("fixed per-share dividends produce the correct yields across banks, miners and oil stocks", () => {
  for (const code of ["601665", "601899", "601857"]) {
    const s = custom(); s.code = code;
    for (const [price, expected] of [[10, .1], [20, .05], [8, .125], [12.5, .08]]) {
      const r = derive({ ...s, price }, 1); near(r.selected_yield, expected); near(r.basis_dividend, 1); near(r.target_price, 20);
      near(yieldGrid({ ...s, price }, 1)[0].price, 1 / .03); near(yieldGrid({ ...s, price }, 1, "sell")[0].price, 25);
    }
  }
});

test("HKD and CNY dividends are converted exactly once and only when needed", () => {
  const hk = validate({ yield_basis: "custom", custom_dividend: 1, custom_dividend_currency: "CNY" }, sampleStocks()[1]);
  near(derive(hk, .8).selected_yield, 1 / .8 / 8); near(derive(hk, .8).basis_dividend, 1.25);
  assert.equal(derive(hk, null).selected_yield, null); assert.equal(derive(hk, 0).target_price, null);
  const native = validate({ custom_dividend_currency: "HKD" }, hk); near(derive(native, null).selected_yield, .125);
  const a = validate({ custom_dividend_currency: "HKD" }, custom()); near(derive(a, .8).selected_yield, .08);
  near(derive(validate({ custom_dividend: 0 }, hk), null).selected_yield, 0);
});

test("amount zero, unknown prices and missing dividends remain distinct", () => {
  const s = custom(0); near(derive(s, 1).selected_yield, 0); near(derive(s, 1).target_price, 0);
  const noPrice = { ...custom(), price: null }; assert.equal(derive(noPrice, 1).selected_yield, null); near(derive(noPrice, 1).target_price, 20);
  const missing = { ...custom(), custom_dividend: null, custom_yield: .5 }; assert.equal(derive(missing, 1).selected_yield, null);
  assert.equal(yieldGrid(missing, 1)[0].price, null);
});

test("history uses the same fixed dividend after price changes and is explicitly an estimate", () => {
  const s = custom(), before = derive(s, 1), after = derive({ ...s, price: 20 }, 1);
  assert.deepEqual(before.percentile_history, after.percentile_history); near(before.quantile_30_price, after.quantile_30_price!);
  near(before.custom_dividend, after.custom_dividend!); assert.notEqual(before.selected_yield, after.selected_yield);
});

test("invalid amounts, notes, currencies and retired percentage/forecast inputs are rejected", () => {
  for (const patch of [{ custom_dividend: -1 }, { custom_dividend: "1" }, { custom_dividend: true }, { custom_dividend: Infinity }, { custom_dividend: 1e10 },
    { custom_dividend_note: 1 }, { custom_dividend_note: "a".repeat(2001) }, { custom_dividend_currency: "USD" }, { custom_yield: .1 }, { yield_basis: "forecast" }, { forecast_manual: {} }]) {
    assert.throws(() => validate(patch, custom()));
  }
  const changed = validate({ code: "600002" }, custom()); assert.equal(changed.custom_dividend, null); assert.equal(changed.custom_dividend_note, "");
});

test("one-time migration anchors legacy rates, preserves manual amounts and archives originals", t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const files = readdirSync(new URL("../../migrations/", import.meta.url));
  const sql = readFileSync(new URL(`../../migrations/${files.find(n => n.endsWith('_custom_dividends_legacy.sql'))}`, import.meta.url), "utf8");
  const cases = [
    { data: { yield_basis: "custom", price: 10, custom_yield: .08 }, expected: .8, basis: "custom" },
    { data: { yield_basis: "custom", price: null, custom_yield: .08 }, expected: null, basis: "custom" },
    { data: { yield_basis: "custom", price: null, custom_yield: 0 }, expected: 0, basis: "custom" },
    { data: { yield_basis: "forecast", forecast_manual: { kind: "per_share", year, dividend: 2, currency: "HKD", note: "人工备注" }, forecast_snapshot: { private: "retained" } }, expected: 2, basis: "custom" },
    { data: { yield_basis: "forecast", forecast_manual: { kind: "per_share", year: year - 1, dividend: 2, currency: "CNY" }, custom_yield: .8, price: 10 }, expected: null, basis: "custom" },
    { data: { yield_basis: "annual", price: 10, custom_yield: .06 }, expected: .6, basis: "annual" },
  ];
  for (const item of cases) {
    f.db.sqlite.prepare("UPDATE stocks SET document=? WHERE id=1").run(JSON.stringify(item.data)); f.db.sqlite.exec(sql);
    let doc = JSON.parse(String(f.db.sqlite.prepare("SELECT document FROM stocks WHERE id=1").get()!.document));
    assert.equal(doc.custom_dividend, item.expected); assert.equal(doc.yield_basis, item.basis);
    for (const [key, value] of Object.entries(item.data)) if (key !== "yield_basis") assert.deepEqual(doc[key], value);
    doc.price = 20; f.db.sqlite.prepare("UPDATE stocks SET document=? WHERE id=1").run(JSON.stringify(doc)); f.db.sqlite.exec(sql);
    doc = JSON.parse(String(f.db.sqlite.prepare("SELECT document FROM stocks WHERE id=1").get()!.document)); assert.equal(doc.custom_dividend, item.expected);
  }
});

test("API persists notes and quote refresh cannot overwrite concurrent dividend edits", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const response = await f.request("/api/stocks/1", "PATCH", { yield_basis: "custom", custom_dividend: 1, custom_dividend_currency: "CNY", custom_dividend_note: "人工全年假设" });
  assert.equal(response.status, 200, await response.clone().text());
  f.source.fetchQuotes = async () => {
    assert.equal((await f.request("/api/stocks/1", "PATCH", { custom_dividend: 2, custom_dividend_note: "期间修改" })).status, 200);
    return { quotes: new Map([[1, { price: 20, quote_date: "2026-11-07" }]]), errors: [] };
  };
  assert.equal((await f.request("/api/refresh?phase=quotes", "POST", {})).status, 200);
  const result = await (await f.request("/api/stocks/1")).json(); near(result.custom_dividend, 2); near(result.selected_yield, .1); near(result.target_price, 40);
  assert.equal(result.custom_dividend_note, "期间修改"); assert.equal(result.forecast, undefined); assert.equal(result.custom_yield, undefined);
  assert.equal((await f.request("/api/stocks/1/forecast")).status, 410);
});
