import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRelativeBands, buildValueRegression, MARKET_START } from "../market-analysis.ts";
import { MarketService } from "../market.ts";
import type { IndexBar } from "../market-types.ts";

function bars(count: number, price: (i: number, years: number) => number = i => 100 + i): IndexBar[] {
  const result: IndexBar[] = [];
  for (let day = Date.parse("2020-01-01"); result.length < count; day += 86_400_000) {
    if ([0, 6].includes(new Date(day).getUTCDay())) continue;
    result.push({ date: new Date(day).toISOString().slice(0, 10), close: price(result.length, (day - Date.parse("2020-01-01")) / (365.25 * 86_400_000)) });
  }
  return result;
}
const end = "2026-11-16";
const near = (actual: number, expected: number, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test("242-session ratio BOLL starts on the 242nd paired close with population sigma and fixed normalization", () => {
  const dividend = bars(300), a500 = bars(300, () => 100), result = buildRelativeBands(dividend, a500, end);
  assert.equal(result.base_date, dividend[0].date); near(result.series[0].ratio, 1);
  assert.equal(result.series[240].middle, null);
  const first = result.series[241];
  const ratios = dividend.slice(0, 242).map(row => row.close / 100);
  const mean = ratios.reduce((a, b) => a + b) / 242;
  const sigma = Math.sqrt(ratios.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 242);
  near(first.middle!, mean); near(first.upper!, mean + 2 * sigma); near(first.lower!, mean - 2 * sigma);
  near(first.percent_b!, (first.ratio - first.lower!) / (first.upper! - first.lower!));
  near(first.bandwidth!, 4 * sigma / mean);
  const scaled = buildRelativeBands(dividend.map(row => ({ ...row, close: row.close * 7 })), a500.map(row => ({ ...row, close: row.close * 3 })), end);
  near(scaled.latest.ratio, result.latest.ratio); near(scaled.latest.percent_b!, result.latest.percent_b!);
  const cutoff = dividend[260].date, truncated = buildRelativeBands(dividend, a500, cutoff);
  near(truncated.latest.ratio, result.series[260].ratio); assert.equal(truncated.base_date, result.base_date);
});

test("missing sessions reset the 242-session window instead of compressing it; flat bands have undefined %B", () => {
  const rows = bars(600), missing = rows.filter((_, i) => i !== 300);
  const result = buildRelativeBands(rows, missing, end);
  assert.ok(result.series.find(row => row.date === rows[299].date)!.middle);
  assert.equal(result.series.find(row => row.date === rows[541].date)!.middle, null);
  assert.notEqual(result.series.find(row => row.date === rows[542].date)!.middle, null);
  const flat = buildRelativeBands(rows, rows, end).latest;
  near(flat.ratio, 1); near(flat.middle!, 1); near(flat.upper!, 1); near(flat.lower!, 1);
  near(flat.bandwidth!, 0); assert.equal(flat.percent_b, null);
  const spike = bars(260, i => i === 259 ? 200 : 100);
  assert.ok(buildRelativeBands(spike, bars(260, () => 100), end).latest.percent_b! > 1);
});

test("exact exponential growth gives the known annualized log fit, R squared and zero residual band", () => {
  const rows = bars(800, (_, years) => 1000 * 1.08 ** years), fit = buildValueRegression(rows, end)!;
  near(fit.annualized_return, 0.08); near(fit.r_squared!, 1); near(fit.residual_sigma, 0);
  for (const i of [0, 120, 799]) { near(fit.series[i].fitted, rows[i].close, 1e-8); near(fit.series[i].lower, rows[i].close, 1e-8); }
  assert.equal(fit.start_date, rows[0].date); assert.equal(fit.count, 800);
  const scaled = buildValueRegression(rows.map(row => ({ ...row, close: row.close * 2 })), end)!;
  near(scaled.annualized_return, fit.annualized_return); near(scaled.r_squared!, fit.r_squared!);
  near(scaled.latest.fitted, fit.latest.fitted * 2, 1e-8);
});

test("regression uses calendar time, n-2 residual variance, log-space bands and sample annualized volatility", () => {
  const rows = bars(400, (i, years) => 1000 * Math.exp(0.07 * years + 0.15 * Math.sin(i / 17)));
  const fit = buildValueRegression([...rows].reverse(), end)!;
  const logs = rows.map(row => Math.log(row.close)), y = logs.reduce((a, b) => a + b) / rows.length;
  const residuals = rows.map((_, i) => logs[i] - Math.log(fit.series[i].fitted));
  const sse = residuals.reduce((sum, x) => sum + x * x, 0), sst = logs.reduce((sum, x) => sum + (x - y) ** 2, 0);
  near(fit.residual_sigma, Math.sqrt(sse / (rows.length - 2)));
  near(fit.r_squared!, 1 - sse / sst);
  near(Math.log(fit.latest.upper / fit.latest.fitted), 1.5 * fit.residual_sigma);
  near(Math.log(fit.latest.fitted / fit.latest.lower), 1.5 * fit.residual_sigma);
  const returns = logs.slice(1).map((x, i) => x - logs[i]), mean = returns.reduce((a, b) => a + b) / returns.length;
  near(fit.annualized_volatility!, Math.sqrt(242 * returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1)));
  const flat = buildValueRegression(bars(300, () => 100), end)!;
  assert.equal(flat.r_squared, null); near(flat.annualized_return, 0); near(flat.annualized_volatility!, 0);
  assert.equal(buildValueRegression(rows.slice(0, 2), end), null);
  assert.throws(() => buildValueRegression([{ date: "2020-01-01", close: 0 }], end));
});

test("market snapshot reuses one long official history for spread, relative BOLL and value regression", async () => {
  let calls = 0;
  const service = new MarketService(async (code, start) => { assert.equal(start, MARKET_START); calls++; return bars(500, i => 100 + i * (code === "H00922" ? 2 : 1)); });
  const data = await service.get();
  assert.equal(calls, 2); assert.equal(data.relative.window, 242); assert.equal(data.regression!.count, 500);
  assert.equal(data.relative.latest.date, data.latest.date); assert.equal(data.regression!.latest.date, data.latest.date);
  assert.ok(data.relative.latest.middle); assert.ok(data.regression!.latest.upper >= data.regression!.latest.fitted);
});
