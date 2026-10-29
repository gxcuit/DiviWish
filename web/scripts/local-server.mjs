import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { LocalD1 } from "./local-d1.mjs";
import { readPrivateEnv } from "./private-env.mjs";
import { createHandler } from "../worker/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function startLocalServer({ port = 8787, database, config = {}, source, deliver, clock, fetcher, assets = false } = {}) {
  const db = new LocalD1(database || path.join(root, ".local/accounts/diviwish.sqlite3"), path.join(root, "migrations"));
  const file = path.join(root, ".dev.vars");
  if (!existsSync(file)) writeFileSync(file, `APP_ORIGIN=http://localhost:3000\nAUTH_EMAIL_MODE=console\nAUTH_SECRET=${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });
  const saved = { APP_ORIGIN: "http://localhost:3000", AUTH_EMAIL_MODE: "console", ...readPrivateEnv(file), ...config };
  const assetRoot = path.join(root, "out");
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
  const env = { ...saved, DB: db, ASSETS: { async fetch(request) {
    if (!assets) return new Response("Frontend is served by Next.js", { status: 404 });
    let relative;
    try { relative = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
    const filename = path.resolve(assetRoot, "." + relative);
    if (!filename.startsWith(assetRoot + path.sep) && filename !== assetRoot) return new Response("Forbidden", { status: 403 });
    const candidates = [filename, filename + ".html", path.join(filename, "index.html")];
    for (const candidate of candidates) {
      try {
        if (!(await stat(candidate)).isFile()) continue;
        return new Response(await readFile(candidate), { headers: { "Content-Type": contentTypes[path.extname(candidate)] || "application/octet-stream" } });
      } catch { /* Try the next static export path. */ }
    }
    return new Response("Not found", { status: 404 });
  } } };
  const handler = createHandler(source, { ...(deliver ? { deliver } : {}), ...(clock ? { clock } : {}), ...(fetcher ? { fetcher } : {}) });
  const server = createServer(async (incoming, outgoing) => {
    try {
      // Fixed loopback origin: untrusted Host headers cannot enable public dev mode.
      const origin = `http://localhost:${server.address().port}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      // CF-Connecting-IP is trusted only on Cloudflare; local clients cannot spoof it.
      headers.delete("CF-Connecting-IP");
      const method = incoming.method || "GET";
      const request = new Request(new URL(incoming.url || "/", origin), { method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }),
      });
      const response = await handler(request, env);
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders["set-cookie"];
      outgoing.writeHead(response.status, { ...responseHeaders, ...(response.headers.has("Set-Cookie") ? { "Set-Cookie": response.headers.getSetCookie() } : {}) });
      if (method === "HEAD" || !response.body) outgoing.end();
      else Readable.fromWeb(response.body).pipe(outgoing);
    } catch {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "本地服务处理失败" }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, db, env, port: server.address().port, close: () => new Promise((resolve, reject) => {
    server.close(error => { db.close(); if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await startLocalServer({ port: Number(process.env.API_PORT || 8787), assets: process.argv.includes("--assets") });
  console.log(`DiviWish 本地账号 API: http://localhost:${result.port}（Node.js + SQLite；同一 Worker 处理逻辑）`);
  console.log("旧 backend/data/ 和 .wrangler/state/ 均未读写；不会发布到 Cloudflare。");
  process.on("SIGINT", async () => { await result.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await result.close(); process.exit(0); });
}
