export type IndexBar = { date: string; close: number };
export type MarketPoint = {
  date: string;
  start_date: string;
  dividend_return: number;
  a500_return: number;
  spread: number;
};
export type MarketSnapshot = {
  window: 40;
  series: MarketPoint[];
  latest: MarketPoint;
  fetched_at: string;
  source: string;
  source_url: string;
  cached: boolean;
  stale: boolean;
  warning: string | null;
};
