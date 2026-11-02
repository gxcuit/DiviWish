import { validate } from "./validation.ts";
import type { StockRecord } from "./types.ts";

/** New portfolios start with identities only; prices and dividends need a refresh. */
export function starterStocks(): StockRecord[] {
  return [
    { code: "600036", name: "招商银行", sector: "银行", instrument_type: "stock" },
    { code: "510880", name: "红利ETF华泰柏瑞", sector: "ETF", instrument_type: "etf" },
  ].map(stock => ({ ...validate({ ...stock, market: "A", exchange: "sh", watched: false }),
    source: "默认观察标的；请刷新行情与股息" }));
}
