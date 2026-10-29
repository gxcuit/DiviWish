import { getStock, metadata, rawStocks, saveStock, sectorRecords, setMeta } from "./database.ts";
import type { SqliteDatabase, StockRecord } from "./types.ts";

export function portfolio(db: SqliteDatabase) {
  return {
    stocks: () => rawStocks(db),
    stock: (id: number) => getStock(db, id),
    meta: () => metadata(db),
    sectors: () => sectorRecords(db),
    save: (stock: StockRecord, previous?: StockRecord) => saveStock(db, stock, previous),
    setMeta: (key: string, value: unknown) => setMeta(db, key, value),
    remove: (id: number) => db.prepare("DELETE FROM stocks WHERE id=?").bind(id).run(),
  };
}
