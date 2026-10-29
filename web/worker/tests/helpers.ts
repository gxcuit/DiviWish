import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SqliteDatabase } from "../types.ts";
import type { Env, Providers, StockRecord } from "../types.ts";
import { DEFAULT_STOCK } from "../validation.ts";
import { document } from "../database.ts";
import { createHandler } from "../index.ts";

// Real SQLite queries and transactions for API regressions. No personal files are used.
export class TestDatabase {
  sqlite: DatabaseSync;
  constructor(filename = ":memory:") {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec(readFileSync(new URL("../../migrations/0001_initial.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    const sqlite = this.sqlite;
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...args: (string | number | null)[]) { values = args; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
      async run() {
        const info = sqlite.prepare(sql).run(...values);
        return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return statement;
  }
  async batch(statements: ReturnType<TestDatabase["prepare"]>[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  get binding() { return this as unknown as SqliteDatabase; }
}

export function sampleStocks(): StockRecord[] {
  return [
    { ...structuredClone(DEFAULT_STOCK), watched: false, id: 1, market: "A", code: "600001", name: "测试股票", sector: "银行", price: 10,
      annual_dividend: 0.5, rolling_dividend: 0.6, target_yield: 0.05, confirmed: true,
      quote_date: "2026-10-20", updated_at: "2026-10-20T18:00:00+08:00", percentile_start: "2021-10-20", percentile_end: "2026-10-20",
      history: Array.from({ length: 80 }, (_, index) => ({ date: `2026-${String(6 + Math.floor(index / 28)).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`, yield: [0.02, 0.03, 0.05, 0.06][index % 4], close: 10 })),
      dividends: [{ period: "2025-12-31", dps: 0.5, status: "实施分配", date: "2026-07-01" }] },
    { ...structuredClone(DEFAULT_STOCK), watched: false, id: 2, market: "HK", code: "00001", a_code: "600001", name: "测试港股", sector: "银行", price: 8,
      annual_dividend: 0.5, rolling_dividend: 0.6, target_yield: 0.05, connect_factor: 0.72,
      quote_date: "2026-10-20", updated_at: "2026-10-20T18:00:00+08:00" },
  ];
}

export function seed(db: TestDatabase) {
  for (const stock of sampleStocks()) db.sqlite.prepare(
    "INSERT INTO stocks(id,code,market,name,sector,watched,imported,document) VALUES(?,?,?,?,?,?,?,?)")
    .run(stock.id!, stock.code, stock.market, stock.name, stock.sector, Number(stock.watched), 1, document(stock));
  for (const [key, value] of Object.entries({ fx_rate: 0.8, quote_date: "2026-10-20", imported_at: "2026-10-20T18:00:00+08:00", last_refresh: null, source: "test fixture" })) {
    db.sqlite.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(key, JSON.stringify(value));
  }
}

export function candles(count = 30) {
  return Array.from({ length: count }, (_, index) => ({ date: `2026-01-${String(index + 1).padStart(2, "0")}`, close: index + 1 }));
}
export function fixture(overrides: Partial<Providers> = {}) {
  const db = new TestDatabase(); seed(db);
  const source: Providers = {
    searchStocks: async () => [], fetchFx: async () => 0.8,
    fetchQuotes: async () => ({ quotes: new Map(), errors: ["test timeout"] }),
    fetchKline: async () => ({ bars: candles(), adjustment: "qfq", quote: { price: 28, quote_date: "2026-01-30" } }),
    ...overrides,
  };
  const handler = createHandler(source), env: Env = { DB: db.binding };
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => handler(
    new Request(`http://localhost${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { db, source, handler, env, request };
}
