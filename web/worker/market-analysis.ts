import type { IndexBar, RegressionSnapshot, RelativePoint, RelativeSnapshot } from "./market-types.ts";

export const MARKET_START = "2016-01-01";
const DAY = 86_400_000;

export function normalizedHistory(bars: IndexBar[], end: string): IndexBar[] {
  const values = new Map<string, number>();
  for (const bar of bars) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !Number.isFinite(Date.parse(bar.date)) ||
      new Date(bar.date).toISOString().slice(0, 10) !== bar.date || !Number.isFinite(bar.close) || bar.close <= 0) throw new Error("指数历史值无效");
    if (bar.date > end) continue;
    if (values.has(bar.date) && values.get(bar.date) !== bar.close) throw new Error("同日指数值冲突");
    values.set(bar.date, bar.close);
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
}

export function buildRelativeBands(dividend: IndexBar[], a500: IndexBar[], end: string): RelativeSnapshot {
  const d = new Map(normalizedHistory(dividend, end).map(row => [row.date, row.close]));
  const a = new Map(normalizedHistory(a500, end).map(row => [row.date, row.close]));
  const dates = [...new Set([...d.keys(), ...a.keys()])].sort();
  const base = dates.find(date => d.has(date) && a.has(date));
  if (!base) throw new Error("两指数没有共同有效交易日");
  const series: RelativePoint[] = [], window: number[] = [];
  for (const date of dates) {
    if (!d.has(date) || !a.has(date)) { window.length = 0; continue; }
    const ratio = (d.get(date)! / d.get(base)!) / (a.get(date)! / a.get(base)!);
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("相对收益比值无效");
    window.push(ratio);
    if (window.length > 242) window.shift();
    let middle: number | null = null, lower: number | null = null, upper: number | null = null;
    let percentB: number | null = null, bandwidth: number | null = null;
    if (window.length === 242) {
      middle = window.reduce((sum, x) => sum + x, 0) / 242;
      const sigma = Math.sqrt(window.reduce((sum, x) => sum + (x - middle!) ** 2, 0) / 242);
      lower = middle - 2 * sigma; upper = middle + 2 * sigma;
      const width = upper - lower;
      bandwidth = width / middle;
      // Flat bands have no defined %B; do not replace it with an artificial 0 or 50%.
      percentB = width > 1e-12 * Math.max(1, Math.abs(middle)) ? (ratio - lower) / width : null;
      if (![middle, lower, upper, bandwidth, ...(percentB === null ? [] : [percentB])].every(Number.isFinite)) throw new Error("BOLL计算结果无效");
    }
    series.push({ date, ratio, middle, lower, upper, percent_b: percentB, bandwidth });
  }
  return { window: 242, multiplier: 2, base_date: base, series, latest: series.at(-1)! };
}

export function buildValueRegression(dividend: IndexBar[], end: string): RegressionSnapshot | null {
  const rows = normalizedHistory(dividend, end);
  if (rows.length < 3) return null;
  const epoch = Date.parse(rows[0].date);
  const samples = rows.map(row => ({ ...row, x: (Date.parse(row.date) - epoch) / (365.25 * DAY), y: Math.log(row.close) }));
  const n = samples.length;
  const meanX = samples.reduce((sum, row) => sum + row.x, 0) / n;
  const meanY = samples.reduce((sum, row) => sum + row.y, 0) / n;
  const sxx = samples.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0);
  if (!sxx) return null;
  const slope = samples.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0) / sxx;
  const fittedLog = (x: number) => meanY + slope * (x - meanX);
  const sse = samples.reduce((sum, row) => sum + (row.y - fittedLog(row.x)) ** 2, 0);
  const sst = samples.reduce((sum, row) => sum + (row.y - meanY) ** 2, 0);
  // Residual standard error for a regression with intercept and slope (n - 2 degrees of freedom).
  const sigma = Math.sqrt(sse / (n - 2));
  const series = samples.map(row => ({ date: row.date, close: row.close, fitted: Math.exp(fittedLog(row.x)),
    lower: Math.exp(fittedLog(row.x) - 1.5 * sigma), upper: Math.exp(fittedLog(row.x) + 1.5 * sigma) }));
  const returns = samples.slice(1).map((row, i) => row.y - samples[i].y);
  const meanReturn = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  const volatility = returns.length > 1 ? Math.sqrt(returns.reduce((sum, x) => sum + (x - meanReturn) ** 2, 0) / (returns.length - 1) * 242) : null;
  const annualizedReturn = Math.expm1(slope);
  if (![sigma, annualizedReturn, ...(volatility === null ? [] : [volatility]), ...series.flatMap(row => [row.fitted, row.lower, row.upper])].every(Number.isFinite) || series.some(row => row.lower <= 0)) throw new Error("对数回归计算结果无效");
  return { start_date: rows[0].date, end_date: rows.at(-1)!.date, count: n, band_multiplier: 1.5,
    r_squared: sst > 1e-24 ? Math.max(0, Math.min(1, 1 - sse / sst)) : null,
    annualized_return: annualizedReturn, annualized_volatility: volatility, residual_sigma: sigma, series, latest: series.at(-1)! };
}
