export interface DividendPart {
  period: string;
  dps: number;
  status: string;
  date?: string;
}

export interface StockPreview {
  code: string;
  market: "A" | "HK";
  quote: { price: number; quote_date: string | null } | null;
  dividends: { annual_dividend: number; annual_year: number; ex_dividend_date: string | null; confirmed: boolean } | null;
  errors: string[];
}

export interface Stock {
  history_updated_at?: string;
  history_note?: string;
  history_source?: string;
  yield_basis: YieldBasis;
  custom_yield: number | null;
  selected_yield: number | null;
  basis_dividend: number | null;
  grid_start: number;
  grid_end: number;
  grid_step: number;
  id: number;
  code: string;
  name: string;
  sector: string;
  market: 'A' | 'HK';
  price: number | null;
  change_pct: number | null;
  annual_dividend: number | null;
  rolling_dividend: number | null;
  target_yield: number | null;
  dividend_yield: number | null;
  rolling_yield: number | null;
  target_price: number | null;
  yield_gap: number | null;
  status: 'green' | 'blue' | 'orange' | 'neutral';
  confirmed: boolean;
  ex_dividend_date: string | null;
  watched: boolean;
  quote_date: string | null;
  updated_at: string | null;
  annual_year: number | null;
  year_start_price: number | null;
  year_change: number | null;
  percentile: number | null;
  percentile_start: string | null;
  percentile_end: string | null;
  percentile_count: number;
  quantile_60_yield: number | null;
  quantile_60_price: number | null;
  quantile_90_yield: number | null;
  quantile_90_price: number | null;
  ah_premium: number | null;
  hk_net_yield: number | null;
  connect_yield: number | null;
  a_code: string | null;
  source: string;
  verification_note: string | null;
}

export interface StockDetail extends Stock {
  yield_grid: { yield: number; price: number | null; reached: boolean | null }[];
  dividends: DividendPart[];
  history: { date: string; yield: number; close: number }[];
}

export interface GridSettings {
  grid_start: number;
  grid_end: number;
  grid_step: number;
}

export type YieldBasis = 'annual' | 'rolling' | 'custom';

export interface YieldBasisSettings {
  yield_basis: YieldBasis;
  custom_yield: number | null;
}

export interface StocksResponse {
  stocks: Stock[];
  sectors: string[];
  meta: {
    quote_date: string | null;
    imported_at: string | null;
    last_refresh: string | null;
    fx_rate: number | null;
    source: string;
  };
}

export type BollPosition = 'below_lower' | 'at_lower' | 'lower_half' | 'at_middle' | 'upper_half' | 'at_upper' | 'above_upper' | 'flat' | 'unknown';

interface BollFrameBase {
  period: 'day' | 'week' | 'month';
  label: string;
  adjustment?: 'qfq' | 'none';
}

export interface BollBand extends BollFrameBase {
  available: true;
  count: number;
  lower: number;
  middle: number;
  upper: number;
  start_date: string;
  last_date: string;
  position: BollPosition;
  percent_b: number | null;
}

export interface BollResponse {
  window: number;
  multiplier: number;
  price: number | null;
  quote_date: string | null;
  price_source: string;
  source: string;
  cached: boolean;
  fetched_at: string;
  bands: (BollBand | (BollFrameBase & { available: false; error: string; count?: number }))[];
}
