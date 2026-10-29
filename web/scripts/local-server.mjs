import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { LocalDatabase } from "./local-database.mjs";
import { databasePath } from "./runtime-config.mjs";
import { createHandler } from "../worker/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function startLocalServer({ port = 8787, host = "127.0.0.1", database, config = {}, source, assets = false } = {}) {
  const saved = { APP_ORIGIN: process.env.APP_ORIGIN || undefined, ...config };
  if (saved.APP_ORIGIN) {
    const origin = new URL(saved.APP_ORIGIN);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== saved.APP_ORIGIN) {
      throw new Error("APP_ORIGIN 必须为完整的 http(s) 来源地址，不带路径或末尾斜杠");
    }
  }
  const assetRoot = path.join(root, "out");
  if (assets && !(await stat(path.join(assetRoot, "discovery.html")).catch(() => null))?.isFile()) {
    throw new Error("缺少构建文件，请先在 web/ 运行 npm run build，再运行 npm start");
  }
  const db = new LocalDatabase(database || databasePath(), path.join(root, "migrations"));
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
        return new Response(await readFile(candidate), { headers: { "Content-Type": contentTypes[path.extname(candidate)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" } });
      } catch { /* Try the next static export path. */ }
    }
    return new Response("Not found", { status: 404 });
  } } };
  const handler = createHandler(source);
  const server = createServer(async (incoming, outgoing) => {
    try {
      // Only loopback or the explicitly configured origin may reach this local app.
      // Reject other Host values, including DNS rebinding targets.
      const authority = incoming.headers.host || `localhost:${server.address().port}`;
      const origin = new URL(`http://${authority}`);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (!local && (!saved.APP_ORIGIN || origin.host !== new URL(saved.APP_ORIGIN).host)) {
        outgoing.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        outgoing.end("请使用本机地址，或设置 APP_ORIGIN 为实际访问地址");
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const method = incoming.method || "GET";
      const request = new Request(new URL(incoming.url || "/", origin), { method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }),
      });
      const response = await handler(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (method === "HEAD" || !response.body) outgoing.end();
      else Readable.fromWeb(response.body).pipe(outgoing);
    } catch {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "本地服务处理失败" }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } catch (error) { db.close(); throw error; }
  return { server, db, env, port: server.address().port, close: () => new Promise((resolve, reject) => {
    server.close(error => { db.close(); if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  }) };
}
