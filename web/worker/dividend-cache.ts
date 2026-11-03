import type { D1Database } from "@cloudflare/workers-types";
import type { DividendSnapshot, Providers, StockRecord } from "./types.ts";
import { timestamp, validate } from "./validation.ts";

interface CacheRow {
  cache_day: string | null;
  snapshot: string | null;
  lease_until: number;
  retry_after: number;
}
const OPTIONAL_FIELDS = ["next_ex_dividend_date", "dividend_calendar_dates", "dividend_splits", "dividend_verification",
  "dividend_note", "dividend_as_of", "dividend_annual_start", "dividend_annual_end", "dividend_rolling_start",
  "dividend_hkd_annual", "dividend_hkd_rolling", "annual_eps", "annual_eps_year", "annual_eps_currency",
  "payout_dividend", "payout_currency"] as const;

// Explicit allowlist: no price, history, user ID, watch state or personal settings.
function publicSnapshot(value: DividendSnapshot): DividendSnapshot {
  const result: DividendSnapshot = {
    annual_dividend: value.annual_dividend, rolling_dividend: value.rolling_dividend, annual_year: value.annual_year,
    confirmed: value.confirmed, ex_dividend_date: value.ex_dividend_date, dividends: structuredClone(value.dividends),
    dividend_source: value.dividend_source, dividend_updated_at: value.dividend_updated_at, dividend_fx_rate: value.dividend_fx_rate,
  };
  for (const field of OPTIONAL_FIELDS) if (value[field] !== undefined) Object.assign(result, { [field]: structuredClone(value[field]) });
  return result;
}

export function dividendCacheKey(stock: Pick<StockRecord, "market" | "code" | "instrument_type" | "exchange">) {
  const exchange = stock.market === "HK" ? "hk" : stock.instrument_type === "etf" ? stock.exchange ?? ""
    : stock.code[0] === "6" ? "sh" : "489".includes(stock.code[0]) ? "bj" : "sz";
  return `v1:${stock.market}:${stock.instrument_type ?? "stock"}:${exchange}:${stock.code}`;
}

/** One successful public fetch per security per China/Perth calendar day. */
export async function dailyDividend(db: D1Database, stock: StockRecord, source: Providers, force = false) {
  const key = dividendCacheKey(stock), today = timestamp().slice(0, 10), now = Date.now();
  const read = () => db.prepare("SELECT cache_day,snapshot,lease_until,retry_after FROM public_dividend_cache WHERE security_key=?")
    .bind(key).first<CacheRow>();
  const cached = (row: CacheRow | null) => row?.cache_day === today && row.snapshot
    ? { snapshot: publicSnapshot(JSON.parse(row.snapshot)), cached: true } : null;
  const row = await read();
  if (!force) {
    const hit = cached(row);
    if (hit) return hit;
  }
  if (!force && row && row.retry_after > now) throw new Error("分红来源暂不可用，已保留原值，稍后刷新时重试");
  const token = crypto.randomUUID();
  // A database lease also deduplicates different Worker instances and users.
  const claim = await db.prepare("INSERT INTO public_dividend_cache(security_key,lease_token,lease_until) VALUES(?,?,?) " +
    "ON CONFLICT(security_key) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until " +
    "WHERE public_dividend_cache.lease_until<=? AND (?=1 OR public_dividend_cache.retry_after<=?) " +
    "AND (?=1 OR public_dividend_cache.cache_day IS NULL OR public_dividend_cache.cache_day<>?)")
    .bind(key, token, now + 60_000, now, Number(force), now, Number(force), today).run();
  if (!claim.meta.changes) {
    const hit = !force && cached(await read());
    if (hit) return hit;
    throw new Error("该标的的公共分红正在更新，已保留原值，请稍后刷新");
  }
  try {
    if (!source.fetchDividends) throw new Error("分红来源未配置");
    // Providers only receive the security identity, never another user's data.
    const identity = validate({ code: stock.code, market: stock.market, name: stock.code, sector: "未分类",
      instrument_type: stock.instrument_type ?? "stock", exchange: stock.exchange ?? null });
    const snapshot = publicSnapshot(await source.fetchDividends(identity));
    const saved = await db.prepare("UPDATE public_dividend_cache SET snapshot=?,cache_day=?,lease_token=NULL,lease_until=0,retry_after=0 " +
      "WHERE security_key=? AND lease_token=?").bind(JSON.stringify(snapshot), today, key, token).run();
    if (!saved.meta.changes) {
      const newer = cached(await read());
      if (newer) return newer;
      throw new Error("公共分红更新已由其他请求接手，请稍后刷新");
    }
    return { snapshot, cached: false };
  } catch (error) {
    // Failed requests never become zero dividends or replace a verified cache.
    await db.prepare("UPDATE public_dividend_cache SET lease_token=NULL,lease_until=0,retry_after=? WHERE security_key=? AND lease_token=?")
      .bind(Date.now() + 300_000, key, token).run();
    throw error;
  }
}

/** Revalue only native HKD cash at the current FX; cached provider facts stay unchanged. */
export function dividendAtFx(snapshot: DividendSnapshot, fx: number | null): DividendSnapshot {
  const previous = snapshot.dividend_fx_rate;
  if (!fx || !previous || fx === previous) return snapshot;
  const delta = fx - previous;
  return { ...snapshot,
    annual_dividend: snapshot.annual_dividend === null ? null : snapshot.annual_dividend + (snapshot.dividend_hkd_annual ?? 0) * delta,
    rolling_dividend: snapshot.rolling_dividend === null ? null : snapshot.rolling_dividend + (snapshot.dividend_hkd_rolling ?? 0) * delta,
    dividends: snapshot.dividends.map(part => ({ ...part, dps: part.dps + (part.hkd_dps ?? 0) * delta })),
    dividend_fx_rate: fx,
  };
}
