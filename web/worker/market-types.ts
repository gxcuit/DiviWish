import type { MarketSelection } from "./market-indices.ts";

export type IndexBar = { date: string; close: number };
export type MarketPoint = {
  date: string;
  start_date: string;
  /** Legacy API key: the return of selected A. */
  dividend_return: number;
  /** Legacy API key: the return of selected B. */
  a500_return: number;
  spread: number;
};
export type MarketSnapshot = {
  window: 40;
  selection: MarketSelection;
  series: MarketPoint[];
  latest: MarketPoint;
  relative: RelativeSnapshot;
  regression: RegressionSnapshot | null;
  fetched_at: string;
  source: string;
  source_url: string;
  cached: boolean;
  stale: boolean;
  warning: string | null;
};

export type RelativePoint = {
  date: string;
  ratio: number;
  middle: number | null;
  upper: number | null;
  lower: number | null;
  percent_b: number | null;
  bandwidth: number | null;
};
export type RelativeSnapshot = {
  window: 242;
  multiplier: 2;
  base_date: string;
  series: RelativePoint[];
  latest: RelativePoint;
};
export type RegressionPoint = { date: string; close: number; fitted: number; lower: number; upper: number };
export type RegressionSnapshot = {
  start_date: string;
  end_date: string;
  count: number;
  band_multiplier: 1.5;
  r_squared: number | null;
  annualized_return: number;
  annualized_volatility: number | null;
  residual_sigma: number;
  series: RegressionPoint[];
  latest: RegressionPoint;
};
