import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const temporary = await mkdtemp(path.join(tmpdir(), "diviwish-standalone-"));
// Reproduce the final image's runtime files outside the project, without node_modules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packaged = path.join(temporary, "app");
await mkdir(path.join(packaged, "scripts"), { recursive: true });
for (const name of ["out", "worker", "migrations", "package.json"]) {
  await cp(path.join(root, name), path.join(packaged, name), { recursive: true, filter: source => !source.includes(`${path.sep}tests`) });
}
for (const name of ["preview.mjs", "local-server.mjs", "local-database.mjs", "runtime-config.mjs"]) {
  await cp(path.join(root, "scripts", name), path.join(packaged, "scripts", name));
}
const { startLocalServer } = await import(pathToFileURL(path.join(packaged, "scripts/local-server.mjs")).href);
const options = { port: 0, database: path.join(temporary, "diviwish.sqlite3"), assets: true,
  source: { searchStocks: async () => [], fetchFx: async () => 0.9,
    fetchQuotes: async () => ({ quotes: new Map(), errors: [] }),
    fetchKline: async () => ({ bars: [], adjustment: "none", quote: null }) },
};
let service;
try {
  service = await startLocalServer(options);
  const request = (route, method = "GET", body, extraHeaders = {}) => {
    const url = `http://127.0.0.1:${service.port}${route}`;
    const headers = { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: `http://127.0.0.1:${service.port}` }), ...extraHeaders };
    // Fetch may normalize Host. Use real HTTP headers for hostname validation.
    if (extraHeaders.Host) return new Promise((resolve, reject) => {
      const outgoing = httpRequest(url, { method, headers }, incoming => {
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.setTimeout(10_000, () => outgoing.destroy(new Error("HTTP test timeout")));
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  };
  const health = await (await request("/api/health")).json();
  assert.equal(health.database, "sqlite"); assert.equal(health.mode, "standalone");
  assert.equal((await request("/discovery")).status, 200);
  const html = await (await request("/discovery")).text();
  assert.match(html, /DiviWish/); assert.doesNotMatch(html, /LinuxDO|退出登录|修改登录密码/);
  for (const route of ["/login", "/register", "/reset-password", "/api/auth/session", "/api/auth/login", "/api/auth/register", "/api/auth/linuxdo/start"]) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.deepEqual((await (await request("/api/stocks")).json()).stocks, []);
  assert.equal(service.db.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('users','auth_sessions','user_stocks')").get().n, 0);
  assert.equal((await request("/api/stocks", "GET", undefined, { Host: "evil.example" })).status, 403);
  const payload = { code: "600001", market: "A", name: "单机持久化测试", sector: "银行", price: 10, annual_dividend: 0.5 };
  assert.equal((await request("/api/stocks", "POST", payload, { Origin: "https://evil.example" })).status, 403);
  const added = await request("/api/stocks", "POST", payload);
  assert.equal(added.status, 201, await added.clone().text());
  assert.equal(added.headers.get("Set-Cookie"), null);
  const { id } = await added.json();
  assert.equal((await request(`/api/stocks/${id}`, "PATCH", { watched: true, grid_end: 0.09 })).status, 200);
  assert.equal((await request("/api/sectors", "POST", { name: "空板块" })).status, 201);
  await service.close(); service = await startLocalServer(options);
  const stock = await (await request(`/api/stocks/${id}`)).json();
  assert.equal(stock.name, payload.name); assert.equal(stock.watched, true); assert.equal(stock.grid_end, 0.09);
  assert.ok((await (await request("/api/sectors")).json()).sectors.some(sector => sector.name === "空板块"));
  // Container-style binding and a deliberately configured reverse-proxy origin.
  await service.close(); service = await startLocalServer({ ...options, host: "0.0.0.0", config: { APP_ORIGIN: "https://personal.example" } });
  assert.equal((await request(`/api/stocks/${id}`, "PATCH", { watched: false }, { Host: "personal.example", Origin: "https://personal.example" })).status, 200);
  assert.equal((await request(`/api/stocks/${id}`, "DELETE")).status, 200);
  assert.equal((await request(`/api/stocks/${id}`)).status, 404);
  console.log("Standalone HTTP passed: direct access, removed login routes, static pages, CRUD, sectors, SQLite restart persistence, container binding, configured origin and cross-site rejection. Packaged runtime has no node_modules; only a temporary database was used.");
} finally {
  if (service) await service.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
