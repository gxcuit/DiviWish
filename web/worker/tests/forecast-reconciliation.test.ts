import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateForecast, validateForecastManual } from "../forecast.ts";
import { attachForecastBalance, parseForecastFinancials, parseForecastAConsensus, parseForecastDividends } from "../forecast-providers.ts";
import { validate } from "../validation.ts";
import type { ForecastDividend, ForecastManual, ForecastSnapshot } from "../forecast-types.ts";
const today = "2026-11-06";
const evidence = { url: "https://static.cninfo.com.cn/sample.pdf", title: "公开分红记录", date: "2026-08-01" };
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function sample() {
  const s = validate({ market: "A", code: "601665", name: "测试", sector: "样本", price: 10, yield_basis: "forecast" });
  s.forecast_snapshot = { year: 2026, fetched_at: today, fiscal_end: "12-31", fx: {}, errors: [], commitments: [],
    financials: [2026, 2025, 2024, 2023].map(year => ({ period: `${year}-${year === 2026 ? "09-30" : "12-31"}`, start: `${year}-01-01`,
      currency: "CNY", eps: 2, profit: 220, shares: 100, equity_status: "present", equity_balance: 700, notice_date: `${year === 2026 ? year : year + 1}-04-01`, source: evidence.url })),
    consensus: { year: 2026, eps: 3, currency: "CNY", updated_at: "2026-10-01", analysts: 3, source: evidence.url },
    dividends: [2025, 2024, 2023].map(year => ({ period: `${year}-12-31`, amount: .8, status: "implemented", participating_shares: 100, currency: "CNY", special: false, ambiguous: false, complete: true, evidence })),
    search: { status: "not_found", from: "2021-11-06", to: today, pending: [], reviewed: [], notes: [] } };
  return s;
}
function manual(patch: Partial<NonNullable<ForecastManual["reconciliation"]>> = {}): ForecastManual {
  return { year: 2026, commitment: null, payout_ratio: .4, reconciliation: { currency: "CNY", parent_profit: 330, equity_deduction: 30,
    weighted_shares: null, participating_shares: 100, source_url: evidence.url, conditions: "全年利润与权益扣减假设", ...patch } };
}
function event(patch: Partial<ForecastDividend> = {}): ForecastDividend {
  return { period: "2026-06-30", amount: .3, status: "implemented", currency: "CNY", special: false, ambiguous: false, complete: false, evidence, ...patch };
}

test("equity exposure requires reconciliation for banks and all other industries", () => {
  for (const code of ["601665", "600036", "601899", "601857"]) {
    const s = sample(); s.code = code;
    const r = calculateForecast(s, 1, today);
    assert.equal(r.dividend, null); assert.match(r.reason, /权益工具/);
    assert.equal(r.reconciliation.equity_deduction, null); assert.equal(r.reconciliation.ordinary_profit, null);
  }
});

test("parent profit minus annual equity adjustment uses entitled shares, not weighted shares", () => {
  const s = sample(); s.forecast_manual = manual({ weighted_shares: 120, participating_shares: 110 });
  const r = calculateForecast(s, 1, today);
  near(r.reconciliation.ordinary_profit, 300); near(r.dividend, 300 / 110 * .4);
  assert.equal(r.basis, "manual"); assert.equal(r.reconciliation.status, "matched");
  s.forecast_manual = manual({ parent_profit: 20, equity_deduction: 30 });
  assert.equal(calculateForecast(s, 1, today).dividend, null);
});

test("basic EPS reconstruction requires its own weighted denominator and does not deduct coupons twice", () => {
  const s = sample(); s.forecast_manual = manual({ parent_profit: null, equity_deduction: 30, weighted_shares: 100, participating_shares: 120 });
  const r = calculateForecast(s, 1, today);
  near(r.reconciliation.ordinary_profit, 300); near(r.dividend, 1);
  assert.equal(r.reconciliation.parent_profit, null); // Never EPS × ending shares to infer parent profit.
  s.forecast_manual.reconciliation!.weighted_shares = null;
  assert.equal(calculateForecast(s, 1, today).dividend, null);
  s.forecast_manual = manual({ currency: "HKD" });
  assert.match(calculateForecast(s, 1, today).reason, /币种/);
});

