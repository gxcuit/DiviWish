import type { D1Database } from "@cloudflare/workers-types";
import { BollingerService } from "./bollinger.ts";
import { getStock, initialize, metadata, rawStocks, render, saveStock, sectorRecords } from "./database.ts";
import { providers } from "./providers.ts";
import { sectorName, timestamp, validate } from "./validation.ts";
import type { LegacyEnv, Providers, Suggestion } from "./types.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function authorize(request: Request, env: LegacyEnv): Promise<Response | null> {
  if (!env.APP_USERNAME || !env.APP_PASSWORD) {
    if (!env.APP_USERNAME && !env.APP_PASSWORD && loopback(new URL(request.url).hostname)) return null;
    return json({ error: "请先配置 APP_USERNAME 和 APP_PASSWORD，网站尚未开放访问" }, 503);
  }
  let supplied = "";
  try {
    const token = request.headers.get("Authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    if (token) supplied = new TextDecoder().decode(Uint8Array.from(atob(token), char => char.charCodeAt(0)));
  } catch { /* Invalid credentials receive the same response as missing credentials. */ }
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(supplied), digest(`${env.APP_USERNAME}:${env.APP_PASSWORD}`)]);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
  return difference === 0 ? null : new Response("请登录 DiviWish", {
    status: 401, headers: { "WWW-Authenticate": 'Basic realm="DiviWish", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

function protectWrites(request: Request) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return;
  const url = new URL(request.url), origin = request.headers.get("Origin");
  if (origin) {
    let allowed = false;
    try {
      const other = new URL(origin);
      allowed = other.origin === url.origin || (loopback(other.hostname) && loopback(url.hostname));
    } catch { /* A malformed Origin is untrusted. */ }
    if (!allowed) throw new HttpError(403, "仅允许同源页面修改数据");
  }
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") throw new HttpError(403, "不接受跨站写入请求");
  const mediaType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (request.method !== "DELETE" && mediaType !== "application/json" && !/^application\/.+\+json$/.test(mediaType)) {
    throw new HttpError(415, "请使用 application/json 请求");
  }
}

async function bodyJson(request: Request): Promise<unknown> {
  const limit = 128 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) throw new HttpError(413, "请求内容不能超过 128 KiB");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, "请求内容不能超过 128 KiB"); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, "JSON 格式无效"); }
}

function validated<T>(action: () => T): T {
  try { return action(); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "资料格式无效"); }
}

