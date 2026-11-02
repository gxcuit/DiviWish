import type { D1Database } from "@cloudflare/workers-types";
import { document } from "./database.ts";
import { starterStocks } from "./starter-portfolio.ts";

/** Append only to the transaction that creates a new account, never to login. */
export function starterPortfolioStatements(db: D1Database, userId: string) {
  const pending = "EXISTS(SELECT 1 FROM user_metadata WHERE user_id=? AND key='starter_portfolio_v1' AND value='\"pending\"')";
  return [
    db.prepare("INSERT OR IGNORE INTO user_metadata(user_id,key,value) SELECT id,'starter_portfolio_v1','\"pending\"' FROM users " +
      "WHERE id=? AND NOT EXISTS(SELECT 1 FROM user_stocks WHERE user_id=?)").bind(userId, userId),
    ...starterStocks().map(stock => db.prepare("INSERT OR IGNORE INTO user_stocks(user_id,code,market,name,sector,watched,document) " +
      `SELECT ?,?,?,?,?,0,? WHERE ${pending}`).bind(userId, stock.code, stock.market, stock.name, stock.sector, document(stock), userId)),
    ...["未分类", "银行", "ETF"].map(sector => db.prepare(`INSERT OR IGNORE INTO user_sectors(user_id,name) SELECT ?,? WHERE ${pending}`).bind(userId, sector, userId)),
    db.prepare(`INSERT OR IGNORE INTO user_metadata(user_id,key,value) SELECT ?,'etf_sector_v1','true' WHERE ${pending}`).bind(userId, userId),
    db.prepare("UPDATE user_metadata SET value='true' WHERE user_id=? AND key='starter_portfolio_v1' AND value='\"pending\"'").bind(userId),
  ];
}

/** Add the new category once, preserving stocks, existing sectors and deletions. */
export async function ensureEtfSector(db: D1Database, userId: string) {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO user_sectors(user_id,name) SELECT ?,'ETF' " +
      "WHERE NOT EXISTS(SELECT 1 FROM user_metadata WHERE user_id=? AND key='etf_sector_v1')").bind(userId, userId),
    db.prepare("INSERT OR IGNORE INTO user_metadata(user_id,key,value) VALUES(?,'etf_sector_v1','true')").bind(userId),
  ]);
}
