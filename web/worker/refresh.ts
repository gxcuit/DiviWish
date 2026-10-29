import type { SqliteDatabase, SqliteStatement } from "./types.ts";
import { readRow } from "./database.ts";
import { HttpError, json } from "./http.ts";
import { timestamp } from "./validation.ts";
import type { DividendSnapshot, Providers, StockRecord, StockRow } from "./types.ts";

const QUOTE_FIELDS = ["price", "change_pct", "quote_date"];
const DIVIDEND_FIELDS = ["annual_dividend", "rolling_dividend", "annual_year", "confirmed", "ex_dividend_date", "dividends",
  "dividend_source", "dividend_updated_at", "dividend_fx_rate", "dividend_hkd_annual", "dividend_hkd_rolling"];
const unchanged = (before: StockRecord, after: StockRecord, keys: string[]) =>
  keys.every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));

async function dividendSnapshots(records: StockRecord[], source: Providers, errors: string[]) {
  const snapshots = new Map<number, DividendSnapshot>(), deadline = Date.now() + 40_000;
  // Bound parallel upstream requests and finish within the browser's request timeout.
  for (let offset = 0; offset < records.length; offset += 4) {
    if (Date.now() >= deadline) {
      errors.push(`其余 ${records.length - offset} 支股票的股息尚未查询，请再次刷新`);
      break;
    }
    await Promise.all(records.slice(offset, offset + 4).map(async stock => {
      try {
        if (!source.fetchDividends) throw new Error("分红来源未配置");
        snapshots.set(stock.id!, await source.fetchDividends(stock));
      } catch { errors.push(`${stock.code}：未获取到可核实的完整年度股息，保留原股息与明细`); }
    }));
  }
  return snapshots;
}

/** Refresh the single local portfolio without overwriting concurrent edits. */
export async function refreshStocks(db: SqliteDatabase, records: StockRecord[], source: Providers) {
  if (!records.length) throw new HttpError(400, "请先添加股票");
  const errors: string[] = [];
  const [quoteResult, dividends, fxResult] = await Promise.all([
    source.fetchQuotes(records).catch(() => ({ quotes: new Map(), errors: ["腾讯行情请求失败，保留旧报价"] })),
    dividendSnapshots(records, source, errors),
    records.some(stock => stock.market === "HK") ? source.fetchFx().catch(() => null) : Promise.resolve(null),
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
    if (!row || row.code !== stock.code || row.market !== stock.market) {
      errors.push(`${stock.code}：刷新期间股票已修改或删除，跳过旧数据`); continue;
    }
    const current = readRow(row), patch: Record<string, unknown> = {};
    const quote = quoteResult.quotes.get(stock.id!), snapshot = dividends.get(stock.id!);
    const applyQuote = Boolean(quote) && unchanged(stock, current, QUOTE_FIELDS);
    const applyDividends = Boolean(snapshot) && unchanged(stock, current, DIVIDEND_FIELDS);
    if (quote && !applyQuote) errors.push(`${stock.code}：刷新期间报价已修改，保留手动修改`);
    if (snapshot && !applyDividends) errors.push(`${stock.code}：刷新期间股息已修改，保留手动修改`);
    if (!applyQuote && !applyDividends) continue;
    if (applyQuote) Object.assign(patch, quote);
    if (applyDividends) Object.assign(patch, snapshot, { verification_note: null });
    Object.assign(patch, { updated_at: now, _refresh_id: marker,
      source: applyDividends ? `${applyQuote ? "腾讯实时行情；" : "报价来自保存数据；"}东方财富公开分红资料` : "腾讯实时行情；分红及历史来自保存数据" });
    changes.push({ stock, applyQuote, applyDividends, statement: db.prepare("UPDATE stocks SET document=json_patch(document,?) " +
      "WHERE id=? AND code=? AND market=? AND document=?")
      .bind(JSON.stringify(patch), stock.id!, stock.code, stock.market, row.document) });
  }
  if (!changes.length) return json({ message: "刷新未更新任何数据，原值保持不变", updated: 0, quotes_updated: 0, dividends_updated: 0, errors }, 502);
  const matched = "FROM stocks WHERE json_extract(document,'$._refresh_id')=?";
  const setMeta = (key: string, value: unknown, filter = "") => db.prepare("INSERT INTO metadata(key,value) " +
    `SELECT ?,? WHERE EXISTS(SELECT 1 ${matched}${filter}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(key, JSON.stringify(value), marker);
  const metadata = [setMeta("last_refresh", now)];
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
  return json({ message: updated ? `已更新 ${updated} 支股票：行情 ${quotesUpdated} 支，股息 ${dividendsUpdated} 支` : "刷新期间数据已变更，原值保持不变",
    updated, quotes_updated: quotesUpdated, dividends_updated: dividendsUpdated, errors }, updated ? 200 : 502);
}
