import type { StockDetail } from "../types";

export function CustomDividendMetrics({ stock }: { stock: StockDetail }) {
  const etf = stock.instrument_type === "etf";
  const currency = stock.custom_dividend_currency ?? (stock.market === "HK" ? "HKD" : "CNY");
  return <>
    <div>
      <span>{etf ? "自定义每份分红" : "自定义每股股息"}</span>
      <strong>{stock.custom_dividend == null ? "未设置" : `${stock.custom_dividend} ${currency}`}</strong>
    </div>
    <div>
      <span>{etf ? "自定义派息率（估算）" : "自定义股息率（估算）"}</span>
      <strong>{stock.custom_dividend_yield == null ? "—" : `${(stock.custom_dividend_yield * 100).toFixed(2)}%`}</strong>
    </div>
  </>;
}
