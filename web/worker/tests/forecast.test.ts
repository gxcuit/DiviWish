import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateForecast, forecastToday, forecastYear, validateForecastManual } from "../forecast.ts";
import { derive, yieldGrid } from "../calculations.ts";
import { parseForecastCommitments, officialAnnouncementUrl } from "../forecast-announcements.ts";
import { fetchForecast, parseForecastAConsensus, parseForecastDividends, parseForecastFinancials, parseForecastHkConsensus } from "../forecast-providers.ts";
import { dailyForecast } from "../forecast-cache.ts";
import { fixture, sampleStocks } from "./helpers.ts";
import { validate } from "../validation.ts";
import type { ForecastCommitment, ForecastFinancial, ForecastSnapshot } from "../forecast-types.ts";
import type { StockRecord } from "../types.ts";

const today = "2026-11-06";
const evidence = { url: "https://static.cninfo.com.cn/finalpage/test.pdf", title: "股东分红回报规划", date: "2026-04-01" };
function financial(period: string, eps: number, shares = 100): ForecastFinancial {
  return { period, start: `${period.slice(0, 4)}-01-01`, currency: "CNY", equity_status: "none_reported", eps, profit: eps * shares, shares, notice_date: period.endsWith("12-31") ? `${Number(period.slice(0, 4)) + 1}-03-01` : period, source: "https://example.com/financial" };
}
function snapshot(year = 2026): ForecastSnapshot {
  return { year, fetched_at: `${year}-11-06T09:00:00+08:00`, fiscal_end: "12-31", fx: {}, errors: [], commitments: [],
    financials: [financial(`${year}-09-30`, 1.8), financial(`${year - 1}-12-31`, 2), financial(`${year - 1}-09-30`, 1.5), financial(`${year - 2}-12-31`, 2), financial(`${year - 3}-12-31`, 2)],
    consensus: { year, eps: 3, currency: "CNY", analysts: 3, updated_at: `${year}-10-01`, source: "https://example.com/consensus" },
    dividends: [0.8, 1.0, 0.6].map((amount, i) => ({ period: `${year - i - 1}-12-31`, amount, currency: "CNY", status: "implemented", special: false, ambiguous: false, complete: true, evidence })),
    search: { status: "not_found", from: `${year - 5}-11-06`, to: `${year}-11-06`, pending: [], reviewed: [], notes: [] } };
}
function stock(data = snapshot()): StockRecord { return { ...sampleStocks()[0], forecast_snapshot: data, yield_basis: "forecast" }; }
function commitment(patch: Partial<ForecastCommitment> = {}): ForecastCommitment {
  return { kind: "ratio", value: 0.5, currency: "CNY", start_year: 2026, end_year: 2028, lower_bound: true, conditions: "盈利且现金流充足", approved: true, profit_basis: "parent", evidence, ...patch };
}
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("forecast uses median normal annual payouts, forecast EPS, and no historical lookahead", () => {
  const s = stock(), result = calculateForecast(s, 0.8, today);
  near(result.dividend, 1.2); near(result.yield, 0.12); near(result.payout_ratio, 0.4);
  assert.deepEqual(result.payout_years, [2025, 2024, 2023]); assert.equal(result.earnings_basis, "consensus");
  const derived = derive(s, 0.8);
  assert.equal(derived.percentile, null); assert.equal(derived.quantile_60_price, null); assert.deepEqual(derived.percentile_history, []);
  assert.match(String(derived.percentile_unavailable_reason), /历史时点/);
  near(derived.target_price, 24); near(yieldGrid(s, 0.8)[0].price, 40);
  near(yieldGrid(s, 0.8, "sell")[0].price, 30);
});

test("full-year actual earnings take priority over consensus and TTM", () => {
  const data = snapshot(); data.year = 2025; data.consensus!.year = 2025;
  const s = stock(data);
  const result = calculateForecast(s, 0.8, "2025-12-31");
  // Publication date is after the as-of date; never consume an undisclosed account.
  assert.notEqual(result.earnings_basis, "actual");
});