test("TTM equity deductions use cumulative reconciliation rather than a prior-year coupon proxy", () => {
  const s = sample(), snapshot = s.forecast_snapshot!; snapshot.consensus = null;
  const base = snapshot.financials[0];
  snapshot.financials = [
    { ...base, period: "2026-09-30", profit: 200, equity_deduction: 20 },
    { ...base, period: "2025-12-31", start: "2025-01-01", profit: 240, equity_deduction: 24 },
    { ...base, period: "2025-09-30", start: "2025-01-01", profit: 180, equity_deduction: 15 },
  ];
  s.forecast_manual = { year: 2026, commitment: null, payout_ratio: .4 };
  const r = calculateForecast(s, 1, today);
  near(r.reconciliation.parent_profit, 260); near(r.reconciliation.equity_deduction, 29);
  near(r.reconciliation.ordinary_profit, 231); near(r.dividend, .924);
  delete snapshot.financials[2].equity_deduction;
  assert.equal(calculateForecast(s, 1, today).dividend, null);
});

test("historical total payout uses ordinary earnings with each distribution's entitled shares", () => {
  const s = sample(); s.forecast_manual = { ...manual(), payout_ratio: null };
  s.forecast_snapshot!.financials.forEach(f => { f.ordinary_profit = 160; f.shares = 110; });
  // Different denominators are supported through total ordinary cash / ordinary profit.
  const r = calculateForecast(s, 1, today); near(r.payout_ratio, .5); near(r.dividend, 1.5);
});

test("distribution progress survives missing earnings, with conditional guidance and special cash separate", () => {
  const s = sample(); s.forecast_snapshot!.dividends.push(event(), event({ period: "2026-03-31", amount: .2, status: "approved" }),
    event({ period: "2026-09-30", amount: .1, status: "proposed" }), event({ amount: .5, status: "conditional", lower_bound: true }), event({ amount: 2, special: true }));
  let r = calculateForecast(s, 1, today);
  assert.equal(r.dividend, null); near(r.distribution.implemented, .3); near(r.distribution.approved, .2);
  near(r.distribution.proposed, .1); near(r.distribution.conditional, .5); near(r.distribution.special, 2);
  assert.equal(r.distribution.remaining, null);
  s.forecast_manual = manual(); r = calculateForecast(s, 1, today);
  near(r.dividend, 1.2); near(r.distribution.announced, .6); near(r.distribution.remaining, .6);
  s.forecast_manual.payout_ratio = .1; r = calculateForecast(s, 1, today);
  assert.equal(r.status, "conflict"); assert.equal(r.dividend, null); near(r.distribution.implemented, .3); assert.equal(r.distribution.remaining, null);
});

test("cancellations, different share bases and missing cash are never silently netted", () => {
  const s = sample(); s.forecast_manual = manual(); const data = s.forecast_snapshot!;
  data.dividends.push(event({ status: "cancelled", amount: 20 })); near(calculateForecast(s, 1, today).distribution.remaining, 1.2);
  data.dividends.push(event({ participating_shares: 110 }));
  assert.equal(calculateForecast(s, 1, today).distribution.announced, null);
  data.dividends = [event({ status: "conditional", amount: null, ambiguous: true })];
  const r = calculateForecast(s, 1, today); near(r.dividend, 1.2); near(r.distribution.remaining, 1.2); assert.equal(r.distribution.conditional, null);
  const nextYear = calculateForecast(s, 1, "2027-01-01"); assert.equal(nextYear.dividend, null); assert.equal(nextYear.distribution.implemented, null);
});

test("lower bound remainder is conditional and explicit zero stays zero", () => {
  const s = sample(); s.forecast_manual = { year: 2026, payout_ratio: null, commitment: { kind: "per_share", value: 1, currency: "CNY", lower_bound: true,
    approved: true, start_year: 2026, end_year: 2026, conditions: "盈利", evidence } };
  s.forecast_snapshot!.dividends.push(event());
  const r = calculateForecast(s, 1, today); near(r.distribution.remaining, .7); assert.equal(r.distribution.remaining_kind, "lower_bound");
  s.forecast_manual.commitment!.value = 0; s.forecast_snapshot!.dividends = [];
  near(calculateForecast(s, 1, today).dividend, 0); near(calculateForecast(s, 1, today).distribution.remaining, 0);
});

