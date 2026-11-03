import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseDividends } from "../dividends.ts";

const today = "2026-10-27", a = { code: "601088", market: "A" as const }, hk = { code: "01088", market: "HK" as const };
function aRow(period: string, bonus: number | null, extra: Record<string, unknown> = {}) {
  return { SECURITY_CODE: a.code, REPORT_DATE: `${period} 00:00:00`, ASSIGN_PROGRESS: "实施分配", PRETAX_BONUS_RMB: bonus, EX_DIVIDEND_DATE: "2026-07-13 00:00:00", ...extra };
}
function hkRow(year: number, type: string, plan: string, extra: Record<string, unknown> = {}) {
  return { SECURITY_CODE: hk.code, YEAR: String(year), REPORT_TYPE: type, PLAN_EXPLAIN: plan, EX_DIVIDEND_DATE: "2026/07/02", ...extra };
}
const rowsA = [aRow("2026-06-30", 9.8), aRow("2025-12-31", 10.3), aRow("2025-06-30", 9.8)];
const snapshot = () => parseDividends(rowsA, a, { today });

test("A-share cash is divided by ten exactly once and annual/rolling windows use report periods", () => {
  const result = snapshot();
  assert.equal(result.annual_dividend, 2.01); assert.equal(result.rolling_dividend, 2.01); assert.equal(result.annual_year, 2025);
  assert.deepEqual(result.dividends.map(row => row.dps), [0.98, 1.03]);
  const differentRolling = parseDividends([aRow("2026-06-30", 12), ...rowsA.slice(1)], a, { today });
  assert.equal(differentRolling.annual_dividend, 2.01); assert.equal(differentRolling.rolling_dividend, 2.23);
  assert.throws(() => parseDividends([rowsA[0]], a, { today }), /完整年度/);
  assert.throws(() => parseDividends([aRow("2025-12-31", null)], a, { today }), /金额缺失/);
  assert.equal(parseDividends([aRow("2025-12-31", null, { ASSIGN_PROGRESS: "不分配" })], a, { today }).annual_dividend, 0);
});

test("future announcements, stale reports, duplicate plans and wrong-security records cannot silently alter dividends", () => {
  const result = parseDividends([...rowsA, aRow("2026-09-30", 100, { PLAN_NOTICE_DATE: "2026-11-01" }), aRow("2015-12-31", null)], a, { today });
  assert.equal(result.rolling_dividend, 2.01);
  assert.throws(() => parseDividends([aRow("2022-12-31", 10)], a, { today }), /过旧/);
  assert.throws(() => parseDividends([aRow("2025-12-31", 10), aRow("2025-12-31", 20)], a, { today }), /不同分红/);
  assert.throws(() => parseDividends([aRow("2025-12-31", 10, { SECURITY_CODE: "600001" })], a, { today }), /其他证券/);
  const upcoming = parseDividends([aRow("2025-12-31", 10, { EX_DIVIDEND_DATE: "2026-11-01" })], a, { today });
  assert.equal(upcoming.confirmed, false); assert.equal(upcoming.ex_dividend_date, null);
  assert.equal(upcoming.next_ex_dividend_date, "2026-11-01");
});

test("Hong Kong fiscal years and cash currencies stay distinct from payment year and quoted HKD equivalents", () => {
  const result = parseDividends([hkRow(2026, "中期分配", "每股派人民币0.98元(相当于港币1.139元)"), hkRow(2025, "年度分配", "每股派人民币1.03元(相当于港币1.185元)"), hkRow(2025, "中期分配", "每股派人民币0.98元(相当于港币1.096元)")], hk, { today, fxRate: 0.9 });
  assert.equal(result.annual_dividend, 2.01); assert.equal(result.annual_year, 2025);
  const hkd = parseDividends([hkRow(2025, "年度分配", "每股派港币5.3元")], hk, { today, fxRate: 0.9 });
  assert.equal(hkd.annual_dividend, 4.77);
  assert.throws(() => parseDividends([hkRow(2025, "年度分配", "每股派港币5.3元")], hk, { today }), /汇率/);
  assert.throws(() => parseDividends([hkRow(2025, "年度分配", "每股派美元0.1元")], hk, { today, fxRate: 0.9 }), /币种/);
  assert.throws(() => parseDividends([hkRow(2025, "年度分配", "每股派港币1元")], hk, { today, fxRate: 0.9, fiscalEnd: "03-31" }), /财政年结/);
  const quarters = ["一季度分配", "二季度分配", "三季度分配", "四季度分配"].map(type => hkRow(2025, type, "每股派美元0.1元(相当于港币0.78元)"));
  assert.equal(parseDividends(quarters, hk, { today, fxRate: 0.9 }).annual_dividend, 2.808);
});


test("Zhonggu original rows retain fiscal periods, initial/latest notices, registration and ex dates separately", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/603565-dividend-dates.json", import.meta.url), "utf8"));
  const result = parseDividends(fixture.rows, { code: "603565", market: "A" }, { today: "2026-11-03" });
  assert.equal(result.annual_year, 2025);
  assert.equal(result.annual_dividend, 0.67); // 0.43 interim + 0.24 final, paid in two calendar years.
  assert.deepEqual(result.dividends, [
    { period: "2025-06-30", dps: 0.43, status: "实施分配", date: "2025-09-29", record_date: "2025-09-26", notice_date: "2025-09-23", plan_notice_date: "2025-08-30" },
    { period: "2025-12-31", dps: 0.24, status: "实施分配", date: "2026-05-28", record_date: "2026-05-27", notice_date: "2026-05-22", plan_notice_date: "2026-04-23" },
  ]);
  assert.ok(result.dividends.every(part => !("pay_date" in part)), "missing source payment dates must stay missing");
  assert.equal(result.ex_dividend_date, "2026-05-28");
  assert.equal(result.next_ex_dividend_date, null);
  const beforeEx = parseDividends(fixture.rows, { code: "603565", market: "A" }, { today: "2026-05-25" });
  assert.equal(beforeEx.ex_dividend_date, "2025-09-29");
  assert.equal(beforeEx.next_ex_dividend_date, "2026-05-28");
  assert.equal(beforeEx.confirmed, false);
  assert.deepEqual(beforeEx.dividend_calendar_dates, ["2025-05-08", "2025-09-29", "2026-05-28"]);
});

test("HK payment dates use DIVIDEND_DATE and never the ex date or transfer-book closure range", () => {
  const result = parseDividends([hkRow(2025, "年度分配", "每股派人民币1.03元", {
    EX_DIVIDEND_DATE: "2026/07/02", DIVIDEND_DATE: "2026/08/26", TRANSFER_END_DATE: "2026/07/04-2026/07/10", NOTICE_DATE: "2026-03-30",
  })], hk, { today });
  assert.equal(result.dividends[0].date, "2026-07-02");
  assert.equal(result.dividends[0].pay_date, "2026-08-26");
  assert.equal(result.dividends[0].record_date, undefined);
});