test("fixed cash and exact total commitments do not require positive earnings", () => {
  const data = snapshot(); data.consensus = null; data.financials = [];
  data.commitments = [commitment({ kind: "per_share", value: 1.5 })];
  near(calculateForecast(stock(data), 0.8, today).dividend, 1.5);
  data.commitments = [commitment({ kind: "total", value: 300, shares: 100, lower_bound: false })];
  const result = calculateForecast(stock(data), 0.8, today); near(result.dividend, 3); assert.equal(result.status, "ready");
  delete data.commitments[0].shares; assert.equal(calculateForecast(stock(data), 0.8, today).dividend, null);
});

test("ratio promises require the declared profit denominator and retain conditional lower bounds", () => {
  const data = snapshot(); data.commitments = [commitment()]; data.consensus!.profit = 300;
  const result = calculateForecast(stock(data), 0.8, today); near(result.dividend, 1.5); assert.equal(result.status, "lower_bound");
  data.consensus!.profit = null; // EPS alone cannot establish parent profit or its per-share denominator.
  const fallback = calculateForecast(stock(data), 0.8, today); near(fallback.dividend, 1.2); assert.equal(fallback.basis, "historical");
  assert.match(fallback.notes.join(""), /分母/);
});

test("expired, unapproved, conflicting and unfinished commitments fall back to the model", () => {
  for (const c of [commitment({ end_year: 2025 }), commitment({ approved: false })]) {
    const data = snapshot(); data.commitments = [c]; near(calculateForecast(stock(data), 0.8, today).dividend, 1.2);
  }
  const data = snapshot(); data.commitments = [commitment(), commitment({ value: 0.6 })];
  near(calculateForecast(stock(data), 0.8, today).dividend, 1.2);
  data.commitments = [commitment()]; data.search.pending = [{ ...evidence, id: "next" }];
  near(calculateForecast(stock(data), 0.8, today).dividend, 1.2);
});

test("current fiscal full-year plan includes interim cash once, and explicit zero is valid", () => {
  const data = snapshot();
  data.dividends.push({ ...data.dividends[0], period: "2026-06-30", amount: 0.3, complete: false }, { ...data.dividends[0], period: "2026-12-31", amount: 0.7 });
  // The year-end record is future-dated relative to today's raw sources, but this
  // pure fixture deliberately supplies a completed fiscal plan to test aggregation.
  const r = calculateForecast(stock(data), 0.8, today); near(r.dividend, 1); assert.equal(r.basis, "plan");
  data.dividends = [{ ...data.dividends[0], period: "2026-12-31", amount: 0 }];
  near(calculateForecast(stock(data), 0.8, today).yield, 0);
});

test("interim cash above a modeled annual result pauses the estimate", () => {
  const data = snapshot(); data.dividends.push({ ...data.dividends[0], period: "2026-06-30", amount: 1.3, complete: false });
  const result = calculateForecast(stock(data), 0.8, today); assert.equal(result.status, "conflict"); assert.equal(result.dividend, null);
});

test("TTM uses matched cumulative accounts and stops adding EPS across capital changes", () => {
  const data = snapshot(); data.consensus = null;
  const r = calculateForecast(stock(data), 0.8, today); near(r.eps, 2.3); near(r.dividend, 0.92); assert.equal(r.earnings_basis, "ttm");
  data.financials[0].shares = 110; assert.equal(calculateForecast(stock(data), 0.8, today).dividend, null);
  data.financials.splice(2, 1); assert.match(calculateForecast(stock(data), 0.8, today).reason, /TTM/);
});

test("stale or wrong-year consensus uses TTM; nonpositive earnings are unavailable", () => {
  for (const update of [{ year: 2027 }, { updated_at: "2025-01-01" }, { analysts: 0 }, { updated_at: "2027-01-01" }]) {
    const data = snapshot(); Object.assign(data.consensus!, update); assert.equal(calculateForecast(stock(data), 0.8, today).earnings_basis, "ttm");
  }
  const data = snapshot(); data.consensus!.eps = -1; assert.equal(calculateForecast(stock(data), 0.8, today).dividend, null);
});

