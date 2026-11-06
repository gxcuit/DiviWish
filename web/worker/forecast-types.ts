export type ForecastCurrency = "CNY" | "HKD" | "USD";
export interface ForecastEvidence {
  url: string;
  title: string;
  date: string;
  page?: number;
  excerpt?: string;
}
export interface ForecastCommitment {
  kind: "per_share" | "total" | "ratio";
  value: number;
  currency: ForecastCurrency;
  start_year: number;
  end_year: number;
  lower_bound: boolean;
  conditions: string;
  profit_basis?: "parent" | "ordinary";
  shares?: number;
  evidence: ForecastEvidence;
  approved: boolean;
}
export interface ForecastReconciliationInput {
  currency: ForecastCurrency;
  parent_profit: number | null;
  equity_deduction: number | null;
  weighted_shares: number | null;
  participating_shares: number;
  source_url: string;
  conditions: string;
}
export interface ForecastManual {
  commitment: ForecastCommitment | null;
  payout_ratio: number | null;
  reconciliation?: ForecastReconciliationInput | null;
  year: number;
}
export interface ForecastFinancial {
  period: string;
  start: string;
  currency: ForecastCurrency;
  eps: number | null;
  profit: number | null;
  shares: number | null;
  ordinary_profit?: number | null;
  equity_deduction?: number | null;
  weighted_shares?: number | null;
  equity_status?: "none_reported" | "present" | "unknown";
  equity_balance?: number | null;
  treasury_balance?: number | null;
  balance_source?: string;
  notice_date: string;
  source: string;
}
export interface ForecastConsensus {
  year: number;
  eps: number;
  currency: ForecastCurrency;
  profit?: number | null;
  updated_at: string;
  analysts: number;
  source: string;
}
export type ForecastDividendStatus = "implemented" | "approved" | "proposed" | "conditional" | "cancelled" | "unknown";
export interface ForecastDividend {
  period: string;
  amount: number | null;
  status?: ForecastDividendStatus;
  lower_bound?: boolean;
  participating_shares?: number | null;
  ex_date?: string;
  record_date?: string;
  pay_date?: string;
  currency: ForecastCurrency;
  special: boolean;
  ambiguous: boolean;
  complete: boolean;
  evidence: ForecastEvidence;
}
export interface ForecastAnnouncement extends ForecastEvidence { id: string }
export interface ForecastSearchQuery { market: "A" | "HK"; stock_id: string; term: string; page: number }
export interface ForecastSearch {
  status: "not_found" | "review" | "found" | "failed" | "partial";
  from: string;
  to: string;
  pending: ForecastAnnouncement[];
  continuations?: ForecastSearchQuery[];
  reviewed: ForecastEvidence[];
  notes: string[];
}
export interface ForecastSnapshot {
  year: number;
  fetched_at: string;
  data_stale?: boolean;
  fiscal_end: string | null;
  financials: ForecastFinancial[];
  consensus: ForecastConsensus | null;
  dividends: ForecastDividend[];
  commitments: ForecastCommitment[];
  search: ForecastSearch;
  errors: string[];
  fx: { USD?: number };
}
export interface ForecastReconciliation {
  status: "matched" | "approximation" | "review";
  parent_profit: number | null;
  ordinary_profit: number | null;
  equity_deduction: number | null;
  weighted_shares: number | null;
  participating_shares: number | null;
  share_basis: string;
  reason: string;
}
export interface ForecastDistribution {
  events: ForecastDividend[];
  implemented: number | null;
  approved: number | null;
  proposed: number | null;
  conditional: number | null;
  special: number | null;
  announced: number | null;
  remaining: number | null;
  remaining_kind: "estimate" | "lower_bound" | "unavailable";
  reason: string;
}
export interface ForecastResult {
  year: number;
  status: "ready" | "lower_bound" | "unavailable" | "conflict" | "unsupported";
  reconciliation: ForecastReconciliation;
  distribution: ForecastDistribution;
  dividend: number | null;
  currency: ForecastCurrency;
  yield: number | null;
  basis: "plan" | "commitment" | "historical" | "manual" | null;
  earnings_basis: "actual" | "consensus" | "ttm" | "manual" | null;
  earnings_currency: ForecastCurrency | null;
  conversion_rate: number | null;
  commitment: ForecastCommitment | null;
  eps: number | null;
  profit_per_share: number | null;
  payout_ratio: number | null;
  payout_years: number[];
  earnings_period: string | null;
  formula: string;
  reason: string;
  notes: string[];
  sources: ForecastEvidence[];
  updated_at: string | null;
  stale: boolean;
  search: Omit<ForecastSearch, "pending" | "continuations"> & { remaining: number };
}
