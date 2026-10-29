// The local SQLite adapter supplies asynchronous statement methods to the API.
export interface SqliteStatement {
  bind(...values: (string | number | null)[]): SqliteStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<SqliteResult>;
}
export interface SqliteResult {
  meta: { changes: number; last_row_id: number };
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  batch(statements: SqliteStatement[]): Promise<SqliteResult[]>;
}
export interface Env {
  DB: SqliteDatabase;
  APP_ORIGIN?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export interface StockRecord extends Record<string, unknown> {
  id?: number;
  code: string;
  market: "A" | "HK";
  name: string;
  sector: string;
  watched: boolean;
  price: number | null;
  change_pct: number | null;
  annual_dividend: number | null;
  rolling_dividend: number | null;
  target_yield: number | null;
  confirmed: boolean;
  ex_dividend_date: string | null;
  quote_date: string | null;
  updated_at: string | null;
  annual_year: number | null;
  year_start_price: number | null;
  percentile_start: string | null;
  percentile_end: string | null;
  a_code: string | null;
  source: string;
  verification_note: string | null;
  dividends: Record<string, unknown>[];
  history: { date: string; yield: number; close: number }[];
  connect_factor: number | null;
  grid_start: number;
  grid_end: number;
  grid_step: number;
  yield_basis: "annual" | "rolling" | "custom";
  custom_yield: number | null;
}

export interface StockRow {
  id: number;
  code: string;
  market: "A" | "HK";
  name: string;
  sector: string;
  watched: number;
  imported: number;
  document: string;
}

export interface DividendSnapshot {
  annual_dividend: number;
  rolling_dividend: number;
  annual_year: number;
  confirmed: boolean;
  ex_dividend_date: string | null;
  dividends: { period: string; dps: number; status: string; date?: string; hkd_dps?: number }[];
  dividend_source: string;
  dividend_updated_at: string;
  dividend_fx_rate: number | null;
  dividend_hkd_annual?: number;
  dividend_hkd_rolling?: number;
}

export type Quote = { price: number; change_pct?: number | null; quote_date: string | null };
export type Period = "day" | "week" | "month";
export type Bar = { date: string; close: number };
export type Kline = { bars: Bar[]; adjustment: "qfq" | "none"; quote: Quote | null };
export type Suggestion = Pick<StockRecord, "name" | "code" | "market">;
export interface HistorySnapshot {
  history: { date: string; yield: number; close: number; annual: number; year: number }[];
  percentile_start: string;
  percentile_end: string;
  history_source: string;
  history_updated_at: string;
  history_note: string;
}
export type DividendEvent = { period: string; available: string; cash: number };
export interface Providers {
  fetchHistory?(stock: StockRecord): Promise<HistorySnapshot>;
  fetchDividends?(stock: StockRecord): Promise<DividendSnapshot>;
  searchStocks(query: string): Promise<Suggestion[]>;
  fetchQuotes(stocks: StockRecord[]): Promise<{ quotes: Map<number, Quote>; errors: string[] }>;
  fetchFx(): Promise<number>;
  fetchKline(stock: StockRecord, period: Period): Promise<Kline>;
}
