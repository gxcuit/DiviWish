import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { digest } from "../auth.ts";
import { resolveMarketSelection } from "../market-indices.ts";
import { MarketService } from "../market.ts";
import type { Env } from "../types.ts";
import { TestDatabase } from "./helpers.ts";

test("market requires login, shares only public data, rejects invalid methods, and preserves user tables", async t => {
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  for (const name of ["0002_accounts.sql", "0003_passwords.sql", "0004_linuxdo.sql", "0008_custom_dividends_accounts.sql"]) db.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const env: Env = { DB: db.binding, APP_ORIGIN: "http://localhost", AUTH_EMAIL_MODE: "console", AUTH_SECRET: "test-secret-for-market-test-only" };
  const now = Math.floor(Date.now() / 1000), token = "a".repeat(64);
  db.sqlite.prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)").run("market-user", "market@example.test", now);
  db.sqlite.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(await digest(token), "market-user", now + 3600, now);
  let calls = 0;
  const service = new MarketService(async () => { calls++; return Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.parse("2026-01-01") + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i })); });
  const handler = createHandler(undefined, {}, service);
  const request = (cookie = "", method = "GET") => handler(new Request("http://localhost/api/market", { method, headers: { Cookie: cookie } }), env);
  assert.equal((await request()).status, 401); assert.equal(calls, 0);
  const cookie = `diviwish_session=${token}`;
  const response = await request(cookie); assert.equal(response.status, 200, await response.clone().text());
  const snapshot = await response.json(); assert.equal(snapshot.latest.spread, 0); assert.equal(snapshot.series.length, 50);
  assert.equal(snapshot.user_id, undefined);
  assert.equal((await handler(new Request("http://localhost/api/market?a=H20269"), env)).status, 401);
  for (const code of ["H20269", "H20955"]) {
    const selected = await handler(new Request(`http://localhost/api/market?a=${code}&b=000510CNY010`, { headers: { Cookie: cookie } }), env);
    assert.equal(selected.status, 200); assert.equal((await selected.json()).selection.a.code, code);
  }
  assert.equal((await handler(new Request("http://localhost/api/market?a=H30269", { headers: { Cookie: cookie } }), env)).status, 400);
  assert.equal((await service.get(false, resolveMarketSelection("H20269"))).selection.a.code, "H20269");
  assert.equal((await request(cookie, "DELETE")).status, 405);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM user_stocks").get()!.n, 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM user_metadata").get()!.n, 0);
  const failed = createHandler(undefined, {}, new MarketService(async () => { throw new Error("timeout"); }));
  assert.equal((await failed(new Request("http://localhost/api/market", { headers: { Cookie: cookie } }), env)).status, 502);
});
