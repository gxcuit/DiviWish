import type { D1Database } from "@cloudflare/workers-types";

// Database/config bindings come from `npm run cf:types`; secrets stay optional so
// missing configuration can fail closed with a useful response.
export type Env = Pick<WorkerBindings, "DB" | "APP_ORIGIN" | "AUTH_EMAIL_MODE"> & Partial<Pick<WorkerBindings, "APP_ALLOWED_ORIGINS">> & {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AUTH_SECRET?: string;
  LINUXDO_CLIENT_ID?: string;
  LINUXDO_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_OTP_TEMPLATE_ID?: string;
  RESEND_TEST_RECIPIENT?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

export type User = { id: string; email: string | null; created_at: number; hasPassword: boolean; linuxdoUsername: string | null };

// Archived D1 implementation, used only by historical regression tests.
export interface LegacyEnv {
  DB: D1Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  APP_USERNAME?: string;
  APP_PASSWORD?: string;
}

export type RollingWindowStatus = "overlap" | "gap" | "no_cash" | "before_first";
export interface HistoryRow {
  date: string; yield: number; close: number; annual?: number; year?: number; rolling_yield?: number;
  window_status?: RollingWindowStatus;
}

export interface StockRecord extends Record<string, unknown> {
  id?: number;
  instrument_type?: "stock" | "etf";
  exchange?: "sh" | "sz" | "bj" | "hk" | null;
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
  history: HistoryRow[];
  connect_factor: number | null;
  grid_start: number;
  grid_end: number;
  grid_step: number;
  grid_sell_start: number;
  grid_sell_end: number;
  yield_basis: "annual" | "rolling" | "custom";
  forecast_snapshot?: unknown;
  forecast_manual?: unknown;
  forecast_error?: string | null;
  custom_yield: number | null; // Archived legacy percentage; never used in calculations.
  custom_dividend: number | null;
  custom_dividend_currency: "CNY" | "HKD" | null;
  custom_dividend_note: string;
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
  annual_dividend: number | null;
  rolling_dividend: number | null;
  annual_year: number;
  confirmed: boolean;
  ex_dividend_date: string | null;
  dividends: { period: string; dps: number; status: string; date?: string; record_date?: string; pay_date?: string; notice_date?: string; plan_notice_date?: string; hkd_dps?: number }[];
  next_ex_dividend_date?: string | null;
  dividend_calendar_dates?: string[];
  dividend_splits?: { rows: { date: string; ratio: number }[]; warning: boolean };
  dividend_verification?: "matched" | "mismatch" | "unavailable";
  dividend_note?: string;
  dividend_as_of?: string;
  dividend_annual_start?: string;
  dividend_annual_end?: string;
  dividend_rolling_start?: string;
  dividend_source: string;
  dividend_updated_at: string;
  dividend_fx_rate: number | null;
  dividend_hkd_annual?: number;
  dividend_hkd_rolling?: number;
  annual_eps?: number | null;
  annual_eps_year?: number | null;
  annual_eps_currency?: string | null;
  payout_dividend?: number | null;
  payout_currency?: string | null;
}

export type Quote = { price: number; change_pct?: number | null; quote_date: string | null;
  year_start_price?: number | null; year_start_date?: string | null; year_start_year?: number | null; year_start_adjustment?: string | null };
export type Period = "day" | "week" | "month";
export type Bar = { date: string; close: number };
export type Kline = { bars: Bar[]; adjustment: "qfq" | "none"; quote: Quote | null };
export type Suggestion = Pick<StockRecord, "name" | "code" | "market" | "instrument_type" | "exchange">;
export interface HistorySnapshot {
  history: HistoryRow[];
  history_status?: "ready" | "not_applicable";
  history_version?: number;
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
