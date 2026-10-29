import type { D1Database } from "@cloudflare/workers-types";
import { DEFAULT_STOCK } from "./validation.ts";
import type { StockRecord, StockRow } from "./types.ts";

export function readRow(row: StockRow): StockRecord {
  return { ...structuredClone(DEFAULT_STOCK), ...JSON.parse(row.document),
    id: row.id, code: row.code, market: row.market, name: row.name, sector: row.sector, watched: Boolean(row.watched) };
}

export function document(stock: StockRecord): string {
  return JSON.stringify(Object.fromEntries(Object.entries(stock).filter(([key]) =>
    !["id", "code", "market", "name", "sector", "watched"].includes(key))));
}

export async function initialize(db: D1Database) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sectors(name) SELECT sector FROM stocks GROUP BY sector ORDER BY MIN(id)"),
    db.prepare("INSERT OR IGNORE INTO sectors(name) VALUES('未分类')"),
    db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('initialized','true')"),
  ]);
}

export async function rawStocks(db: D1Database): Promise<StockRecord[]> {
  const rows = await db.prepare("SELECT * FROM stocks ORDER BY id").all<StockRow>();
  return rows.results.map(readRow);
}

export async function getStock(db: D1Database, id: number): Promise<StockRecord | undefined> {
  const row = await db.prepare("SELECT * FROM stocks WHERE id=?").bind(id).first<StockRow>();
  return row ? readRow(row) : undefined;
}

export async function metadata(db: D1Database): Promise<Record<string, unknown>> {
  const rows = await db.prepare("SELECT key,value FROM metadata").all<{ key: string; value: string }>();
  return Object.fromEntries(rows.results.map(row => [row.key, JSON.parse(row.value)]));
}

export function setMeta(db: D1Database, key: string, value: unknown) {
  return db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, JSON.stringify(value));
}

export async function sectorRecords(db: D1Database) {
  return (await db.prepare("SELECT sectors.id,sectors.name,count(stocks.id) AS stock_count FROM sectors " +
    "LEFT JOIN stocks ON stocks.sector=sectors.name GROUP BY sectors.id ORDER BY sectors.id")
    .all<{ id: number; name: string; stock_count: number }>()).results;
}

export async function saveStock(db: D1Database, stock: StockRecord, previous?: StockRecord) {
  const serialized = document(stock);
  let update;
  // The stored JSON may predate defaults; compare the original bytes rather than reserializing them.
  if (previous) {
    const original = await db.prepare("SELECT * FROM stocks WHERE id=?").bind(previous.id!).first<StockRow>();
    if (!original || JSON.stringify(readRow(original)) !== JSON.stringify(previous)) return null;
    update = db.prepare("UPDATE stocks SET code=?,market=?,name=?,sector=?,watched=?,document=? WHERE id=? " +
      "AND code=? AND market=? AND name=? AND sector=? AND watched=? AND document=?")
      .bind(stock.code, stock.market, stock.name, stock.sector, Number(stock.watched), serialized, stock.id!,
        previous.code, previous.market, previous.name, previous.sector, Number(previous.watched), original.document);
  } else update = db.prepare("INSERT INTO stocks(code,market,name,sector,watched,document,imported) VALUES(?,?,?,?,?,?,0)")
    .bind(stock.code, stock.market, stock.name, stock.sector, Number(stock.watched), serialized);
  const results = await db.batch([update,
    db.prepare("INSERT OR IGNORE INTO sectors(name) SELECT sector FROM stocks WHERE code=? AND market=?")
      .bind(stock.code, stock.market)]);
  if (previous && !results[0].meta.changes) return null;
  return previous ? previous.id! : results[0].meta.last_row_id;
}

export { render } from "./render.ts";
