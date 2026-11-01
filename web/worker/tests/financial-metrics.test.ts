import assert from "node:assert/strict";
import { test } from "node:test";
import { yearBaseline, payoutMetrics } from "../financial-metrics.ts";
import { parseDividends, parseHkEarnings } from "../dividends.ts";
import { derive } from "../calculations.ts";
import { sampleStocks } from "./helpers.ts";
import { providers } from "../providers.ts";

test("YTD uses the quote year's previous final trading close, rejects mismatched snapshots and new listings", () => {
  const quote = { price: 43.55, quote_date: "2026-10-30" };
  const data = { adjustment: "qfq" as const, quote, bars: [
    { date: "2025-12-30", close: 40.264 }, { date: "2025-12-31", close: 40.084 }, { date: "2026-01-05", close: 41 },
  ] };
  const baseline = yearBaseline(data, quote);
  assert.equal(baseline.year_start_date, "2025-12-31");
  const stock = { ...sampleStocks()[0], ...baseline, ...quote };
  assert.equal(derive(stock, 1).year_change, 43.55 / 40.084 - 1);
  assert.equal(derive({ ...stock, quote_date: "2027-01-04" }, 1).year_change, null);
  assert.throws(() => yearBaseline({ ...data, quote: { ...quote, quote_date: "2026-10-29" } }, quote), /日期不一致/);
  assert.throws(() => yearBaseline({ ...data, bars: data.bars.slice(2) }, quote), /缺少上年末/);
});

test("annual payout uses full-year earnings, zero/negative EPS is inapplicable and ratios above 100% remain visible", () => {
  const stock = sampleStocks()[0];
  const rows = [
    { SECURITY_CODE: stock.code, REPORT_DATE: "2025-12-31", PRETAX_BONUS_RMB: 10.03, BASIC_EPS: 5.7, ASSIGN_PROGRESS: "实施分配" },
    { SECURITY_CODE: stock.code, REPORT_DATE: "2025-06-30", PRETAX_BONUS_RMB: 10.13, BASIC_EPS: 2.89, ASSIGN_PROGRESS: "实施分配" },
  ];
  const combined = { ...stock, ...parseDividends(rows, stock, { today: "2026-11-01" }) };
  assert.equal(payoutMetrics(combined).payout_ratio, 2.016 / 5.7);
  assert.equal(payoutMetrics({ ...combined, yield_basis: "custom", custom_yield: 0.99 }).payout_ratio, 2.016 / 5.7);
  for (const eps of [0, -1]) {
    assert.equal(payoutMetrics({ ...combined, annual_eps: eps }).payout_ratio, null);
    assert.match(payoutMetrics({ ...combined, annual_eps: eps }).payout_note, /非正/);
  }
  assert.equal(payoutMetrics({ ...combined, annual_eps: 1 }).payout_ratio, 2.016);
  assert.equal(payoutMetrics({ ...combined, annual_eps_year: 2024 }).payout_ratio, null);
});

test("HK payout keeps original dividend and earnings currencies without current FX distortion", () => {
  const stock = sampleStocks()[1];
  const rows = [
    { SECURITY_CODE: stock.code, YEAR: "2025", REPORT_TYPE: "年度分配", PLAN_EXPLAIN: "每股派人民币2.276元(相当于港币2.52元)" },
    { SECURITY_CODE: stock.code, YEAR: "2025", REPORT_TYPE: "中期分配", PLAN_EXPLAIN: "每股派人民币2.508元(相当于港币2.75元)" },
  ];
  const eps = { SECURITY_CODE: stock.code, START_DATE: "2025-01-01", REPORT_DATE: "2025-12-31", DATE_TYPE_CODE: "001", ITEM_NAME: "每股基本盈利", AMOUNT: 6.35, CURRENCY_CODE: "CNY" };
  const combined = { ...stock, ...parseDividends(rows, stock, { today: "2026-11-01", fxRate: 0.9 }), ...parseHkEarnings([eps], stock.code, 2025) };
  assert.equal(payoutMetrics(combined).payout_ratio, 4.784 / 6.35);
  assert.equal(payoutMetrics({ ...combined, annual_eps_currency: "HKD" }).payout_ratio, null);
  assert.throws(() => parseHkEarnings([{ ...eps, START_DATE: "2025-07-01" }], stock.code, 2025));
  assert.throws(() => parseHkEarnings([{ ...eps, SECURITY_CODE: "00941" }], stock.code, 2025));
  const usd = parseDividends([{ ...rows[0], PLAN_EXPLAIN: "每股派美元0.87元(相当于港币6.78元)" }], stock, { today: "2026-11-01", fxRate: 0.9 });
  const zero = parseDividends([{ ...rows[0], PLAN_EXPLAIN: "不派息" }], stock, { today: "2026-11-01" });
  assert.equal(payoutMetrics({ ...combined, ...zero, ...parseHkEarnings([eps], stock.code, 2025) }).payout_ratio, 0);
  assert.equal(usd.payout_dividend, 0.87); assert.equal(usd.payout_currency, "USD");
});

test("quote refresh obtains baselines independently and clears stale values if baseline requests fail", async t => {
  const [stock] = sampleStocks();
  const fields = Array(33).fill(""); fields[3] = "10"; fields[30] = "20260105150000"; fields[32] = "1";
  let fail = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "qt.gtimg.cn") return new Response(`v_sh600001="${fields.join("~")}"`);
    assert.equal(url.searchParams.get("param"), "sh600001,day,2025-12-01,,640,qfq");
    if (fail) return new Response("failed", { status: 501 });
    return Response.json({ data: { sh600001: { qfqday: [["2025-12-31", "8", "8"]], qt: { sh600001: fields } } } });
  });
  const good = await providers.fetchQuotes([stock]);
  assert.equal(good.quotes.get(1)?.year_start_price, 8); assert.deepEqual(good.errors, []);
  fail = true;
  const bad = await providers.fetchQuotes([stock]);
  assert.equal(bad.quotes.get(1)?.price, 10); assert.equal(bad.quotes.get(1)?.year_start_price, null);
  assert.match(bad.errors[0], /年内涨跌/);
});

