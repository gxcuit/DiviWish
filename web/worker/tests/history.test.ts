import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistory, yearsBefore } from "../history.ts";
import { parseHistoricalDividends } from "../dividends.ts";
import type { DividendEvent } from "../types.ts";

const prices = Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), close: 10 }));
const events: DividendEvent[] = [
  { period: "2024-12-31", available: "2025-03-01", cash: 1 },
  { period: "2025-06-30", available: "2025-08-01", cash: 0.5 },
  { period: "2025-12-31", available: "2026-03-01", cash: 1.5 },
];

test("history uses each day's disclosed full fiscal-year cash and activates notices strictly after disclosure day", () => {
  const result = buildHistory(events, prices, "2026-03-31");
  assert.equal(result.history.length, 90);
  assert.equal(result.history.find(sample => sample.date === "2026-03-01")!.yield, 0.1);
  assert.equal(result.history.find(sample => sample.date === "2026-03-02")!.yield, 0.2);
  assert.equal(result.history[0].annual, 1); assert.equal(result.history.at(-1)!.annual, 2);
  assert.equal(result.history.at(-1)!.year, 2025);
});

test("historical windows, leap years, zero dividends, missing/full-year gaps and invalid/short/stale prices are explicit", () => {
  assert.equal(yearsBefore("2024-02-29", 5), "2019-02-28");
  const noCash = buildHistory([{ period: "2024-12-31", available: "2025-01-01", cash: 0 }], prices, "2026-03-31");
  assert.ok(noCash.history.every(sample => sample.yield === 0));
  assert.throws(() => buildHistory(events, prices.slice(0, 59), "2026-03-31"), /至少需要 60/);
  assert.throws(() => buildHistory(events, prices, "2026-05-01"), /过旧/);
  assert.throws(() => buildHistory([], prices, "2026-03-31"), /仅 0/);
  assert.throws(() => buildHistory([events[1]], prices, "2026-03-31"), /仅 0/);
  assert.throws(() => buildHistory(events, [...prices, { date: prices[0].date, close: 20 }], "2026-03-31"), /不同历史收盘价/);
  assert.throws(() => buildHistory(events, [{ date: "2026-02-30", close: 10 }], "2026-03-31"), /无效/);
  assert.throws(() => buildHistory(events, [{ date: "2026-02-01", close: 0 }], "2026-03-31"), /无效/);
});

test("history normalizes raw cash once, validates security/disclosure/currency, skips forecasts and never substitutes today's FX", () => {
  const row = { SECURITY_CODE: "600036", REPORT_DATE: "2025-12-31", PLAN_NOTICE_DATE: "2026-03-28", NOTICE_DATE: "2026-07-04",
    EX_DIVIDEND_DATE: "2026-07-10", PRETAX_BONUS_RMB: 10.03, IMPL_PLAN_PROFILE: "10派10.03元(含税)", ASSIGN_PROGRESS: "实施分配" };
  const stock = { code: "600036", market: "A" as const };
  assert.deepEqual(parseHistoricalDividends([row], stock, "2026-10-27"), [{ period: "2025-12-31", available: "2026-03-28", cash: 1.003 }]);
  assert.deepEqual(parseHistoricalDividends([{ ...row, ASSIGN_PROGRESS: "预披露" }], stock, "2026-10-27"), []);
  assert.throws(() => parseHistoricalDividends([{ ...row, SECURITY_CODE: "601318" }], stock, "2026-10-27"), /其他证券/);
  assert.throws(() => parseHistoricalDividends([{ ...row, PLAN_NOTICE_DATE: null, NOTICE_DATE: null, EX_DIVIDEND_DATE: null }], stock, "2026-10-27"), /披露日期/);
  const hk = { SECURITY_CODE: "00700", YEAR: "2025", REPORT_TYPE: "年度分配", NOTICE_DATE: "2026-03-01", PLAN_EXPLAIN: "每股派港币3.5元" };
  assert.equal(parseHistoricalDividends([hk], { code: "00700", market: "HK" }, "2026-10-27")[0].cash, 3.5);
  assert.throws(() => parseHistoricalDividends([{ ...hk, PLAN_EXPLAIN: "每股派人民币3.5元" }], { code: "00700", market: "HK" }, "2026-10-27"), /历史汇率/);
});
