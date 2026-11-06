import type { D1Database as SqliteDatabase } from "@cloudflare/workers-types";
import type { Providers, StockRecord } from "./types.ts";
import type { ForecastSnapshot } from "./forecast-types.ts";
import { forecastToday, forecastYear } from "./forecast.ts";
import { validate } from "./validation.ts";
import type { ForecastDocumentCache } from "./forecast-announcements.ts";

interface Row { snapshot: string | null; cache_day: string | null; lease_until: number; retry_after: number }
function publicSnapshot(snapshot: ForecastSnapshot): ForecastSnapshot {
  const { year, fetched_at, fiscal_end, financials, consensus, dividends, commitments, search, errors, fx, data_stale } = snapshot;
  return structuredClone({ year, fetched_at, fiscal_end, financials, consensus, dividends, commitments, search, errors, fx, data_stale });
}
export async function dailyForecast(db: SqliteDatabase, stock: StockRecord, providers: Providers, force = false) {
  if (stock.instrument_type === "etf") throw new Error("ETF 不适用个股盈利分红预估");
  const year = forecastYear(), today = forecastToday(), now = Date.now();
  const key = `v1:${stock.market}:${stock.code}:${year}`;
  const read = () => db.prepare("SELECT snapshot,cache_day,lease_until,retry_after FROM public_forecast_cache WHERE cache_key=?").bind(key).first<Row>();
  const row = await read();
  const previous: ForecastSnapshot | null = row?.snapshot ? publicSnapshot(JSON.parse(row.snapshot)) : null;
  if (!force && row?.cache_day === today && previous && !previous.search.pending.length && !previous.search.continuations?.length) return { snapshot: previous, cached: true };
  if (row && row.retry_after > now && !force) throw new Error("预估来源暂不可用，保留旧值，请稍后重试");
  const token = crypto.randomUUID();
  const claim = await db.prepare("INSERT INTO public_forecast_cache(cache_key,lease_token,lease_until) VALUES(?,?,?) " +
    "ON CONFLICT(cache_key) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE public_forecast_cache.lease_until<=?")
    .bind(key, token, now + 90_000, now).run();
  if (!claim.meta.changes) throw new Error("此证券预估正在更新，请稍后重试");
  const cache: ForecastDocumentCache = {
    async read(id) { const r = await db.prepare("SELECT pages FROM public_forecast_documents WHERE announcement_id=?").bind(id).first<{ pages: string }>(); return r ? JSON.parse(r.pages) : null; },
    async write(id, pages) { await db.prepare("INSERT INTO public_forecast_documents(announcement_id,pages,fetched_at) VALUES(?,?,?) ON CONFLICT(announcement_id) DO NOTHING").bind(id, JSON.stringify(pages), today).run(); },
  };
  try {
    if (!providers.fetchForecast) throw new Error("预估数据来源尚未配置");
    const identity = validate({ code: stock.code, market: stock.market, name: stock.code, sector: "未分类", instrument_type: "stock", exchange: stock.exchange ?? null });
    const snapshot = publicSnapshot(await providers.fetchForecast(identity, year, force && previous ? { ...previous, fetched_at: "" } : previous, cache));
    if (snapshot.year !== year || !snapshot.fetched_at.startsWith(today)) throw new Error("预估来源返回了错误财年或获取日期");
    const result = await db.prepare("UPDATE public_forecast_cache SET snapshot=?,cache_day=?,lease_token=NULL,lease_until=0,retry_after=0 WHERE cache_key=? AND lease_token=?")
      .bind(JSON.stringify(snapshot), today, key, token).run();
    if (!result.meta.changes) throw new Error("预估已由另一请求更新，请重试");
    return { snapshot, cached: false };
  } catch (error) {
    await db.prepare("UPDATE public_forecast_cache SET lease_token=NULL,lease_until=0,retry_after=? WHERE cache_key=? AND lease_token=?").bind(now + 300_000, key, token).run();
    throw error;
  }
}
