import { calculateForecast } from "./forecast.ts";
import { payoutMetrics } from "./financial-metrics.ts";
import type { StockRecord } from "./types.ts";

export const GRID_DEFAULTS = { grid_start: 0.03, grid_end: 0.08, grid_step: 0.005, grid_sell_start: 0.04, grid_sell_end: 0.02 };
export const YIELD_DEFAULTS = { yield_basis: "annual" as const, custom_yield: null };

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function selectedBasis(stock: StockRecord, fxRate: unknown): [number | null, number | null] {
  const price = number(stock.price);
  if (stock.yield_basis === "forecast") {
    const forecast = calculateForecast(stock, fxRate);
    return [forecast.yield, forecast.dividend];
  }
  if (stock.yield_basis === "custom") {
    const rate = number(stock.custom_yield);
    return [rate, price && price > 0 && rate !== null ? price * rate : null];
  }
  const dividend = number(stock.yield_basis === "rolling" ? stock.rolling_dividend : stock.annual_dividend);
  const conversion = stock.market === "HK" ? number(fxRate) : 1;
  const cash = dividend !== null && conversion && conversion > 0 ? dividend / conversion : null;
  return [cash !== null && price && price > 0 ? cash / price : null, cash];
}

// Decimal integer arithmetic preserves Python Decimal's inclusive grid endpoints.
function decimalParts(value: number): [bigint, number] {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  const scale = fraction - Number(exponent);
  const digits = BigInt(mantissa.replace(".", ""));
  return scale >= 0 ? [digits, scale] : [digits * 10n ** BigInt(-scale), 0];
}