test("source parser retains guidance, lifecycle dates, cancellations and unknown amounts", () => {
  const s = sample();
  const rows = [
    { REPORT_DATE: "2026-06-30", IMPL_PLAN_PROFILE: "每10股派发现金红利应不少于3.8元(含税)", ASSIGN_PROGRESS: "预披露" },
    { REPORT_DATE: "2026-03-31", IMPL_PLAN_PROFILE: "10派4.2元", ASSIGN_PROGRESS: "实施分配", EX_DIVIDEND_DATE: "2026-08-21" },
    { REPORT_DATE: "2026-09-30", IMPL_PLAN_PROFILE: "现金分红金额占普通股股东净利润的35%", ASSIGN_PROGRESS: "预披露" },
    { REPORT_DATE: "2026-12-31", IMPL_PLAN_PROFILE: "原分红预案取消", ASSIGN_PROGRESS: "取消" },
  ].map(r => ({ ...r, SECURITY_CODE: s.code, NOTICE_DATE: "2026-08-01" }));
  const events = parseForecastDividends(rows, s, evidence.url, today);
  near(events.find(e => e.period.endsWith("06-30"))!.amount, .38); assert.equal(events.find(e => e.period.endsWith("06-30"))!.status, "conditional");
  assert.equal(events.find(e => e.period.endsWith("09-30"))!.amount, null);
  assert.equal(events.find(e => e.period.endsWith("12-31"))!.status, "cancelled");
  const scheduled = parseForecastDividends([rows[1]], s, evidence.url, "2026-08-01");
  assert.equal(scheduled[0].status, "approved"); // Implementation notice precedes actual ex-date.
  assert.throws(() => attachForecastBalance([], [{ SECURITY_CODE: "999999" }], s, evidence.url, today), /身份/);
  const hk = parseForecastDividends([{ SECURITY_CODE: "00941", YEAR: "2026", REPORT_TYPE: "中期分配", NOTICE_DATE: "2026-08-13", PLAN_EXPLAIN: "每股派人民币2.51元(相当于港币2.9003元)", EX_DIVIDEND_DATE: "2026/08/25", DIVIDEND_DATE: "2026/09/30" }], { ...s, code: "00941", market: "HK" }, evidence.url, today);
  assert.equal(hk[0].status, "implemented"); near(hk[0].amount, 2.51); assert.equal(hk[0].pay_date, "2026-09-30");
});

test("reconciliation validation rejects incomplete, unsafe and negative inputs", () => {
  assert.ok(validateForecastManual(manual()));
  for (const patch of [{ participating_shares: 0 }, { equity_deduction: -1 }, { parent_profit: null, weighted_shares: null }, { source_url: "javascript:alert(1)" }]) {
    assert.throws(() => validateForecastManual(manual(patch)));
  }
});

test("live public bank, Zijin and PetroChina samples use the same rules", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/forecast-public-2026-11-06.json", import.meta.url), "utf8"));
  for (const entry of fixture.samples) {
    const s = validate({ market: "A", code: entry.code, name: entry.name, sector: "公开样本", price: 10 });
    const snapshot: ForecastSnapshot = { year: fixture.year, fetched_at: fixture.today, fiscal_end: "12-31", fx: {}, errors: [], commitments: [],
      financials: attachForecastBalance(parseForecastFinancials(entry.financial.rows, s, entry.financial.url, fixture.today), entry.balance.rows, s, entry.balance.url, fixture.today),
      consensus: parseForecastAConsensus(entry.consensus.rows, s, fixture.year, fixture.today, entry.consensus.url),
      dividends: parseForecastDividends(entry.dividends.rows, s, entry.dividends.url, fixture.today),
      search: { status: "not_found", from: fixture.today, to: fixture.today, pending: [], reviewed: [], notes: [] } };
    s.forecast_snapshot = snapshot;
    const r = calculateForecast(s, 1, fixture.today);
    if (entry.code === "601857") { assert.equal(r.status, "ready"); near(r.distribution.implemented, .26); assert.ok(r.distribution.remaining! > 0); }
    else { assert.equal(r.reconciliation.status, "review"); assert.equal(r.dividend, null); }
    if (entry.code === "601899") { near(r.distribution.implemented, .42); near(r.distribution.conditional, .38); }
    if (entry.code === "600036") { assert.equal(r.distribution.conditional, null); assert.equal(r.distribution.events[0].status, "conditional"); }
  }
});
