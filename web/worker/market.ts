import { DEFAULT_MARKET_SELECTION, resolveMarketSelection, type MarketIndexCode, type MarketSelection } from "./market-indices.ts";
import { buildRelativeBands, buildValueRegression, MARKET_START, normalizedHistory } from "./market-analysis.ts";
import type { IndexBar, MarketPoint, MarketSnapshot } from "./market-types.ts";

export const MARKET_INDICES = { dividend: "H00922", a500: "000510CNY010", low_volatility: "H20269", low_volatility_100: "H20955" } as const;
export type MarketIndex = MarketIndexCode;
export type MarketLoader = (code: MarketIndex, start: string, end: string) => Promise<IndexBar[]>;
const SOURCE_URL = "https://www.csindex.com.cn";
const TTL = 30 * 60_000;

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

// Use only completed daily closes. Leave a publication buffer after the 15:00 CST close.
export function marketEnd(now = new Date()): string {
  const china = new Date(now.getTime() + 8 * 3600_000);
  if (china.getUTCHours() < 16) china.setUTCDate(china.getUTCDate() - 1);
  return china.toISOString().slice(0, 10);
}

export function parseIndexHistory(payload: unknown, code: MarketIndex, start: string, end: string): IndexBar[] {
  const result = payload as { code?: unknown; data?: unknown } | null;
  if (!result || String(result.code) !== "200" || !Array.isArray(result.data)) throw new Error("中证历史数据格式无效");
  const bars = new Map<string, number>();
  for (const item of result.data) {
    if (!item || typeof item !== "object") throw new Error("中证历史记录无效");
    const row = item as Record<string, unknown>;
    if (row.indexCode !== code) throw new Error("全收益指数代码不匹配");
    const raw = String(row.tradeDate ?? "");
    const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
    if (!validDate(date)) throw new Error("指数交易日期无效");
    if (date < start || date > end) continue;
    const close = typeof row.close === "number" || (typeof row.close === "string" && row.close.trim()) ? Number(row.close) : NaN;
    if (!Number.isFinite(close) || close <= 0) throw new Error("全收益指数收盘值缺失");
    if (bars.has(date) && bars.get(date) !== close) throw new Error("同日指数收盘值冲突");
    bars.set(date, close);
  }
  if (!bars.size) throw new Error("未取得全收益指数历史数据");
  return [...bars].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
}