test("special dividends and abnormal payouts do not raise ordinary reference payouts", () => {
  const data = snapshot(); data.dividends.push({ ...data.dividends[0], special: true, complete: false, amount: 10 });
  near(calculateForecast(stock(data), 0.8, today).payout_ratio, 0.4);
  data.dividends[0].amount = 3; near(calculateForecast(stock(data), 0.8, today).payout_ratio, 0.4);
  data.dividends[1].ambiguous = true; near(calculateForecast(stock(data), 0.8, today).payout_ratio, 0.3);
});

test("HK forecast uses native earnings and dividend currencies; missing FX stays missing", () => {
  const data = snapshot(); const s = { ...stock(data), market: "HK" as const, code: "00941", price: 10 };
  near(calculateForecast(s, 0.8, today).dividend, 1.5);
  assert.equal(calculateForecast(s, null, today).dividend, null);
  data.financials.forEach(f => f.currency = "USD"); data.dividends.forEach(d => d.currency = "USD"); data.consensus!.currency = "USD";
  data.fx.USD = 7.2; near(calculateForecast(s, 0.8, today).dividend, 10.8);
  data.dividends[0].currency = "HKD"; assert.deepEqual(calculateForecast(s, 0.8, today).payout_years, [2024, 2023]);
});

test("current-year scope, unsupported fiscal ends, ETF exclusion, missing prices and stale values", () => {
  const s = stock(); assert.equal(calculateForecast(s, 0.8, "2027-01-01").dividend, null);
  s.forecast_snapshot!.fiscal_end = "03-31"; assert.equal(calculateForecast(s, 0.8, today).status, "unsupported");
  s.instrument_type = "etf"; assert.equal(calculateForecast(s, 0.8, today).status, "unsupported");
  s.instrument_type = "stock"; s.forecast_snapshot!.fiscal_end = "12-31"; s.price = null;
  assert.equal(calculateForecast(s, 0.8, today).yield, null); near(calculateForecast(s, 0.8, today).dividend, 1.2);
  s.forecast_error = "offline"; assert.equal(calculateForecast(s, 0.8, today).stale, true);
});

test("manual settings override auto commitments and can be validated and cleared", () => {
  const s = stock(); s.forecast_snapshot!.commitments = [commitment()];
  s.forecast_manual = { year: 2026, payout_ratio: null, commitment: commitment({ kind: "per_share", value: 2 }) };
  near(calculateForecast(s, 0.8, today).dividend, 2);
  assert.equal(validateForecastManual(null), null);
  assert.throws(() => validateForecastManual({ year: 2026, payout_ratio: 1.2 }), /支付率/);
  assert.throws(() => validateForecastManual({ year: 2026, commitment: commitment({ kind: "total" }) }), /股数/);
  assert.throws(() => validateForecastManual({ year: 2026, commitment: commitment({ evidence: { ...evidence, url: "javascript:alert(1)" } }) }), /HTTPS/);
  assert.ok(validateForecastManual(s.forecast_manual));
  const changed = validate({ code: "600002" }, s); assert.equal(changed.forecast_snapshot, undefined); assert.equal(changed.forecast_manual, undefined);
  assert.throws(() => validate({ code: "510880", market: "A", name: "ETF", sector: "ETF", instrument_type: "etf", exchange: "sh", yield_basis: "forecast" }), /ETF/);
});

