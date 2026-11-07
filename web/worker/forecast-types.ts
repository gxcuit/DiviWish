export type ForecastCurrency = "CNY" | "HKD";
export interface ForecastManualInput {
  year: number;
  kind: "per_share" | "yield";
  value: number;
  currency: ForecastCurrency;
  note: string;
}
export interface ForecastManual extends ForecastManualInput {
  dividend: number;
  reference_price: number | null;
  updated_at: string;
}
export interface ForecastResult {
  year: number;
  status: "ready" | "unavailable" | "unsupported";
  dividend: number | null;
  currency: ForecastCurrency;
  yield: number | null;
  basis: "manual" | null;
  formula: string;
  reason: string;
  note: string;
  updated_at: string | null;
}
