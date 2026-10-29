import type { D1Database } from "@cloudflare/workers-types";
import { document, readRow } from "./database.ts";
import type { StockRecord, StockRow } from "./types.ts";

// Every operation requires an owner supplied by the verified server-side session.
export function portfolio(db: D1Database, userId: string) {
  const prepare = (sql: string) => db.prepare(sql);
  return {
    async stocks(): Promise<StockRecord[]> {
      const rows = await prepare("SELECT * FROM user_stocks WHERE user_id=? ORDER BY id").bind(userId).all<StockRow>();
      return rows.results.map(readRow);
    },
    async stock(id: number): Promise<StockRecord | undefined> {
      const row = await prepare("SELECT * FROM user_stocks WHERE user_id=? AND id=?").bind(userId, id).first<StockRow>();
      return row ? readRow(row) : undefined;
    },
    async meta(): Promise<Record<string, unknown>> {
      const rows = await prepare("SELECT key,value FROM user_metadata WHERE user_id=?").bind(userId).all<{ key: string; value: string }>();
      return Object.fromEntries(rows.results.map(row => [row.key, JSON.parse(row.value)]));
    },
    setMeta(key: string, value: unknown) {
      return prepare("INSERT INTO user_metadata(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
        .bind(userId, key, JSON.stringify(value));
    },
    async sectors() {
      return (await prepare("SELECT s.id,s.name,count(t.id) AS stock_count FROM user_sectors s " +
        "LEFT JOIN user_stocks t ON t.user_id=s.user_id AND t.sector=s.name WHERE s.user_id=? GROUP BY s.id ORDER BY s.id")
        .bind(userId).all<{ id: number; name: string; stock_count: number }>()).results;
    },
    async save(stock: StockRecord, previous?: StockRecord) {
      let update;
      if (previous) {
        const original = await prepare("SELECT * FROM user_stocks WHERE user_id=? AND id=?").bind(userId, previous.id!).first<StockRow>();
        if (!original || JSON.stringify(readRow(original)) !== JSON.stringify(previous)) return null;
        update = prepare("UPDATE user_stocks SET code=?,market=?,name=?,sector=?,watched=?,document=? WHERE user_id=? AND id=? " +
          "AND code=? AND market=? AND name=? AND sector=? AND watched=? AND document=?")
          .bind(stock.code, stock.market, stock.name, stock.sector, Number(stock.watched), document(stock), userId, stock.id!,
            previous.code, previous.market, previous.name, previous.sector, Number(previous.watched), original.document);
      } else update = prepare("INSERT INTO user_stocks(user_id,code,market,name,sector,watched,document) VALUES(?,?,?,?,?,?,?)")
        .bind(userId, stock.code, stock.market, stock.name, stock.sector, Number(stock.watched), document(stock));
      const results = await db.batch([update, prepare("INSERT OR IGNORE INTO user_sectors(user_id,name) " +
        "SELECT user_id,sector FROM user_stocks WHERE user_id=? AND code=? AND market=?").bind(userId, stock.code, stock.market)]);
      if (previous && !results[0].meta.changes) return null;
      return previous ? previous.id! : results[0].meta.last_row_id;
    },
    async remove(id: number) {
      return prepare("DELETE FROM user_stocks WHERE user_id=? AND id=?").bind(userId, id).run();
    },
  };
}
