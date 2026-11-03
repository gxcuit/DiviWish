import type { SqliteDatabase, SqliteStatement } from "./types.ts";
import { readRow } from "./database.ts";
import { dailyDividend, dividendAtFx } from "./dividend-cache.ts";
import { HttpError, json } from "./http.ts";
import { portfolio } from "./portfolio.ts";
import { timestamp } from "./validation.ts";
import type { DividendSnapshot, Providers, StockRecord, StockRow } from "./types.ts";

const QUOTE_FIELDS = ["price", "change_pct", "quote_date", "year_start_price", "year_start_year", "year_start_date", "year_start_adjustment"];
const DIVIDEND_FIELDS = ["instrument_type", "exchange", "next_ex_dividend_date", "dividend_calendar_dates", "dividend_splits", "dividend_verification", "dividend_note", "dividend_as_of", "dividend_annual_start", "dividend_annual_end", "dividend_rolling_start", "annual_dividend", "rolling_dividend", "annual_year", "confirmed", "ex_dividend_date", "dividends",
  "dividend_source", "dividend_updated_at", "dividend_fx_rate", "dividend_hkd_annual", "dividend_hkd_rolling", "annual_eps", "annual_eps_year", "annual_eps_currency", "payout_dividend", "payout_currency"];
const unchanged = (before: StockRecord, after: StockRecord, keys: string[]) =>
  keys.every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));

type RefreshOptions = { phase?: "all" | "quotes" | "dividends"; forceDividends?: boolean };

export function refreshOptions(url: URL): RefreshOptions {
  const phase = url.searchParams.get("phase") ?? "all";
  if (phase !== "all" && phase !== "quotes" && phase !== "dividends") throw new HttpError(400, "刷新阶段无效");
  return { phase, forceDividends: url.searchParams.get("dividends") === "force" };
}

async function dividendSnapshots(db: SqliteDatabase, records: StockRecord[], source: Providers, errors: string[], force = false) {
  const snapshots = new Map<number, DividendSnapshot>(), deadline = Date.now() + 40_000;
  let lastAttempted: number | null = null, cached = 0;
  // Bound parallel upstream requests and finish within the browser's request timeout.
  for (let offset = 0; offset < records.length; offset += 4) {
    if (Date.now() >= deadline) {
      errors.push(`其余 ${records.length - offset} 支股票的股息尚未查询，再次刷新将优先继续未完成的查询`);
      break;
    }
    await Promise.all(records.slice(offset, offset + 4).map(async stock => {
      try {
        const result = await dailyDividend(db, stock, source, force);
        snapshots.set(stock.id!, result.snapshot);
        if (result.cached) cached++;
      } catch (error) { errors.push(`${stock.code}：${error instanceof Error ? error.message : "分红获取失败"}，保留原股息与明细`); }
    }));
    lastAttempted = records[Math.min(offset + 4, records.length) - 1].id!;
  }
  return { snapshots, lastAttempted, cached };
}

