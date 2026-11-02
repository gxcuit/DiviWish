import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { derive } from "../calculations.ts";
import { buildEtfHistory, tradingSplits } from "../etf-history.ts";
import { parseEtfPage, parseSinaActions, type EtfDividend, type EtfPage } from "../etf.ts";
import { validate } from "../validation.ts";

const dates = (start: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * 86400_000).toISOString().slice(0, 10));
const event = (date: string, dps: number): EtfDividend => ({ date, period: date, record_date: date, pay_date: date, dps, status: "" });
const page = (...dividends: EtfDividend[]): EtfPage => ({ dividends, splits: [], split_warning: false });
const bars = (start = "2026-01-01", count = 90) => dates(start, count).map(date => ({ date, close: 2 }));

test("ETF history uses each day's calendar-year ex-date window, same-day cash, leap clamp and future exclusion", () => {
  const data = page(event("2025-02-28", 0.2), event("2026-02-28", 0.04), event("2026-04-01", 9));
  const result = buildEtfHistory(data, null, bars(), "2026-03-31");
  assert.equal(result.history_version, 3);
  assert.equal(result.history.find(row => row.date === "2026-02-27")!.rolling_yield, 0.1);
  assert.equal(result.history.find(row => row.date === "2026-02-28")!.rolling_yield, 0.02);
  assert.equal(result.history.at(-1)!.rolling_yield, 0.02);
  assert.equal(buildEtfHistory(page(event("2023-02-28", 1)), null, bars("2023-12-01", 91), "2024-02-29").history.at(-1)!.yield, 0);
});

test("ETF split normalization follows corroborated trading effective day without a false yield jump", () => {
  const data = page(event("2026-01-01", 0.2));
  data.splits = [{ date: "2026-02-06", ratio: 2 }];
  const sina = { dividends: new Map([["2026-01-01", 0.2]]), splits: [{ date: "2026-02-09", ratio: 2 }] };
  const prices = bars().map(row => ({ ...row, close: row.date < "2026-02-09" ? 2 : 1 }));
  const result = buildEtfHistory(data, sina, prices, "2026-03-31");
  assert.ok(result.history.every(row => row.yield === 0.1));
  assert.throws(() => buildEtfHistory(data, null, prices, "2026-03-31"), /拆分交易生效日/);
  assert.throws(() => buildEtfHistory(data, { ...sina, splits: [{ date: "2026-02-09", ratio: 3 }] }, prices, "2026-03-31"), /无法核实/);
  data.split_warning = true;
  assert.throws(() => buildEtfHistory(data, sina, prices, "2026-03-31"), /不完整/);
});

test("ETF samples require 60 days, valid raw prices, recent end and exclude outside-window data", () => {
  const data = page(event("2026-01-01", 0.2));
  assert.throws(() => buildEtfHistory(data, null, bars("2026-01-01", 59), "2026-02-28"), /至少需要 60/);
  assert.throws(() => buildEtfHistory(data, null, bars(), "2026-05-01"), /过旧/);
  assert.throws(() => buildEtfHistory(data, null, [{ date: "2026-01-01", close: 0 }], "2026-03-31"), /无效/);
  assert.throws(() => buildEtfHistory(data, null, [...bars(), { date: "2026-01-01", close: 3 }], "2026-03-31"), /不同/);
  const result = buildEtfHistory(data, null, [...bars(), { date: "2020-01-01", close: 1 }, { date: "2026-04-01", close: 1 }], "2026-03-31");
  assert.equal(result.history.length, 90);
});

test("ETF quantiles and target prices always use rolling cash even with annual/custom list settings", () => {
  const stock = validate({ code: "510880", name: "ETF", market: "A", sector: "ETF", instrument_type: "etf", exchange: "sh", price: 2, rolling_dividend: 0.12, annual_dividend: 0.5 });
  const history = bars().map((row, i) => ({ ...row, yield: i / 1000, rolling_yield: i / 1000 }));
  Object.assign(stock, { history, history_version: 3, history_status: "ready" });
  for (const yield_basis of ["annual", "rolling", "custom"] as const) {
    const result = derive({ ...stock, yield_basis, custom_yield: 0.2 }, 1);
    assert.equal(result.percentile, 61 / 90);
    assert.equal(result.quantile_60_yield, 0.053);
    assert.equal(result.quantile_90_yield, 0.08);
    assert.equal(result.quantile_60_price, 0.12 / 0.053);
    assert.equal(result.quantile_90_price, 1.5);
  }
  const result = derive({ ...stock, rolling_dividend: null }, 1);
  assert.equal(result.percentile, null);
  assert.equal(result.quantile_60_price, null);
  assert.equal(derive({ ...stock, history_version: 2 }, 1).percentile, null);
});

test("zero history is not a 100% percentile, and a zero quantile has no target price", () => {
  const stock = validate({ code: "510880", name: "ETF", market: "A", sector: "ETF", instrument_type: "etf", exchange: "sh", price: 2, rolling_dividend: 0 });
  Object.assign(stock, { history_version: 3, history_status: "ready", history: bars().map(row => ({ ...row, yield: 0, rolling_yield: 0 })) });
  assert.equal(derive(stock, 1).percentile, null);
  stock.history[89].rolling_yield = 0.01;
  assert.equal(derive(stock, 1).quantile_60_yield, 0);
  assert.equal(derive(stock, 1).quantile_60_price, null);
  const result = buildEtfHistory(page(event("2010-01-01", 1)), null, bars(), "2026-03-31");
  assert.equal(result.history_status, "not_applicable");
});

test("all seven public ETF samples produce ready or explicit not-applicable histories; initial conversions precede cash", () => {
  const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8"));
  for (const [code, sample] of Object.entries(samples) as [string, { html: string; sina: string }][]) {
    const data = parseEtfPage(sample.html, code), sina = parseSinaActions(sample.sina, `${code.startsWith("5") ? "sh" : "sz"}${code}`);
    const result = buildEtfHistory(data, sina, bars("2026-08-01", 93), "2026-11-01");
    assert.equal(result.history_status, ["512890", "159915"].includes(code) ? "not_applicable" : "ready", code);
    if (result.history_status === "ready") assert.ok(result.history.every(row => row.yield < 1));
  }
  assert.throws(() => tradingSplits(page(event("2026-01-01", 1)), [{ date: "2026-02-01", ratio: 2 }], "2026-01-01", "2026-03-31"), /不一致/);
});
