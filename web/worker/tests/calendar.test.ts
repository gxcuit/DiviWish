import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarEvents } from "../../src/features/dividends/calendar.ts";

const etf = { id: 1, instrument_type: "etf" as const, ex_dividend_date: "2026-11-10" };

test("manual ETF ex-dividend dates remain visible without provider history", () => {
  assert.deepEqual(calendarEvents([etf], "2026-11").map(event => event.ex_dividend_date), ["2026-11-10"]);
  assert.equal(calendarEvents([{ ...etf, dividend_calendar_dates: [] }], "2026-11").length, 1);
});

test("ETF calendar merges manual and provider dates once per stock and sorts only the requested month", () => {
  const stock = { ...etf, dividend_calendar_dates: ["2026-12-01", "2026-11-20", "2026-11-10", "2026-11-20", "2026-10-01"] };
  const original = structuredClone(stock);
  const events = calendarEvents([stock, { id: 2, instrument_type: "stock" as const, ex_dividend_date: "2026-11-10" }], "2026-11");
  assert.deepEqual(events.map(event => [event.id, event.ex_dividend_date]), [[1, "2026-11-10"], [2, "2026-11-10"], [1, "2026-11-20"]]);
  assert.deepEqual(stock, original);
  assert.deepEqual(calendarEvents([{ ...etf, ex_dividend_date: null }], "2026-11"), []);
});