export function gridLevels(stock: Partial<StockRecord>, direction: "buy" | "sell" = "buy"): number[] {
  const keys = direction === "sell" ? ["grid_sell_start", "grid_sell_end", "grid_step"] as const : ["grid_start", "grid_end", "grid_step"] as const;
  const values = keys.map(key => number(key in stock ? stock[key] : GRID_DEFAULTS[key]));
  if (values.some(value => value === null || value <= 0 || value > 1)) {
    throw new Error("网格起止股息率和步长须为 (0,100%] 内的有效数字");
  }
  const parts = (values as number[]).map(decimalParts);
  const scale = Math.max(...parts.map(([, decimals]) => decimals));
  const [start, end, step] = parts.map(([digits, decimals]) => digits * 10n ** BigInt(scale - decimals));
  const delta = direction === "sell" ? start - end : end - start;
  if (delta < 0n) throw new Error(direction === "sell" ? "卖出起始股息率不能小于卖出结束股息率" : "买入起始股息率不能大于买入结束股息率");
  const count = delta / step + 1n;
  if (count > 201n) throw new Error("网格最多 201 档，请增大每格步长或缩小范围");
  return Array.from({ length: Number(count) }, (_, index) => {
    const digits = String(start + (direction === "sell" ? -step : step) * BigInt(index)).padStart(scale + 1, "0");
    return Number(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
  });
}

export function yieldGrid(stock: StockRecord, fxRate: unknown, direction: "buy" | "sell" = "buy") {
  const [, dividend] = selectedBasis(stock, fxRate);
  const price = number(stock.price);
  return gridLevels(stock, direction).map(target => {
    const targetPrice = dividend !== null ? dividend / target : null;
    return { yield: target, price: targetPrice, reached: price !== null && targetPrice !== null ? direction === "sell" ? price >= targetPrice : price <= targetPrice : null };
  });
}

export function yieldStatus(gap: number | null) {
  if (gap === null) return "neutral";
  if (gap >= -1e-12) return "green";
  if (gap >= -0.0025 - 1e-12) return "blue";
  if (gap >= -0.003 - 1e-12) return "orange";
  return "neutral";
}

export function derive(stock: StockRecord, fx: unknown, aPrices: Record<string, number> = {}) {
  const price = number(stock.price), annual = number(stock.annual_dividend), rolling = number(stock.rolling_dividend);
  const target = number(stock.target_yield), fxRate = number(fx), isHk = stock.market === "HK";
  const factor = number(stock.connect_factor);
  const denominator = isHk ? price && fxRate ? price * fxRate : null : price;
  const valid = denominator !== null && denominator > 0;
  const annualYield = valid && annual !== null ? annual / denominator : null;
  const rollingYield = valid && rolling !== null ? rolling / denominator : null;
  const [selectedYield, basisDividend] = selectedBasis(stock, fxRate);
  const gap = selectedYield !== null && target !== null ? selectedYield - target : null;
  const startPrice = number(stock.year_start_price);
  const etf = stock.instrument_type === "etf";
  // Each saved basis drives the same series, numerator, percentile and prices.
  // Version 3 only had ETF rolling history; never reinterpret it as annual.
  const supported = stock.yield_basis !== "forecast" && (!etf || stock.history_status === "ready" &&
    (stock.history_version === 4 || stock.history_version === 3 && stock.yield_basis !== "annual"));
  const history = (supported ? stock.history || [] : []).flatMap(row => {
    const close = number(row.close);
    const value = stock.yield_basis === "custom"
      ? basisDividend !== null && close !== null && close > 0 ? basisDividend / close : null
      : number(stock.yield_basis === "rolling" ? row.rolling_yield : row.yield);
    return value !== null && Number.isFinite(value) && value >= 0 ? [{ date: row.date, close: row.close, yield: value,
      ...(etf && stock.yield_basis === "rolling" ? { window_status: row.window_status } : {}) }] : [];
  });
  const values = history.map(row => row.yield).sort((a, b) => a - b);
  const hasPositive = values.some(value => value > 0);
  const validHistory = values.length >= 60 && (!etf || hasPositive);
  const unavailable = !etf ? null : stock.history_status === "not_applicable" ? "查询成功，暂无可用于所选口径的现金派息历史，分位不适用。" : !supported ? "该口径历史尚未就绪，请获取或升级历史数据。"
    : values.length < 60 ? `该口径有效历史样本仅 ${values.length} 日，至少需要60日。`
    : !hasPositive ? "所选口径历史派息率均为零，分位不适用。"
    : selectedYield === null ? "所选口径当前派息率缺失，暂不能计算当前分位。" : null;
  const aPrice = aPrices[stock.a_code ?? ""] || number(stock.a_price);
  const quantile = (probability: number): [number | null, number | null] => {
    const value = validHistory ? values[Math.ceil(probability / 100 * values.length) - 1] : null;
    const quantilePrice = basisDividend !== null && value && value > 0 ? basisDividend / value : null;
    return [value, quantilePrice];
  };
  const [q30, p30] = quantile(30), [q60, p60] = quantile(60), [q90, p90] = quantile(90);
  return {
    ...stock,
    yield_basis: stock.yield_basis ?? "annual", custom_yield: stock.custom_yield ?? null,
    selected_yield: selectedYield, basis_dividend: basisDividend,
    dividend_yield: annualYield, rolling_yield: rollingYield,
    forecast: calculateForecast(stock, fxRate),
    target_price: basisDividend !== null && target && target > 0 ? basisDividend / target : null,
    yield_gap: gap, status: yieldStatus(gap),
    ...stock.instrument_type === "etf" ? { payout_ratio: null, payout_note: "ETF 不适用个股股息支付率" } : payoutMetrics(stock),
    year_change: price && startPrice && startPrice > 0 && (!stock.year_start_year || stock.year_start_year === Number(stock.quote_date?.slice(0, 4))) ? price / startPrice - 1 : null,
    percentile: validHistory && selectedYield !== null ? values.filter(value => value <= selectedYield + 1e-12).length / values.length : null,
    percentile_count: values.length,
    ...(etf || stock.yield_basis === "forecast" ? { percentile_unavailable_reason: stock.yield_basis === "forecast" ? "缺少各历史时点的预测数据，预估口径不计算历史分位及分位对应价格。" : unavailable } : {}),
    percentile_history: history,
    percentile_start: history[0]?.date ?? null,
    percentile_end: history.at(-1)?.date ?? null,
    ah_premium: isHk && aPrice && valid ? aPrice / denominator - 1 : null,
    hk_net_yield: isHk && annualYield !== null ? annualYield * 0.9 : null,
    connect_yield: isHk && annualYield !== null && factor !== null ? annualYield * factor : null,
    quantile_30_yield: q30, quantile_30_price: p30,
    quantile_60_yield: q60, quantile_60_price: p60,
    quantile_90_yield: q90, quantile_90_price: p90,
  };
}
