import { derive, yieldGrid } from "./calculations.ts";
import type { StockRecord } from "./types.ts";

export function render(stock: StockRecord, records: StockRecord[], meta: Record<string, unknown>, detail = false) {
  const prices = Object.fromEntries(records.filter(row => row.market === "A" && row.price).map(row => [row.code, row.price! ]));
  const result: Record<string, unknown> = derive(stock, meta.fx_rate, prices);
  delete result._refresh_id;
  delete result.connect_factor;
  delete result.a_price;
  if (detail) result.yield_grid = yieldGrid(stock, meta.fx_rate);
  else { delete result.dividends; delete result.history; }
  return result;
}