export const fetchIndexHistory: MarketLoader = async (code, start, end) => {
  const url = new URL("/csindex-home/perf/index-perf", SOURCE_URL);
  url.search = new URLSearchParams({ indexCode: code, startDate: start.replaceAll("-", ""), endDate: end.replaceAll("-", "") }).toString();
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: `${SOURCE_URL}/` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`中证历史服务 HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("中证历史服务未返回内容");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("中证历史响应过大"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseIndexHistory(JSON.parse(new TextDecoder().decode(bytes)), code, start, end);
};

export function buildMarketSeries(dividend: IndexBar[], a500: IndexBar[], end: string): MarketPoint[] {
  const d = new Map(normalizedHistory(dividend, end).map(row => [row.date, row.close]));
  const a = new Map(normalizedHistory(a500, end).map(row => [row.date, row.close]));
  const dates = [...new Set([...d.keys(), ...a.keys()])].sort();
  const series: MarketPoint[] = [];
  for (let i = 40; i < dates.length; i++) {
    // Missing sessions invalidate the window instead of silently shortening 40 sessions.
    const window = dates.slice(i - 40, i + 1);
    if (window.some(date => !d.has(date) || !a.has(date))) continue;
    const date = dates[i], start = dates[i - 40];
    const dividendReturn = d.get(date)! / d.get(start)! - 1;
    const a500Return = a.get(date)! / a.get(start)! - 1;
    if (![dividendReturn, a500Return, dividendReturn - a500Return].every(Number.isFinite)) throw new Error("收益差计算结果无效");
    series.push({ date, start_date: start, dividend_return: dividendReturn, a500_return: a500Return, spread: dividendReturn - a500Return });
  }
  if (!series.length) throw new Error("至少需要 41 个日期一致的有效交易日收盘值，才能计算 40 日涨跌幅");
  // A gap must not allow an old pre-gap point to masquerade as the latest observation.
  const latestCommon = dates.filter(date => d.has(date) && a.has(date)).at(-1);
  if (series.at(-1)!.date !== latestCommon) throw new Error("近期指数历史不完整，暂不能计算最新 40 日收益差");
  return series;
}

export class MarketService {
  // Only completed public data is retained, partitioned by the allowlisted index/combination.
  private entries = new Map<string, { time: number; end: string; snapshot: MarketSnapshot }>();
  private histories = new Map<MarketIndex, { time: number; end: string; bars: IndexBar[] }>();
  private retryAfter = new Map<string, number>();
  private loader: MarketLoader;
  private clock: () => number;
  constructor(loader: MarketLoader = fetchIndexHistory, clock: () => number = Date.now) {
    this.loader = loader; this.clock = clock;
  }

  private async history(code: MarketIndex, end: string, now: number, force: boolean) {
    const entry = this.histories.get(code);
    if (entry && entry.end === end && now - entry.time < (force ? 60_000 : TTL)) return structuredClone(entry.bars);
    const bars = normalizedHistory(await this.loader(code, MARKET_START, end), end);
    if (!bars.length || (entry && bars.at(-1)!.date < entry.bars.at(-1)!.date)) throw new Error("指数历史缺失或返回了较旧数据");
    this.histories.set(code, { time: now, end, bars: structuredClone(bars) });
    return bars;
  }

  async get(force = false, requested: MarketSelection = DEFAULT_MARKET_SELECTION): Promise<MarketSnapshot> {
    const selection = resolveMarketSelection(requested.a.code, requested.b.code);
    const key = `${selection.a.code}:${selection.b.code}`;
    const now = this.clock(), end = marketEnd(new Date(now)), entry = this.entries.get(key);
    if (entry && entry.end === end && now - entry.time < (force ? 60_000 : TTL)) return { ...structuredClone(entry.snapshot), cached: true };
    if (now < (this.retryAfter.get(key) ?? 0)) {
      if (entry) return { ...structuredClone(entry.snapshot), cached: true, stale: true, warning: "数据源暂不可用，保留所选组合上次成功数据，请稍后重试。" };
      throw new Error("所选组合数据源暂不可用，请一分钟后重试");
    }
    try {
      // The shared B history is reusable across A selections; never share in-flight I/O between requests.
      const histories = await Promise.allSettled([
        this.history(selection.a.code, end, now, force), this.history(selection.b.code, end, now, force),
      ]);
      if (histories[0].status !== "fulfilled" || histories[1].status !== "fulfilled") throw new Error("全收益指数历史获取失败");
      const a = histories[0].value, b = histories[1].value;
      const series = buildMarketSeries(a, b, end);
      if (entry && series.at(-1)!.date < entry.snapshot.latest.date) throw new Error("数据源返回了较旧历史");
      const latest = series.at(-1)!;
      const snapshot: MarketSnapshot = { window: 40, selection, series, latest,
        relative: buildRelativeBands(a, b, latest.date), regression: buildValueRegression(a, latest.date), fetched_at: new Date(now).toISOString(),
        source: "中证指数有限公司 · 全收益指数日线", source_url: SOURCE_URL, cached: false, stale: false,
        warning: a.at(-1)?.date !== b.at(-1)?.date ? "两条指数更新日期不同，当前展示最近共同交易日。" : null };
      this.entries.set(key, { time: now, end, snapshot: structuredClone(snapshot) });
      this.retryAfter.delete(key);
      return snapshot;
    } catch {
      this.retryAfter.set(key, now + 60_000);
      if (entry) return { ...structuredClone(entry.snapshot), cached: true, stale: true, warning: "刷新失败，已保留所选组合上次成功数据；请以图中交易日期为准。" };
      throw new Error("暂未取得可核实的所选全收益指数历史数据，请稍后重试");
    }
  }
}
