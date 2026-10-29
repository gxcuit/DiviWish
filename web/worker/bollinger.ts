import { number } from "./calculations.ts";
import type { Bar, Period, Providers, Quote, StockRecord } from "./types.ts";

const PERIODS: Record<Period, string> = { day: "日线", week: "周线", month: "月线" };
type Band = { available: boolean; count?: number; error?: string; lower?: number; middle?: number; upper?: number;
  start_date?: string; last_date?: string; adjustment?: string; position?: string; percent_b?: number | null };
type Bundle = { bands: (Band & { period: Period; label: string })[]; quote: Quote | null; fetched_at: string };

export function calculateBands(bars: Bar[]): Band {
  if (bars.length < 20) return { available: false, count: bars.length, error: `仅有 ${bars.length} 根 K 线，需要至少 20 根` };
  const samples = bars.slice(-20);
  const closes = samples.map(bar => number(bar.close));
  if (closes.some(close => close === null)) throw new Error("K 线收盘价无效");
  const values = closes as number[];
  const middle = values.reduce((sum, close) => sum + close, 0) / 20;
  const deviation = Math.sqrt(values.reduce((sum, close) => sum + (close - middle) ** 2, 0) / 20);
  const lower = middle - 2 * deviation, upper = middle + 2 * deviation;
  if (![lower, middle, upper].every(Number.isFinite)) throw new Error("BOLL 计算结果无效");
  return { available: true, count: 20, start_date: samples[0].date, last_date: samples[19].date, lower, middle, upper };
}

function close(a: number, b: number, absolute = 0): boolean {
  return Math.abs(a - b) <= Math.max(1e-12 * Math.max(Math.abs(a), Math.abs(b)), absolute);
}

export function pricePosition(band: Band, price: number | null) {
  if (price === null) return { position: "unknown", percent_b: null };
  const lower = band.lower!, middle = band.middle!, upper = band.upper!;
  const flat = close(lower, upper, 1e-12);
  const position = price < lower && !close(price, lower) ? "below_lower" :
    price > upper && !close(price, upper) ? "above_upper" : flat ? "flat" :
      close(price, lower) ? "at_lower" : close(price, upper) ? "at_upper" : close(price, middle) ? "at_middle" :
        price < middle ? "lower_half" : "upper_half";
  return { position, percent_b: flat ? null : (price - lower) / (upper - lower) };
}

export class BollingerService {
  private cache = new Map<string, { time: number; bundle: Bundle }>();

  async get(stock: StockRecord, source: Providers, force = false) {
    const key = `${stock.market}:${stock.code}`, entry = this.cache.get(key);
    const cached = Boolean(!force && entry && Date.now() - entry.time < 300_000);
    let bundle = cached ? structuredClone(entry!.bundle) : null;
    if (!bundle) {
      const results = await Promise.all((Object.keys(PERIODS) as Period[]).map(async period => {
        try {
          const data = await source.fetchKline(stock, period);
          return { band: { period, label: PERIODS[period], ...calculateBands(data.bars), adjustment: data.adjustment }, quote: data.quote };
        } catch {
          return { band: { period, label: PERIODS[period], available: false, error: "行情数据获取失败，请重试" }, quote: null };
        }
      }));
      const quotes = results.map(row => row.quote).filter((quote): quote is Quote => quote !== null)
        .sort((a, b) => (b.quote_date ?? "").localeCompare(a.quote_date ?? ""));
      bundle = { bands: results.map(row => row.band), quote: quotes[0] ?? null, fetched_at: new Date().toISOString() };
      if (bundle.bands.every(band => band.available)) {
        this.cache.delete(key);
        this.cache.set(key, { time: Date.now(), bundle: structuredClone(bundle) });
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    let quote = bundle.quote;
    let priceSource = quote ? "腾讯报价" : "暂无有效报价";
    const saved = number(stock.price);
    if (saved !== null && saved > 0 && (!quote || (stock.quote_date ?? "") > (quote.quote_date ?? ""))) {
      quote = { price: saved, quote_date: stock.quote_date };
      priceSource = "本机保存报价";
    }
    const price = quote?.price ?? null;
    return { window: 20, multiplier: 2, source: "腾讯证券", price, quote_date: quote?.quote_date ?? null,
      price_source: priceSource, cached, fetched_at: bundle.fetched_at,
      bands: bundle.bands.map(band => band.available ? { ...band, ...pricePosition(band, price) } : band) };
  }
}