/** Refresh the single local portfolio without overwriting concurrent edits. */
export async function refreshStocks(db: SqliteDatabase, records: StockRecord[], source: Providers, resumeDividends = false, options: RefreshOptions = {}) {
  if (!records.length) throw new HttpError(400, "请先添加股票");
  const store = portfolio(db);
  const meta = await store.meta(), phase = options.phase ?? "all";
  const cursor = resumeDividends ? meta.dividend_refresh_cursor : null;
  const ordered = [...records].sort((first, second) => first.id! - second.id!);
  const start = typeof cursor === "number" ? Math.max(0, ordered.findIndex(stock => stock.id! > cursor)) : 0;
  const pending = [...ordered.slice(start), ...ordered.slice(0, start)];
  const errors: string[] = [];
  const [quoteResult, { snapshots: dividends, lastAttempted, cached }, fxResult] = await Promise.all([
    phase === "dividends" ? Promise.resolve({ quotes: new Map(), errors: [] }) : source.fetchQuotes(records).catch(() => ({ quotes: new Map(), errors: ["腾讯行情请求失败，保留旧报价"] })),
    phase === "quotes" ? Promise.resolve({ snapshots: new Map<number, DividendSnapshot>(), lastAttempted: null, cached: 0 })
      : dividendSnapshots(db, pending, source, errors, options.forceDividends),
    phase === "dividends" ? Promise.resolve(typeof meta.fx_rate === "number" ? meta.fx_rate : null)
      : records.some(stock => stock.market === "HK") ? source.fetchFx().catch(() => null) : Promise.resolve(null),
  ]);
  errors.push(...quoteResult.errors);
  let fx = fxResult;
  if (fx === null) {
    // The dividend provider may have obtained a verified conversion independently.
    fx = [...dividends.values()].map(snapshot => snapshot.dividend_fx_rate).find(rate => rate !== null && rate > 0 && rate < 10) ?? null;
    if (records.some(stock => stock.market === "HK") && fx === null) errors.push("汇率获取失败，沿用原汇率；无有效汇率时港股股息率仍不可计算");
  }
  const now = timestamp(), marker = crypto.randomUUID();
  const changes: { stock: StockRecord; applyQuote: boolean; applyDividends: boolean; statement: SqliteStatement }[] = [];
  for (const stock of records) {
    const row = await db.prepare("SELECT * FROM stocks WHERE id=?").bind(stock.id!).first<StockRow>();
    if (!row || row.code !== stock.code || row.market !== stock.market || readRow(row).instrument_type !== stock.instrument_type || readRow(row).exchange !== stock.exchange) {
      errors.push(`${stock.code}：刷新期间股票已修改或删除，跳过旧数据`); continue;
    }
    const current = readRow(row), patch: Record<string, unknown> = {};
    const quote = quoteResult.quotes.get(stock.id!), savedSnapshot = dividends.get(stock.id!);
    const snapshot = savedSnapshot && stock.market === "HK" ? dividendAtFx(savedSnapshot, fx) : savedSnapshot;
    const applyQuote = Boolean(quote) && unchanged(stock, current, QUOTE_FIELDS);
    const applyDividends = Boolean(snapshot) && unchanged(stock, current, DIVIDEND_FIELDS);
    if (quote && !applyQuote) errors.push(`${stock.code}：刷新期间报价已修改，保留手动修改`);
    if (snapshot && !applyDividends) errors.push(`${stock.code}：刷新期间股息已修改，保留手动修改`);
    if (!applyQuote && !applyDividends) continue;
    if (applyQuote) Object.assign(patch, quote);
    if (applyDividends) {
      Object.assign(patch, snapshot, { verification_note: null });
      if (stock.instrument_type === "etf" && !unchanged(current, { ...current, ...snapshot }, ["dividends", "rolling_dividend", "dividend_note", "dividend_splits"])) {
        Object.assign(patch, { history: [], history_version: null, history_status: null, history_updated_at: null, history_note: null, percentile_start: null, percentile_end: null });
      }
    }
    Object.assign(patch, { updated_at: now, _refresh_id: marker,
      source: applyDividends ? `${applyQuote ? "腾讯实时行情；" : "报价来自保存数据；"}${snapshot?.dividend_source || "东方财富公开分红资料"}` : "腾讯实时行情；分红及历史来自保存数据" });
    changes.push({ stock, applyQuote, applyDividends, statement: db.prepare("UPDATE stocks SET document=json_patch(document,?) " +
      "WHERE id=? AND code=? AND market=? AND document=?")
      .bind(JSON.stringify(patch), stock.id!, stock.code, stock.market, row.document) });
  }
  // Advance even on upstream failures; one bad batch must not starve later stocks.
  // Single-stock refreshes never change the full-portfolio continuation point.
  const progress = resumeDividends && lastAttempted !== null ? [store.setMeta("dividend_refresh_cursor", lastAttempted)] : [];
  if (!changes.length) {
    if (progress.length) await db.batch(progress);
    return json({ message: "刷新未更新任何数据，原值保持不变", updated: 0, quotes_updated: 0, dividends_updated: 0, dividends_cached: cached, errors }, 502);
  }
  const matched = "FROM stocks WHERE json_extract(document,'$._refresh_id')=?";
  const setMeta = (key: string, value: unknown, filter = "") => db.prepare("INSERT INTO metadata(key,value) " +
    `SELECT ?,? WHERE EXISTS(SELECT 1 ${matched}${filter}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(key, JSON.stringify(value), marker);
  const metadata = [...progress, setMeta("last_refresh", now)];
  if (fx !== null) metadata.push(setMeta("fx_rate", fx, " AND market='HK'"));
  const quotedIds = JSON.stringify(changes.filter(change => change.applyQuote).map(change => change.stock.id));
  metadata.push(db.prepare("INSERT INTO metadata(key,value) " +
    `SELECT 'quote_date',json_quote(MAX(json_extract(document,'$.quote_date'))) ${matched} AND id IN (SELECT value FROM json_each(?)) ` +
    "HAVING MAX(json_extract(document,'$.quote_date')) IS NOT NULL ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(marker, quotedIds));
  const results = (await db.batch([...changes.map(change => change.statement), ...metadata])).slice(0, changes.length);
  const updated = results.filter(row => row.meta.changes > 0).length;
  const quotesUpdated = results.filter((row, index) => row.meta.changes > 0 && changes[index].applyQuote).length;
  const dividendsUpdated = results.filter((row, index) => row.meta.changes > 0 && changes[index].applyDividends).length;
  if (updated !== changes.length) errors.push("刷新期间部分股票再次发生变更，已跳过旧数据，请重试");
  return json({ message: updated ? `已更新 ${updated} 支股票：行情 ${quotesUpdated} 支，股息 ${dividendsUpdated} 支${cached ? `（复用今日缓存 ${cached} 支）` : ""}` : "刷新期间数据已变更，原值保持不变",
    updated, quotes_updated: quotesUpdated, dividends_updated: dividendsUpdated, dividends_cached: cached, errors }, updated ? 200 : 502);
}
