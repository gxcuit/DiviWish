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
  assert.equal(result.history_version, 4);
  assert.equal(result.history.find(row => row.date === "2026-02-27")!.rolling_yield, 0.1);
  assert.equal(result.history.find(row => row.date === "2026-02-28")!.rolling_yield, 0.02);
  assert.equal(result.history.at(-1)!.rolling_yield, 0.02);
  assert.equal(buildEtfHistory(page(event("2023-02-28", 1)), null, bars("2023-12-01", 91), "2024-02-29").history.at(-1)!.rolling_yield, 0);
});

test("ETF split normalization follows corroborated trading effective day without a false yield jump", () => {
  const data = page(event("2026-01-01", 0.2));
  data.splits = [{ date: "2026-02-06", ratio: 2 }];
  const sina = { dividends: new Map([["2026-01-01", 0.2]]), splits: [{ date: "2026-02-09", ratio: 2 }] };
  const prices = bars().map(row => ({ ...row, close: row.date < "2026-02-09" ? 2 : 1 }));
  const result = buildEtfHistory(data, sina, prices, "2026-03-31");
  assert.ok(result.history.every(row => row.rolling_yield === 0.1));
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

test("ETF annual, rolling and custom history, quantiles and prices follow the saved basis", () => {
  const stock = validate({ code: "510880", name: "ETF", market: "A", sector: "ETF", instrument_type: "etf", exchange: "sh", price: 2, rolling_dividend: 0.12, annual_dividend: 0.5 });
  const history = bars().map((row, i) => ({ ...row, yield: i / 2000, rolling_yield: i / 1000 }));
  Object.assign(stock, { history, history_version: 4, history_status: "ready" });
  const annual = derive({ ...stock, yield_basis: "annual" }, 1);
  assert.equal(annual.percentile, 1);
  assert.equal(annual.quantile_30_yield, 0.013);
  assert.equal(annual.quantile_30_price, 0.5 / 0.013);
  assert.equal(annual.quantile_60_yield, 0.0265);
  assert.equal(annual.quantile_60_price, 0.5 / 0.0265);
  assert.equal(annual.percentile_history[1].yield, 0.0005);
  const rolling = derive({ ...stock, yield_basis: "rolling" }, 1);
  assert.equal(rolling.percentile, 61 / 90);
  assert.equal(rolling.quantile_30_yield, 0.026);
  assert.equal(rolling.quantile_30_price, 0.12 / 0.026);
  assert.equal(rolling.quantile_60_yield, 0.053);
  assert.equal(rolling.quantile_90_yield, 0.08);
  assert.equal(rolling.quantile_60_price, 0.12 / 0.053);
  const custom = derive({ ...stock, yield_basis: "custom", custom_dividend: 0.4 }, 1);
  assert.equal(custom.percentile, 1);
  assert.ok(custom.percentile_history.every(row => row.yield === 0.2));
  assert.equal(custom.quantile_30_yield, 0.2);
  assert.equal(custom.quantile_30_price, 2);
  assert.equal(custom.quantile_60_price, 2);
  const missing = derive({ ...stock, rolling_dividend: null }, 1);
  assert.equal(missing.percentile, null);
  assert.equal(missing.quantile_30_price, null);
  assert.equal(derive({ ...stock, history: history.slice(0, 59) }, 1).quantile_30_yield, null);
  assert.equal(missing.quantile_60_price, null);
  assert.equal(derive({ ...stock, history_version: 3, yield_basis: "annual" }, 1).percentile, null);
  assert.equal(derive({ ...stock, history_version: 3 }, 1).percentile, rolling.percentile);
});

test("zero history is not a 100% percentile, and a zero quantile has no target price", () => {
  const stock = validate({ code: "510880", name: "ETF", market: "A", sector: "ETF", instrument_type: "etf", exchange: "sh", price: 2, rolling_dividend: 0 });
  Object.assign(stock, { history_version: 4, history_status: "ready", history: bars().map(row => ({ ...row, yield: 0, rolling_yield: 0 })) });
  assert.equal(derive(stock, 1).percentile, null);
  stock.history[89].rolling_yield = 0.01;
  assert.equal(derive(stock, 1).quantile_30_yield, 0);
  assert.equal(derive(stock, 1).quantile_30_price, null);
  assert.equal(derive(stock, 1).quantile_60_yield, 0);
  assert.equal(derive(stock, 1).quantile_60_price, null);
  const result = buildEtfHistory(page(event("2010-01-01", 1)), null, bars(), "2026-03-31");
  assert.equal(result.history_status, "not_applicable");
  assert.match(derive({ ...stock, history: [], history_status: "not_applicable" }, 1).percentile_unavailable_reason!, /查询成功/);
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

test("annual ETF cash changes at calendar-year boundaries, excludes future cash and normalizes previous-year splits", () => {
  const data = page(event("2024-01-10", 0.2), event("2025-01-15", 0.3), event("2026-02-01", 9));
  const prices = bars("2024-11-01", 150);
  const result = buildEtfHistory(data, null, prices, "2025-03-30");
  assert.equal(result.history.find(row => row.date === "2024-12-31")!.yield, 0);
  assert.equal(result.history.find(row => row.date === "2025-01-01")!.annual, 0.2);
  assert.equal(result.history.find(row => row.date === "2025-01-15")!.yield, 0.1);
  assert.equal(result.history.find(row => row.date === "2025-01-15")!.rolling_yield, 0.15);
  data.splits = [{ date: "2025-02-07", ratio: 2 }];
  const split = buildEtfHistory(data, { dividends: new Map(), splits: [{ date: "2025-02-10", ratio: 2 }] }, prices, "2025-03-30");
  assert.equal(split.history.find(row => row.date === "2025-02-09")!.annual, 0.2);
  assert.equal(split.history.find(row => row.date === "2025-02-10")!.annual, 0.1);
});

test("public 510880/562060 retain rolling spikes/zero gaps while annual history uses only the previous calendar year", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/etf/annual-window-samples.json", import.meta.url), "utf8"));
  const results = new Map<string, ReturnType<typeof buildEtfHistory>>();
  for (const code of ["510880", "562060"]) {
    const { page, sina } = fixture.samples[code];
    results.set(code, buildEtfHistory(page, { dividends: new Map(sina.dividends), splits: sina.splits }, bars("2021-11-01", 1826), "2026-11-01"));
  }
  const a = results.get("510880")!.history;
  assert.equal(a[0].annual, 0.144, "annual warm-up reaches prior January, beyond the rolling-year warm-up");
  assert.equal(a.find(row => row.date === "2024-01-16")!.rolling_yield, 0);
  assert.equal(a.find(row => row.date === "2024-01-16")!.yield, 0.138 / 2);
  assert.equal(a.find(row => row.date === "2024-01-16")!.window_status, "gap");
  assert.equal(a.find(row => row.date === "2024-01-23")!.window_status, undefined);
  const spike = a.find(row => row.date === "2025-01-21")!;
  assert.equal(spike.window_status, "overlap");
  assert.equal(spike.rolling_yield, (0.131 + 0.142) / 2);
  assert.equal(spike.yield, 0.131 / 2);
  assert.equal(a.find(row => row.date === "2025-01-23")!.window_status, undefined);
  const b = results.get("562060")!.history;
  assert.equal(b.find(row => row.date === "2025-08-08")!.annual, 0.046);
  assert.equal(b.find(row => row.date === "2025-08-11")!.annual, 0.023);
  assert.equal(b.find(row => row.date === "2025-09-30")!.window_status, "overlap");
  assert.equal(b.find(row => row.date === "2026-09-30")!.window_status, "gap");
  assert.equal(b.find(row => row.date === "2026-09-30")!.yield, 0.0242 / 2);
  assert.equal(b.find(row => row.date === "2026-10-21")!.window_status, undefined);
  assert.equal(b.find(row => row.date === "2024-01-01")!.window_status, "before_first");
});

test("monthly and quarterly cash is not an annual overlap; prolonged no-cash is not assumed a short timing gap", async () => {
  const { rollingWindowStatus } = await import("../etf-history.ts");
  const monthly = Array.from({ length: 12 }, (_, i) => event(`2025-${String(i + 1).padStart(2, "0")}-15`, 0.01));
  assert.equal(rollingWindowStatus(monthly, "2025-12-31"), undefined);
  assert.equal(rollingWindowStatus(monthly.filter((_, i) => i % 3 === 0), "2025-12-31"), undefined);
  const annual = [event("2023-01-16", 0.1), event("2024-01-23", 0.1)];
  assert.equal(rollingWindowStatus(annual, "2025-01-23"), "gap");
  assert.equal(rollingWindowStatus(annual, "2025-04-01"), "no_cash");
});

test("annual zero series and outdated rolling-only caches never masquerade as an annual percentile", () => {
  const stock = validate({ code: "159220", name: "ETF", market: "A", sector: "ETF", instrument_type: "etf", exchange: "sz", price: 1, annual_dividend: 0, rolling_dividend: 0.03 });
  Object.assign(stock, { history_version: 4, history_status: "ready", history: bars().map(row => ({ ...row, yield: 0, rolling_yield: 0.03 })) });
  const annual = derive({ ...stock, yield_basis: "annual" }, 1);
  assert.equal(annual.percentile, null);
  assert.match(annual.percentile_unavailable_reason!, /均为零/);
  const rolling = derive({ ...stock, yield_basis: "rolling" }, 1);
  assert.equal(rolling.percentile, 1);
});
