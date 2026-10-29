import { GRID_DEFAULTS, YIELD_DEFAULTS, gridLevels, number } from "./calculations.ts";
import type { StockRecord } from "./types.ts";

export const DEFAULT_STOCK = {
  ...GRID_DEFAULTS, ...YIELD_DEFAULTS,
  price: null, change_pct: null, annual_dividend: null, rolling_dividend: null,
  target_yield: null, confirmed: false, ex_dividend_date: null, quote_date: null,
  updated_at: null, annual_year: null, year_start_price: null, percentile_start: null,
  percentile_end: null, a_code: null, source: "手动录入", verification_note: null,
  dividends: [], history: [], connect_factor: null,
};
const EDITABLE = new Set(["code", "name", "sector", "market", "price", "annual_dividend", "rolling_dividend", "target_yield",
  "confirmed", "ex_dividend_date", "watched", "a_code", "year_start_price", ...Object.keys(GRID_DEFAULTS), ...Object.keys(YIELD_DEFAULTS)]);

export function timestamp(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
}

export function dateString(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value ? value : null;
}

export function sectorName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 30) throw new Error("板块名称须为 1 至 30 个字符");
  const name = value.trim();
  if (name === "全部") throw new Error("“全部”为筛选入口，不能用作板块名称");
  return name;
}

export function validate(data: unknown, existing?: StockRecord): StockRecord {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) throw new Error("请填写股票资料");
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !EDITABLE.has(key)).sort();
  if (unknown.length) throw new Error("不支持的字段：" + unknown.join("、"));
  const stock = { ...structuredClone(DEFAULT_STOCK), watched: false, ...existing, ...input } as StockRecord;
  for (const field of ["name", "sector", "code"] as const) {
    const value = stock[field];
    if (typeof value !== "string" || !value.trim() || [...value].length > 80) throw new Error(`${field} 必须为 1 至 80 个字符`);
    stock[field] = value.trim();
  }
  stock.sector = sectorName(stock.sector);
  gridLevels(stock);
  if (!["annual", "rolling", "custom"].includes(stock.yield_basis)) throw new Error("股息率口径只能为年度、滚动年度或自定义");
  if (stock.custom_yield !== null) {
    const custom = number(stock.custom_yield);
    if (custom === null || custom < 0 || custom > 1) throw new Error("自定义股息率须为 0% 至 100% 的有效数字");
    stock.custom_yield = custom;
  }
  if (stock.yield_basis === "custom" && stock.custom_yield === null) throw new Error("选择自定义口径时，请填写自定义股息率");
  if (!["A", "HK"].includes(stock.market)) throw new Error("市场只能为 A 或 HK");
  const length = stock.market === "A" ? 6 : 5;
  if (!new RegExp(`^[0-9]{${length}}$`).test(stock.code)) throw new Error(`股票代码需要 ${length} 位数字`);
  for (const field of ["price", "annual_dividend", "rolling_dividend", "target_yield", "year_start_price"] as const) {
    if (stock[field] === null) continue;
    const parsed = number(stock[field]);
    if (parsed === null || parsed < 0) throw new Error(`${field} 需要有效的非负数字`);
    if (["price", "year_start_price", "target_yield"].includes(field) && parsed <= 0) throw new Error(`${field} 必须大于 0`);
    if (field === "target_yield" && parsed > 1) throw new Error("目标股息率须为 (0,1] 之间的小数，例如 0.05");
    stock[field] = parsed;
  }
  for (const field of ["confirmed", "watched"]) {
    if (field in input && typeof input[field] !== "boolean") throw new Error(`${field} 必须为布尔值`);
  }
  if (stock.ex_dividend_date !== null && dateString(stock.ex_dividend_date) !== stock.ex_dividend_date) throw new Error("除息日格式须为 YYYY-MM-DD");
  if (stock.a_code !== null && (typeof stock.a_code !== "string" || !/^[0-9]{6}$/.test(stock.a_code))) throw new Error("对应 A 股代码需要 6 位数字");
  const changed = (fields: string[]) => existing && fields.some(field => field in input && input[field] !== existing[field]);
  if (changed(["rolling_dividend"])) stock.dividend_hkd_rolling = 0;
  if (changed(["annual_dividend", "code", "market"])) {
    for (const field of ["history_source", "history_updated_at", "history_note"]) delete stock[field];
    for (const field of ["dividend_source", "dividend_updated_at", "dividend_fx_rate", "dividend_hkd_annual", "dividend_hkd_rolling"]) delete stock[field];
    Object.assign(stock, { dividends: [], history: [], percentile_start: null, percentile_end: null, annual_year: null,
      source: "手动编辑（分红或证券身份已变更，历史对比已清除）", verification_note: "手动分红需自行核实；相关历史对比已清除。" });
    if (!("rolling_dividend" in input)) stock.rolling_dividend = null;
    if (!("confirmed" in input)) stock.confirmed = false;
    if (changed(["code", "market"])) {
      for (const field of ["price", "annual_dividend", "ex_dividend_date", "year_start_price", "a_code"] as const) {
        if (!(field in input)) stock[field] = null;
      }
      Object.assign(stock, { quote_date: null, change_pct: null });
      if (!("yield_basis" in input)) Object.assign(stock, YIELD_DEFAULTS);
    }
  }
  if ("price" in input && (!existing || input.price !== existing.price)) {
    Object.assign(stock, { quote_date: null, change_pct: null, source: "手动报价；交易日期待核实" });
  }
  if (Object.keys(input).some(key => key !== "watched")) stock.updated_at = timestamp();
  return stock;
}