async function refresh(db: D1Database, source: Providers) {
  const records = await rawStocks(db);
  if (!records.length) return json({ message: "没有可刷新的股票", updated: 0, errors: ["请先添加股票"] }, 400);
  const errors: string[] = [];
  let result: Awaited<ReturnType<Providers["fetchQuotes"]>> = { quotes: new Map(), errors: [] };
  try { result = await source.fetchQuotes(records); errors.push(...result.errors); }
  catch { errors.push("腾讯行情请求失败，保留旧报价"); }
  let fxRate: number | null = null;
  if (result.quotes.size && records.some(stock => stock.market === "HK")) {
    try { fxRate = await source.fetchFx(); }
    catch { errors.push("汇率请求失败，沿用原汇率"); }
  }
  if (!result.quotes.size) return json({ message: "刷新失败，报价和更新时间保持不变", updated: 0, errors: errors.length ? errors : ["没有收到有效行情"] }, 502);
  const now = timestamp();
  const changes = records.filter(stock => result.quotes.has(stock.id!));
  // Merge only quote fields in SQL: edits/watchlist/sector changes during network I/O survive.
  const quoteUpdates = changes.map(stock => db.prepare(
    "UPDATE stocks SET document=json_patch(document,?) WHERE id=? AND code=? AND market=?")
    .bind(JSON.stringify({ ...result.quotes.get(stock.id!), updated_at: now,
      source: "腾讯实时行情；分红及历史样本来自保存数据" }), stock.id!, stock.code, stock.market));
  const identities = JSON.stringify(changes.map(stock => ({ id: stock.id, code: stock.code, market: stock.market,
    quote_date: result.quotes.get(stock.id!)?.quote_date })));
  const join = "FROM stocks JOIN json_each(?) incoming ON stocks.id=json_extract(incoming.value,'$.id') " +
    "AND stocks.code=json_extract(incoming.value,'$.code') AND stocks.market=json_extract(incoming.value,'$.market')";
  const metaUpdate = (key: string, value: unknown) => db.prepare(
    `INSERT INTO metadata(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 ${join}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(key, JSON.stringify(value), identities);
  const metaUpdates = [metaUpdate("last_refresh", now)];
  if (fxRate !== null) metaUpdates.push(metaUpdate("fx_rate", fxRate));
  metaUpdates.push(db.prepare(`INSERT INTO metadata(key,value) SELECT 'quote_date',json_quote(MAX(json_extract(incoming.value,'$.quote_date'))) ${join} ` +
    "HAVING MAX(json_extract(incoming.value,'$.quote_date')) IS NOT NULL ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(identities));
  // Quotes and freshness metadata commit together, and all-identity-change refreshes write no metadata.
  const updates = (await db.batch([...quoteUpdates, ...metaUpdates])).slice(0, changes.length);
  let updated = 0;
  updates.forEach((update, index) => {
    const stock = changes[index];
    if (update.meta.changes) {
      updated++;
    } else errors.push(`${stock.code}：刷新期间股票已修改或删除，跳过旧报价`);
  });
  if (!updated) return json({ message: "刷新期间标的已变更，没有应用旧报价", updated: 0, errors }, 502);
  return json({ message: `已更新 ${updated} 支股票行情${errors.length ? "，部分数据未更新" : ""}`, updated, errors });
}

export function createHandler(source: Providers = providers) {
  const bollinger = new BollingerService();
  // Per binding/isolate only. Schema changes are applied explicitly through Wrangler migrations.
  const initialized = new WeakMap<D1Database, Promise<void>>();
  async function ready(db: D1Database) {
    let pending = initialized.get(db);
    if (!pending) {
      pending = initialize(db).catch(error => { initialized.delete(db); throw error; });
      initialized.set(db, pending);
    }
    await pending;
  }

  return async function handle(request: Request, env: LegacyEnv): Promise<Response> {
    try {
      const denied = await authorize(request, env);
      if (denied) return denied;
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path === "/") return Response.redirect(new URL("/discovery", url), 302);
      if (!path.startsWith("/api/") && path !== "/api") return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
      protectWrites(request);
      await ready(env.DB);
      const db = env.DB;
      if (path === "/api/health" && method === "GET") {
        const count = await db.prepare("SELECT count(*) AS count FROM stocks").first<{ count: number }>();
        return json({ status: "ok", database: "d1", count: count!.count });
      }
      if (path === "/api/stocks" && method === "GET") {
        const records = await rawStocks(db), meta = await metadata(db), sectors = await sectorRecords(db);
        return json({ stocks: records.map(stock => render(stock, records, meta)), sectors: sectors.map(sector => sector.name),
          meta: { quote_date: meta.quote_date ?? null, imported_at: meta.imported_at ?? null,
            last_refresh: meta.last_refresh ?? null, fx_rate: meta.fx_rate ?? null, source: meta.source ?? "Cloudflare D1" } });
      }
      if (path === "/api/stocks/search" && method === "GET") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) return json({ suggestions: [], message: null });
        if ([...query].length > 40) throw new HttpError(400, "股票搜索最多输入 40 个字符");
        const records = await rawStocks(db), local = new Map(records.map(stock => [`${stock.market}:${stock.code}`, stock]));
        const suggestions: (Suggestion & { existing: boolean; sector: string | null })[] = [], seen = new Set<string>();
        const add = (stock: Suggestion) => {
          const key = `${stock.market}:${stock.code}`;
          if (seen.has(key)) return;
          seen.add(key);
          const existing = local.get(key);
          suggestions.push({ name: stock.name, code: stock.code, market: stock.market, sector: existing?.sector ?? null, existing: Boolean(existing) });
        };
        for (const stock of records) if (stock.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || stock.code.includes(query)) add(stock);
        let message: string | null = null;
        try { (await source.searchStocks(query)).forEach(add); }
        catch { message = "联网搜索暂不可用，仅显示已保存的匹配结果；也可手动填写。"; }
        return json({ suggestions: suggestions.slice(0, 10), message });
      }
      if (path === "/api/stocks" && method === "POST") {
        const data = await bodyJson(request), stock = validated(() => validate(data));
        const id = await saveStock(db, stock);
        return json(render((await getStock(db, id!))!, await rawStocks(db), await metadata(db)), 201);
      }
      if (path === "/api/sectors" && method === "GET") {
        return json({ sectors: (await sectorRecords(db)).map(sector => ({ ...sector, protected: sector.name === "未分类" })) });
      }
      if (path === "/api/sectors" && method === "POST") {
        const data = await bodyJson(request) as Record<string, unknown> | null;
        const name = validated(() => sectorName(data?.name));
        if (await db.prepare("SELECT 1 FROM sectors WHERE name=?").bind(name).first()) throw new HttpError(409, "该板块已存在");
        const result = await db.prepare("INSERT INTO sectors(name) VALUES(?)").bind(name).run();
        return json({ id: result.meta.last_row_id, name, stock_count: 0, protected: false }, 201);
      }
      const sectorMatch = path.match(/^\/api\/sectors\/(\d+)$/);
      if (sectorMatch && ["PATCH", "DELETE"].includes(method)) {
        const id = Number(sectorMatch[1]);
        const existing = await db.prepare("SELECT id,name FROM sectors WHERE id=?").bind(id).first<{ id: number; name: string }>();
        if (!existing) throw new HttpError(404, "板块不存在");
        if (existing.name === "未分类") throw new HttpError(400, method === "DELETE" ? "“未分类”不能删除" : "“未分类”用于保留移出板块的股票，不能重命名");
        if (method === "PATCH") {
          const data = await bodyJson(request) as Record<string, unknown> | null;
          const name = validated(() => sectorName(data?.name));
          if (await db.prepare("SELECT 1 FROM sectors WHERE name=? AND id<>?").bind(name, id).first()) throw new HttpError(409, "该板块已存在");
          const results = await db.batch([
            db.prepare("UPDATE stocks SET sector=? WHERE sector=(SELECT name FROM sectors WHERE id=? AND name=?)").bind(name, id, existing.name),
            db.prepare("UPDATE sectors SET name=? WHERE id=? AND name=?").bind(name, id, existing.name),
          ]);
          if (!results[1].meta.changes) throw new HttpError(409, "板块已变更，请刷新后重试");
          return json({ message: "板块已重命名", name });
        }
        const results = await db.batch([
          db.prepare("INSERT OR IGNORE INTO sectors(name) VALUES('未分类')"),
          db.prepare("UPDATE stocks SET sector='未分类' WHERE sector=(SELECT name FROM sectors WHERE id=?)").bind(id),
          db.prepare("DELETE FROM sectors WHERE id=?").bind(id),
        ]);
        const moved = results[1].meta.changes;
        return json({ message: `板块已删除，${moved} 支股票已保留到未分类`, moved });
      }
      const stockMatch = path.match(/^\/api\/stocks\/(\d+)(\/boll)?$/);
      if (stockMatch && ["GET", "PATCH", "DELETE"].includes(method)) {
        const id = Number(stockMatch[1]), stock = await getStock(db, id);
        if (!stock) throw new HttpError(404, "股票不存在");
        if (stockMatch[2]) {
          if (method !== "GET") throw new HttpError(405, "不支持的请求方法");
          return json(await bollinger.get(stock, source, url.searchParams.get("refresh") === "1"));
        }
        if (method === "GET") return json(render(stock, await rawStocks(db), await metadata(db), true));
        if (method === "DELETE") {
          await db.prepare("DELETE FROM stocks WHERE id=?").bind(id).run();
          return json({ message: "已删除" });
        }
        const data = await bodyJson(request), updated = validated(() => validate(data, stock));
        if (await saveStock(db, updated, stock) === null) throw new HttpError(409, "股票已变更，请刷新后重试");
        return json(render((await getStock(db, id))!, await rawStocks(db), await metadata(db)));
      }
      if (path === "/api/refresh" && method === "POST") {
        await bodyJson(request);
        return await refresh(db, source);
      }
      throw new HttpError(404, "接口不存在");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
        return json({ error: new URL(request.url).pathname.startsWith("/api/sectors") ? "该板块已存在" : "该市场和股票代码已存在" }, 409);
      }
      console.error("API request failed", error);
      return json({ error: "服务器处理失败，已有数据已保留；请查看 Worker 日志" }, 500);
    }
  };
}

export const handleRequest = createHandler();
export const worker = { fetch: handleRequest };
export default worker;
