import type { StockRecord } from "./types.ts";

export const GRID_DEFAULTS = { grid_start: 0.03, grid_end: 0.08, grid_step: 0.005 };
export const YIELD_DEFAULTS = { yield_basis: "annual" as const, custom_yield: null };

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function selectedBasis(stock: StockRecord, fxRate: unknown): [number | null, number | null] {
  const price = number(stock.price);
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

export function gridLevels(stock: Partial<StockRecord>): number[] {
  const values = Object.entries(GRID_DEFAULTS).map(([key, fallback]) =>
    number(key in stock ? stock[key] : fallback));
  if (values.some(value => value === null || value <= 0 || value > 1)) {
    throw new Error("网格起止股息率和步长须为 (0,100%] 内的有效数字");
  }
  const parts = (values as number[]).map(decimalParts);
  const scale = Math.max(...parts.map(([, decimals]) => decimals));
  const [start, end, step] = parts.map(([digits, decimals]) => digits * 10n ** BigInt(scale - decimals));
  if (start > end) throw new Error("网格起始股息率不能大于结束股息率");
  const count = (end - start) / step + 1n;
  if (count > 201n) throw new Error("网格最多 201 档，请增大每格步长或缩小范围");
  return Array.from({ length: Number(count) }, (_, index) => {
    const digits = String(start + step * BigInt(index)).padStart(scale + 1, "0");
    return Number(scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
  });
}

export function yieldGrid(stock: StockRecord, fxRate: unknown) {
  const [, dividend] = selectedBasis(stock, fxRate);
  const price = number(stock.price);
  return gridLevels(stock).map(target => {
    const targetPrice = dividend !== null ? dividend / target : null;
    return { yield: target, price: targetPrice, reached: price !== null && targetPrice !== null ? price <= targetPrice : null };
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
  const values = (stock.history || []).map(row => number(row.yield))
    .filter((value): value is number => value !== null && value >= 0).sort((a, b) => a - b);
  const validHistory = values.length >= 60;
  const aPrice = aPrices[stock.a_code ?? ""] || number(stock.a_price);
  const quantile = (probability: number): [number | null, number | null] => {
    const value = validHistory ? values[Math.ceil(probability / 100 * values.length) - 1] : null;
    let quantilePrice = annual !== null && value && value > 0 ? annual / value : null;
    if (isHk) quantilePrice = quantilePrice !== null && fxRate ? quantilePrice / fxRate : null;
    return [value, quantilePrice];
  };
  const [q60, p60] = quantile(60), [q90, p90] = quantile(90);
  return {
    ...stock,
    yield_basis: stock.yield_basis ?? "annual", custom_yield: stock.custom_yield ?? null,
    selected_yield: selectedYield, basis_dividend: basisDividend,
    dividend_yield: annualYield, rolling_yield: rollingYield,
    target_price: basisDividend !== null && target && target > 0 ? basisDividend / target : null,
    yield_gap: gap, status: yieldStatus(gap),
    year_change: price && startPrice && startPrice > 0 ? price / startPrice - 1 : null,
    percentile: validHistory && annualYield !== null ? values.filter(value => value <= annualYield + 1e-12).length / values.length : null,
    percentile_count: values.length,
    ah_premium: isHk && aPrice && valid ? aPrice / denominator - 1 : null,
    hk_net_yield: isHk && annualYield !== null ? annualYield * 0.9 : null,
    connect_yield: isHk && annualYield !== null && factor !== null ? annualYield * factor : null,
    quantile_60_yield: q60, quantile_60_price: p60,
    quantile_90_yield: q90, quantile_90_price: p90,
  };
}