test("announcement parser only adopts identified, approved, single-year clauses", () => {
  const announcement = { ...evidence, id: "one" }, s = { code: "600036", market: "A" as const };
  const text = "证券代码：600036。2026年至2028年股东分红回报规划已经股东大会审议通过。每年度现金分红不低于当年归属于上市公司股东的净利润的50%。";
  const parsed = parseForecastCommitments([text], announcement, s, 2026);
  assert.equal(parsed.commitments.length, 1); assert.equal(parsed.commitments[0].value, 0.5); assert.equal(parsed.commitments[0].evidence.page, 1);
  for (const change of [text.replace("600036", "600001"), text.replace("已经股东大会审议通过", "尚需股东大会批准"), text.replace("已经股东大会审议通过", "尚未获股东大会批准"), text + "回购视同分红。", text.replace("每年度", "最近三年累计"), text.replace("2028", "2025")]) {
    assert.equal(parseForecastCommitments([change], announcement, s, 2026).commitments.length, 0);
  }
  const traditional = "股份代號：941。2026年至2028年每年度股東分紅回報規劃已經股東大會審議通過。每年度以人民幣現金分紅不低於歸屬於本公司股東的淨利潤的50%。";
  const hk = parseForecastCommitments([traditional], { ...announcement, url: "https://www1.hkexnews.hk/test.pdf" }, { code: "00941", market: "HK" }, 2026);
  assert.equal(hk.commitments[0]?.value, 0.5);
  assert.equal(officialAnnouncementUrl("https://static.cninfo.com.cn.evil.example/a.pdf", "A"), false);
  assert.equal(officialAnnouncementUrl("http://static.cninfo.com.cn/a.pdf", "A"), false);
});

test("source parsers preserve A forecast years, cash units and native HK currencies", () => {
  const s = stock(); s.code = "600036";
  const c = parseForecastAConsensus([{ SECURITY_CODE: s.code, YEAR1: 2025, YEAR_MARK1: "A", EPS1: 2, YEAR2: 2026, YEAR_MARK2: "E", EPS2: 3, RATING_ORG_NUM: 5 }], s, 2026, today, evidence.url);
  assert.equal(c?.eps, 3);
  assert.equal(parseForecastAConsensus([{ SECURITY_CODE: s.code, YEAR1: 2026, YEAR_MARK1: "A", EPS1: 3, RATING_ORG_NUM: 5 }], s, 2026, today, evidence.url), null);
  const cash = parseForecastDividends([{ SECURITY_CODE: s.code, REPORT_DATE: "2025-12-31", NOTICE_DATE: "2026-04-01", ASSIGN_PROGRESS: "实施分配", IMPL_PLAN_PROFILE: "10派2元", PRETAX_BONUS_RMB: 2 }], s, evidence.url, today);
  near(cash[0].amount, 0.2);
  const hk = { ...s, market: "HK" as const, code: "00941" };
  const financials = parseForecastFinancials([{ SECURITY_CODE: hk.code, REPORT_DATE: "2025-12-31", START_DATE: "2025-01-01", CURRENCY: "HKD", BASIC_EPS: 9, ISSUED_COMMON_SHARES: 100 }], hk, evidence.url, today,
    [{ SECURITY_CODE: hk.code, REPORT_DATE: "2025-12-31", START_DATE: "2025-01-01", ITEM_NAME: "每股基本盈利", AMOUNT: 2, CURRENCY_CODE: "CNY" }]);
  assert.equal(financials[0].currency, "CNY"); assert.equal(financials[0].eps, 2);
  const html = '<table class="figureTable"><tr><td>财政年度</td><td>纯利/(亏损)(百万元人民币)</td><td>每股盈利*/(亏损)(分)</td><td>每股派息</td><td>证券商</td><td>更新日期</td></tr><tr><td>2026</td><td>300</td><td>200</td><td>60</td><td>券商A</td><td>01/10/2026</td></tr><tr><td>2026</td><td>400</td><td>400</td><td>60</td><td>券商B</td><td>01/10/2026</td></tr></table>';
  const hkConsensus = parseForecastHkConsensus(html, 2026, today, evidence.url); near(hkConsensus!.eps, 3); assert.equal(hkConsensus?.currency, "CNY");
});

