import { dailyForecast } from "./forecast-cache.ts";
import { bodyJson, HttpError, json } from "./http.ts";
import { render } from "./render.ts";
import type { Providers, SqliteDatabase, StockRecord } from "./types.ts";

interface Store {
  stock(id: number): Promise<StockRecord | undefined>;
  stocks(): Promise<StockRecord[]>;
  meta(): Promise<Record<string, unknown>>;
  save(stock: StockRecord, previous?: StockRecord): Promise<number | null>;
}
export async function forecastResponse(request: Request, url: URL, stock: StockRecord, store: Store, db: SqliteDatabase, source: Providers) {
  if (stock.instrument_type === "etf") throw new HttpError(400, "ETF 不适用个股盈利分红预估");
  if (request.method === "GET") return json(render(stock, await store.stocks(), await store.meta(), true));
  if (request.method !== "POST") throw new HttpError(405, "请使用 GET 查看或 POST 刷新预估");
  await bodyJson(request);
  let snapshot;
  try { snapshot = (await dailyForecast(db, stock, source, url.searchParams.get("refresh") === "1")).snapshot; }
  catch (error) {
    const current = await store.stock(stock.id!);
    if (current && current.code === stock.code && current.market === stock.market && current.instrument_type === stock.instrument_type) {
      await store.save({ ...current, forecast_error: error instanceof Error ? error.message : "预估刷新失败" }, current);
    }
    throw new HttpError(502, `预估刷新失败：${error instanceof Error ? error.message : "来源暂不可用"}；已保留旧快照。`);
  }
  const current = await store.stock(stock.id!);
  if (!current || ["code", "market", "instrument_type", "exchange", "forecast_manual"].some(key => JSON.stringify(current[key]) !== JSON.stringify(stock[key]))) throw new HttpError(409, "刷新期间证券或人工参数已修改，跳过旧预估，请重试");
  if (await store.save({ ...current, forecast_snapshot: snapshot, forecast_error: null }, current) === null) throw new HttpError(409, "股票已变更，请重试预估");
  return json(render((await store.stock(stock.id!))!, await store.stocks(), await store.meta(), true));
}
