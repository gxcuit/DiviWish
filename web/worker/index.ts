import { createLinuxdoAuth } from "./linuxdo.ts";
import { createAuth, requireUser } from "./auth.ts";
import { BollingerService } from "./bollinger.ts";
import { bodyJson, HttpError, json, protectWrites, validated } from "./http.ts";
import { portfolio } from "./portfolio.ts";
import { providers } from "./providers.ts";
import { render } from "./render.ts";
import { refreshStocks } from "./refresh.ts";
import { sectorName, timestamp, validate } from "./validation.ts";
import type { Env, Providers, Suggestion } from "./types.ts";

export function createHandler(source: Providers = providers, authOptions: Parameters<typeof createAuth>[0] = {}) {
  const auth = createAuth(authOptions);
  const linuxdo = createLinuxdoAuth(authOptions);
  return async function handle(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path === "/") return Response.redirect(new URL("/discovery", url), 302);
      if (!path.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
      protectWrites(request, env.APP_ORIGIN);
      if (path === "/api/health" && method === "GET") {
        await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
        return json({ status: "ok", database: "d1", authentication: "password-and-email-verification" });
      }
      const linuxdoResponse = await linuxdo(request, env);
      if (linuxdoResponse) return linuxdoResponse;
      const authResponse = await auth(request, env);
      if (authResponse) return authResponse;
      const user = await requireUser(request, env), db = env.DB, store = portfolio(db, user.id);
      if (path === "/api/stocks/preview" && method === "GET") {
        const stock = validated(() => validate({ code: url.searchParams.get("code"), market: url.searchParams.get("market"), name: "待查询股票", sector: "未分类" }));
        stock.id = 0; // Temporary quote identity; preview never writes to the portfolio.
        const [quotes, dividends] = await Promise.allSettled([
          source.fetchQuotes([stock]),
          source.fetchDividends ? source.fetchDividends(stock) : Promise.reject(new Error("分红来源未配置")),
        ]);
        const quote = quotes.status === "fulfilled" ? quotes.value.quotes.get(0) ?? null : null;
        const snapshot = dividends.status === "fulfilled" ? dividends.value : null;
        const errors = [
          ...(!quote ? ["当前价格获取失败，原值未修改，可稍后重试或手动填写"] : []),
          ...(!snapshot ? ["未获取到可核实的完整年度股息，原值未修改，请核实后手动填写"] : []),
        ];
        return json({ code: stock.code, market: stock.market, quote, dividends: snapshot, errors }, quote || snapshot ? 200 : 502);
      }
      if (path === "/api/stocks" && method === "GET") {
        const [records, meta, sectors] = await Promise.all([store.stocks(), store.meta(), store.sectors()]);
        return json({ stocks: records.map(stock => render(stock, records, meta)), sectors: sectors.map(sector => sector.name),
          meta: { quote_date: meta.quote_date ?? null, imported_at: meta.imported_at ?? null,
            last_refresh: meta.last_refresh ?? null, fx_rate: meta.fx_rate ?? null, source: meta.source ?? "个人账号数据库" } });
      }
      if (path === "/api/stocks/search" && method === "GET") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if ([...query].length > 40) throw new HttpError(400, "股票搜索最多输入 40 个字符");
        if (!query) return json({ suggestions: [], message: null });
        const records = await store.stocks(), local = new Map(records.map(stock => [`${stock.market}:${stock.code}`, stock]));
        const suggestions: (Suggestion & { existing: boolean; sector: string | null })[] = [], seen = new Set<string>();
        const add = (stock: Suggestion) => {
          const key = `${stock.market}:${stock.code}`;
          if (seen.has(key)) return;
          seen.add(key);
          const existing = local.get(key);
          suggestions.push({ ...stock, sector: existing?.sector ?? null, existing: Boolean(existing) });
        };
        for (const stock of records) if (stock.name.toLowerCase().includes(query.toLowerCase()) || stock.code.includes(query)) add(stock);
        let message: string | null = null;
        try { (await source.searchStocks(query)).forEach(add); } catch { message = "联网搜索暂不可用，也可手动填写"; }
        return json({ suggestions: suggestions.slice(0, 10), message });
      }
      if (path === "/api/stocks" && method === "POST") {
        const data = await bodyJson(request), stock = validated(() => validate(data));
        const id = await store.save(stock);
        return json(render((await store.stock(id!))!, await store.stocks(), await store.meta()), 201);
      }
      if (path === "/api/sectors" && method === "GET") return json({ sectors: (await store.sectors()).map(sector => ({ ...sector, protected: sector.name === "未分类" })) });
      if (path === "/api/sectors" && method === "POST") {
        const data = await bodyJson(request), name = validated(() => sectorName(data.name));
        const result = await db.prepare("INSERT INTO user_sectors(user_id,name) VALUES(?,?)").bind(user.id, name).run();
        return json({ id: result.meta.last_row_id, name, stock_count: 0, protected: false }, 201);
      }
      const sectorMatch = path.match(/^\/api\/sectors\/(\d+)$/);
      if (sectorMatch && ["PATCH", "DELETE"].includes(method)) {
        const id = Number(sectorMatch[1]);
        const existing = await db.prepare("SELECT id,name FROM user_sectors WHERE user_id=? AND id=?").bind(user.id, id).first<{ id: number; name: string }>();
        if (!existing) throw new HttpError(404, "板块不存在");
        if (existing.name === "未分类") throw new HttpError(400, "“未分类”不能重命名或删除");
        if (method === "PATCH") {
          const data = await bodyJson(request), name = validated(() => sectorName(data.name));
          if (await db.prepare("SELECT 1 FROM user_sectors WHERE user_id=? AND name=? AND id<>?").bind(user.id, name, id).first()) throw new HttpError(409, "该板块已存在");
          const results = await db.batch([
            db.prepare("UPDATE user_stocks SET sector=? WHERE user_id=? AND sector=(SELECT name FROM user_sectors WHERE user_id=? AND id=? AND name=?)")
              .bind(name, user.id, user.id, id, existing.name),
            db.prepare("UPDATE user_sectors SET name=? WHERE user_id=? AND id=? AND name=?").bind(name, user.id, id, existing.name),
          ]);
          if (!results[1].meta.changes) throw new HttpError(409, "板块已变更，请刷新后重试");
          return json({ message: "板块已重命名", name });
        }
        const results = await db.batch([
          db.prepare("INSERT OR IGNORE INTO user_sectors(user_id,name) VALUES(?,'未分类')").bind(user.id),
          db.prepare("UPDATE user_stocks SET sector='未分类' WHERE user_id=? AND sector=(SELECT name FROM user_sectors WHERE user_id=? AND id=?)")
            .bind(user.id, user.id, id),
          db.prepare("DELETE FROM user_sectors WHERE user_id=? AND id=?").bind(user.id, id),
        ]);
        return json({ message: `板块已删除，${results[1].meta.changes} 支股票已保留到未分类`, moved: results[1].meta.changes });
      }
      const stockMatch = path.match(/^\/api\/stocks\/(\d+)(\/(?:boll|refresh|history))?$/);
      if (stockMatch && ["GET", "PATCH", "DELETE", "POST"].includes(method)) {
        const id = Number(stockMatch[1]), stock = await store.stock(id);
        if (!stock) throw new HttpError(404, "股票不存在");
        if (stockMatch[2] === "/history") {
          if (method !== "POST") throw new HttpError(405, "请使用 POST 获取历史分位");
          await bodyJson(request);
          if (stock.history.length >= 60 && typeof stock.history_updated_at === "string" && stock.history_updated_at.startsWith(timestamp().slice(0, 10))) {
            return json(render(stock, await store.stocks(), await store.meta(), true));
          }
          if (!source.fetchHistory) throw new HttpError(503, "历史数据来源尚未配置");
          let snapshot;
          try { snapshot = await source.fetchHistory(stock); }
          catch (error) { throw new HttpError(502, `历史分位获取失败：${error instanceof Error ? error.message : "历史数据来源暂不可用"}。已保留原有历史数据。`); }
          const current = await store.stock(id);
          const relevant = ["code", "market", "annual_dividend", "history", "history_updated_at"];
          if (!current || relevant.some(key => JSON.stringify(current[key]) !== JSON.stringify(stock[key]))) throw new HttpError(409, "股票数据已变更，跳过旧历史计算，请重试");
          if (await store.save({ ...current, ...snapshot }, current) === null) throw new HttpError(409, "股票数据已变更，请重试");
          return json(render((await store.stock(id))!, await store.stocks(), await store.meta(), true));
        }
        if (stockMatch[2] === "/refresh") {
          if (method !== "POST") throw new HttpError(405, "请使用 POST 刷新股票");
          await bodyJson(request);
          return await refreshStocks(db, user.id, [stock], source);
        }
        if (stockMatch[2] === "/boll") {
          if (method !== "GET") throw new HttpError(405, "不支持的请求方法");
          return json(await new BollingerService().get(stock, source));
        }
        if (method === "POST") throw new HttpError(405, "不支持的请求方法");
        if (method === "GET") return json(render(stock, await store.stocks(), await store.meta(), true));
        if (method === "DELETE") { await store.remove(id); return json({ message: "已删除" }); }
        const data = await bodyJson(request), updated = validated(() => validate(data, stock));
        if (await store.save(updated, stock) === null) throw new HttpError(409, "股票已变更，请刷新后重试");
        return json(render((await store.stock(id))!, await store.stocks(), await store.meta()));
      }
      if (path === "/api/refresh" && method === "POST") { await bodyJson(request); return await refreshStocks(db, user.id, await store.stocks(), source); }
      throw new HttpError(404, "接口不存在");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) return json({ error: "该股票或板块已存在" }, 409);
      // Do not log request bodies, OTPs, session tokens or provider credentials.
      console.error(JSON.stringify({ event: "api.error", path: new URL(request.url).pathname }));
      return json({ error: "服务器处理失败，请稍后重试" }, 500);
    }
  };
}

export const handleRequest = createHandler();
export const worker = { fetch: handleRequest };
export default worker;
