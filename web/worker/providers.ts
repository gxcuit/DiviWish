import { fetchDividends, fetchHistoricalDividends } from "./dividends.ts";
import { buildHistory, historyEnd, yearsBefore } from "./history.ts";
import { number } from "./calculations.ts";
import { dateString } from "./validation.ts";
import type { Kline, Period, Providers, Quote, StockRecord, Suggestion } from "./types.ts";

export function symbolFor(stock: Pick<StockRecord, "market" | "code">): string {
  if (stock.market === "HK") return "hk" + stock.code;
  return (stock.code[0] === "6" ? "sh" : "489".includes(stock.code[0]) ? "bj" : "sz") + stock.code;
}

export function quoteDate(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? dateString(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`) : null;
}

function numeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  return number(Number(value));
}

// The timeout covers reading the response body as well as receiving its headers.
async function load(url: string, encoding = "utf-8", timeout = 12_000): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`行情服务 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("行情来源未返回内容");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("行情响应超过大小限制"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder(encoding).decode(bytes);
}

export function parseSearch(text: string): Suggestion[] {
  const match = text.match(/v_hint\s*=\s*("(?:\\.|[^"\\])*")/);
  if (!match) throw new Error("股票搜索返回格式无效");
  const content: unknown = JSON.parse(match[1]);
  if (typeof content !== "string") throw new Error("股票搜索返回格式无效");
  if (!content || content === "N") return [];
  const results: Suggestion[] = [], seen = new Set<string>();
  for (const entry of content.split("^")) {
    const [exchange, code, name, , kind] = entry.split("~");
    const market = exchange === "hk" ? "HK" : ["sh", "sz", "bj"].includes(exchange) ? "A" : null;
    if (!market || !kind?.startsWith("GP") || !name?.trim() || (market === "A" && kind !== "GP-A")) continue;
    if (!(market === "HK" ? /^[0-9]{5}$/ : /^[0-9]{6}$/).test(code)) continue;
    const identity = `${market}:${code}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push({ name: name.trim(), code, market });
    if (results.length === 10) break;
  }
  return results;
}

export function parseQuotes(text: string, stocks: StockRecord[]) {
  const expected = new Map(stocks.map(stock => [symbolFor(stock), stock.id!]));
  const quotes = new Map<number, Quote>();
  for (const match of text.matchAll(/v_([a-z]+\d+)="([^"\r\n]*)"/g)) {
    const id = expected.get(match[1]);
    if (id === undefined) continue;
    const fields = match[2].split("~");
    if (fields.length < 33) continue;
    const price = numeric(fields[3]), change = numeric(fields[32]), day = quoteDate(fields[30]);
    if (price === null || price <= 0 || !day) continue;
    quotes.set(id, { price, change_pct: change !== null ? change / 100 : null, quote_date: day });
  }
  return { quotes, errors: [...expected].filter(([, id]) => !quotes.has(id)).map(([symbol]) => `${symbol}：腾讯报价或交易日期缺失，保留原值`) };
}

export function parseKline(payload: unknown, stock: StockRecord, period: Period): Kline {
  const object = payload as { code?: number; data?: Record<string, Record<string, unknown>> };
  if (object.code && object.code !== 0) throw new Error("K 线接口返回错误");
  const symbol = symbolFor(stock), data = object.data?.[symbol] ?? {};
  const adjusted = "qfq" + period;
  const rows = adjusted in data ? data[adjusted] : data[period];
  if (!Array.isArray(rows)) throw new Error("K 线数据缺失");
  const bars = new Map<string, number>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) throw new Error("K 线格式无效");
    const day = dateString(row[0]), close = numeric(row[2]);
    if (!day || close === null) throw new Error("K 线日期或收盘价无效");
    if (bars.has(day) && bars.get(day) !== close) throw new Error("K 线日期重复且价格不一致");
    bars.set(day, close);
  }
  const qt = (data.qt as Record<string, unknown[]> | undefined)?.[symbol];
  const price = qt && qt.length > 30 ? numeric(qt[3]) : null;
  const day = qt && typeof qt[30] === "string" ? quoteDate(qt[30]) : null;
  return { bars: [...bars].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close })),
    adjustment: adjusted in data ? "qfq" : "none", quote: price !== null && price > 0 && day ? { price, quote_date: day } : null };
}

export const providers: Providers = {
  async fetchHistory(stock) {
    const end = historyEnd(), start = yearsBefore(end, 5);
    const ranges: { start: string; end: string }[] = [];
    for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
      ranges.push({ start: year === Number(start.slice(0, 4)) ? start : `${year}-01-01`, end: year === Number(end.slice(0, 4)) ? end : `${year}-12-31` });
    }
    const fetchPrices = async () => {
      const bars = [];
      for (let offset = 0; offset < ranges.length; offset += 3) {
        const group = await Promise.all(ranges.slice(offset, offset + 3).map(async range => {
          const query = new URLSearchParams({ param: `${symbolFor(stock)},day,${range.start},${range.end},640,` });
          const endpoint = stock.market === "HK" ? "hkfqkline" : "fqkline";
          const payload = JSON.parse(await load(`https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get?${query}`, "utf-8", 9000));
          const data = parseKline(payload, stock, "day");
          if (data.adjustment !== "none") throw new Error("历史分位必须使用不复权日线");
          return data.bars.filter(bar => bar.date >= range.start && bar.date <= range.end);
        }));
        bars.push(...group.flat());
      }
      return bars;
    };
    const [events, prices] = await Promise.all([fetchHistoricalDividends(stock, end), fetchPrices()]);
    return buildHistory(events, prices, end);
  },
  fetchDividends(stock) { return fetchDividends(stock, () => providers.fetchFx()); },
  async searchStocks(query) {
    return parseSearch(await load(`https://smartbox.gtimg.cn/s3/?${new URLSearchParams({ q: query, t: "all" })}`, "gbk", 6000));
  },
  async fetchQuotes(stocks) {
    const quotes = new Map<number, Quote>(), errors: string[] = [];
    // Keep requests bounded for long watchlists and Workers' subrequest limits.
    for (let offset = 0; offset < stocks.length; offset += 80) {
      const group = stocks.slice(offset, offset + 80);
      try {
        const parsed = parseQuotes(await load("https://qt.gtimg.cn/q=" + group.map(symbolFor).join(","), "gbk"), group);
        for (const [id, quote] of parsed.quotes) quotes.set(id, quote);
        errors.push(...parsed.errors);
      } catch {
        errors.push(...group.map(stock => `${stock.code}：腾讯行情请求失败，保留旧报价`));
      }
    }
    return { quotes, errors };
  },
  async fetchFx() {
    const payload = JSON.parse(await load("https://api.exchangerate-api.com/v4/latest/HKD"));
    const value = number(payload?.rates?.CNY);
    if (value === null || value <= 0 || value >= 10) throw new Error("HKD/CNY 汇率缺失或无效");
    return value;
  },
  async fetchKline(stock, period) {
    const endpoint = stock.market === "HK" ? "hkfqkline" : "fqkline";
    const query = new URLSearchParams({ param: `${symbolFor(stock)},${period},,,30,qfq` });
    return parseKline(JSON.parse(await load(`https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get?${query}`, "utf-8", 9000)), stock, period);
  },
};
