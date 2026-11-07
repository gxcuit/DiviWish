import { HttpError, json } from "./http.ts";
import { render } from "./render.ts";
import type { StockRecord } from "./types.ts";
interface Store {
  stocks(): Promise<StockRecord[]>;
  meta(): Promise<Record<string, unknown>>;
}
/** The former refresh route remains explicit for old tabs; it performs no upstream requests or writes. */
export async function forecastResponse(request: Request, stock: StockRecord, store: Store) {
  if (stock.instrument_type === "etf") throw new HttpError(400, "ETF 不适用个股预估口径");
  if (request.method === "GET") return json(render(stock, await store.stocks(), await store.meta(), true));
  if (request.method === "POST") throw new HttpError(410, "自动预估已移除，请在个股详情手动添加预估值");
  throw new HttpError(405, "请使用 GET 查看，或通过股票设置保存手动预估");
}
