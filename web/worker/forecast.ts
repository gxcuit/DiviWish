import type { StockRecord } from "./types.ts";
import type { ForecastCurrency, ForecastManual, ForecastResult } from "./forecast-types.ts";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const forecastToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const forecastYear = () => Number(forecastToday().slice(0, 4));

/** Only saved manual amounts are used. Archived provider snapshots are never read. */
export function calculateForecast(stock: StockRecord, fx: unknown, today = forecastToday()): ForecastResult {
  const year = Number(today.slice(0, 4)), currency = stock.market === "HK" ? "HKD" : "CNY";
  const result: ForecastResult = { year, currency, status: "unavailable", dividend: null, yield: null, basis: null,
    formula: "人工年度每股股息 ÷ 当前股价（币种不同先换算）", reason: "请手动添加当前财年的预估股息率或年度每股股息", note: "", updated_at: null };
  if (stock.instrument_type === "etf") return { ...result, status: "unsupported", reason: "ETF 不适用个股预估口径" };
  const manual = stock.forecast_manual;
  if (!manual) return result;
  if (manual.kind !== "per_share" && manual.kind !== "yield" || !finite(manual.dividend) || manual.dividend < 0 || !["CNY", "HKD"].includes(manual.currency)) {
    return { ...result, reason: "旧人工模型参数已停止使用，请重新手动填写年度每股股息或预估股息率" };
  }
  if (manual.year !== year) return { ...result, reason: `已保存 ${manual.year} 财年人工预估，当前 ${year} 财年请重新填写` };
  result.updated_at = manual.updated_at; result.note = manual.note;
  const rate = manual.currency === currency ? 1 : finite(fx) && fx > 0 ? manual.currency === "HKD" ? fx : 1 / fx : null;
  if (rate === null && manual.dividend !== 0) return { ...result, reason: "缺少有效人民币／港币汇率，无法换算手动股息" };
  const dividend = manual.dividend === 0 ? 0 : manual.dividend * rate!;
  if (!Number.isFinite(dividend)) return { ...result, reason: "金额或汇率超出有效范围，请核实手动输入" };
  return { ...result, status: "ready", dividend, yield: finite(stock.price) && stock.price > 0 ? dividend / stock.price : null,
    basis: "manual", reason: "已采用保存的手动预估" };
}

export function validateForecastManual(value: unknown, stock: Pick<StockRecord, "market" | "price">): ForecastManual | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请填写有效的手动预估参数");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["year", "kind", "value", "currency", "note"].includes(key))) throw new Error("手动预估只支持财年、输入方式、数值、币种和备注");
  if (!Number.isInteger(v.year) || Number(v.year) < 2000 || Number(v.year) > 2200) throw new Error("请填写有效适用财年");
  if (v.kind !== "per_share" && v.kind !== "yield") throw new Error("请选择预估股息率或年度每股股息");
  if (!finite(v.value) || v.value < 0 || v.value > (v.kind === "yield" ? 1 : 1e9)) throw new Error(v.kind === "yield" ? "预估股息率须为0%至100%" : "每股股息须为有效的非负金额");
  if (v.currency !== "CNY" && v.currency !== "HKD") throw new Error("手动预估币种须为人民币或港币");
  if (typeof v.note !== "string" || v.note.length > 2000) throw new Error("预估备注最多2000字");
  const price = stock.price;
  if (v.kind === "yield" && (!finite(price) || price <= 0)) throw new Error("填写预估股息率前，请先保存有效股价；也可直接填写年度每股股息");
  if (v.kind === "yield" && v.currency !== (stock.market === "HK" ? "HKD" : "CNY")) throw new Error("百分比输入须使用股价币种");
  return { year: Number(v.year), kind: v.kind, value: v.value, currency: v.currency as ForecastCurrency, note: v.note.trim(),
    dividend: v.kind === "yield" ? v.value * price! : v.value, reference_price: v.kind === "yield" ? price : null, updated_at: new Date().toISOString() };
}