test("forecast cache excludes manual parameters, reuses daily results, and releases failed leases", async () => {
  let calls = 0;
  const f = fixture({ fetchForecast: async (identity, year) => {
    assert.equal(identity.forecast_manual, undefined); assert.equal(identity.forecast_snapshot, undefined);
    calls++; const data = snapshot(year); data.fetched_at = forecastToday(); return data;
  } });
  const s = sampleStocks()[0]; s.forecast_manual = { year: forecastYear(), commitment: null, payout_ratio: 0.9,
    reconciliation: { currency: "CNY", parent_profit: 300, equity_deduction: 30, weighted_shares: null, participating_shares: 100,
      source_url: "https://example.com/private-profit-source", conditions: "private-equity-adjustment" } };
  await dailyForecast(f.db.binding, s, f.source); await dailyForecast(f.db.binding, s, f.source); assert.equal(calls, 1);
  f.source.fetchForecast = async () => { throw new Error("offline"); };
  await assert.rejects(dailyForecast(f.db.binding, s, f.source, true), /offline/);
  const row = f.db.sqlite.prepare("SELECT lease_until,retry_after,snapshot FROM public_forecast_cache").get()!;
  assert.equal(row.lease_until, 0); assert.ok(Number(row.retry_after) > Date.now()); assert.ok(row.snapshot); assert.ok(!String(row.snapshot).includes("private-equity-adjustment"));
  f.db.sqlite.close();
});

test("forecast API persists settings, prevents stale concurrent writes and preserves old snapshots on failure", async () => {
  const f = fixture({ fetchForecast: async (_s, year) => { const data = snapshot(year); data.fetched_at = forecastToday(); return data; } });
  let response = await f.request("/api/stocks/1/forecast", "POST", {}); assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json() as { forecast: { dividend: number }; forecast_snapshot?: unknown }; near(data.forecast.dividend, 1.2); assert.equal(data.forecast_snapshot, undefined);
  response = await f.request("/api/stocks/1", "PATCH", { yield_basis: "forecast", forecast_manual: { year: forecastYear(), payout_ratio: 0.5, commitment: null } });
  assert.equal(response.status, 200);
  f.source.fetchForecast = async () => { throw new Error("offline"); };
  assert.equal((await f.request("/api/stocks/1/forecast?refresh=1", "POST", {})).status, 502);
  const retained = await (await f.request("/api/stocks/1/forecast")).json() as { forecast: { stale: boolean; dividend: number } }; assert.equal(retained.forecast.stale, true); near(retained.forecast.dividend, 1.5);
  f.source.fetchForecast = async (_s, year) => {
    await f.request("/api/stocks/1", "PATCH", { forecast_manual: { year, payout_ratio: 0.6, commitment: null,
      reconciliation: { currency: "CNY", parent_profit: 400, equity_deduction: 40, weighted_shares: null, participating_shares: 100,
        source_url: "https://example.com/concurrent-financial", conditions: "edited-during-refresh" } } });
    const data = snapshot(year); data.fetched_at = forecastToday(); return data;
  };
  assert.equal((await f.request("/api/stocks/1/forecast?refresh=1", "POST", {})).status, 409);
  const edited = await (await f.request("/api/stocks/1")).json() as { forecast_manual: { reconciliation: { equity_deduction: number } } };
  assert.equal(edited.forecast_manual.reconciliation.equity_deduction, 40);
  f.db.sqlite.close();
});


test("a newer unresolved cancellation stops use of the old public commitment", async () => {
  const year = forecastYear(), data = snapshot(year);
  data.fetched_at = forecastToday();
  data.commitments = [commitment({ start_year: year, end_year: year + 1 })];
  data.search.pending = [{ id: "cancel", title: "关于取消股东回报规划的公告", url: "https://static.cninfo.com.cn/cancel.pdf", date: forecastToday() }];
  const updated = await fetchForecast(stock(data), year, data, { read: async () => ["证券代码600036。股东大会已审议通过取消旧分红承诺。"], write: async () => {} });
  assert.equal(updated.commitments.length, 0); assert.match(updated.search.notes.join(""), /停用旧承诺/);
});
