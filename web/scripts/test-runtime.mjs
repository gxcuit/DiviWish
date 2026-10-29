import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startLocalServer } from "./local-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".local"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".local/accounts-runtime-"));
const emails = [];
const options = { port: 0, database: path.join(temporary, "accounts.sqlite3"), assets: true,
  config: { AUTH_EMAIL_MODE: "console", AUTH_SECRET: randomBytes(48).toString("base64url"), APP_ORIGIN: "http://localhost:3000",
    LINUXDO_CLIENT_ID: "mock-client", LINUXDO_CLIENT_SECRET: "mock-secret",
    RESEND_API_KEY: "", RESEND_TEST_RECIPIENT: "", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" },
  fetcher: async input => String(input).endsWith("/oauth2/token")
    ? Response.json({ access_token: "test-provider-token", token_type: "Bearer" })
    : Response.json({ id: 999, username: "runtime-user", active: true, silenced: false }),
  deliver: async message => { emails.push(message); return `mock-${message.challengeId}`; },
  source: { searchStocks: async () => [], fetchFx: async () => 0.9, fetchQuotes: async () => ({ quotes: new Map(), errors: [] }),
    fetchKline: async () => ({ bars: [], adjustment: "none", quote: null }) },
};
let service;
try {
  service = await startLocalServer(options);
  const request = (route, method = "GET", body, cookie, extraHeaders = {}) => fetch(`http://127.0.0.1:${service.port}${route}`, {
    method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: `http://127.0.0.1:${service.port}` }), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  async function login(email) {
    const sent = await request("/api/auth/send-code", "POST", { email, purpose: "register" });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.ok(!(await sent.json()).code);
    const message = emails.at(-1);
    const result = await request("/api/auth/register", "POST", { ...message, password: "Local runtime test password 123!" });
    assert.equal(result.status, 201, await result.clone().text());
    return result.headers.get("Set-Cookie").split(";")[0];
  }
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/discovery")).status, 200);
  assert.match(await (await request("/discovery")).text(), /DiviWish/);
  assert.equal((await request("/api/stocks")).status, 401);
  assert.equal((await request("/api/auth/send-code", "POST", { email: "alice@example.test" }, undefined, { Origin: "https://evil.test" })).status, 403);
  const alice = await login("alice@example.test"), bob = await login("bob@example.test");
  const stock = { code: "600001", market: "A", name: "账号隔离测试", sector: "银行", price: 10, annual_dividend: 0.5 };
  const added = await request("/api/stocks", "POST", stock, alice);
  assert.equal(added.status, 201, await added.clone().text());
  const { id } = await added.json();
  assert.equal((await request(`/api/stocks/${id}`, "GET", undefined, bob)).status, 404);
  assert.equal((await request(`/api/stocks/${id}`, "DELETE", undefined, bob)).status, 404);
  assert.deepEqual((await (await request("/api/stocks", "GET", undefined, bob)).json()).stocks, []);
  // Restart against only this temporary database: sessions and account data persist.
  await service.close(); service = await startLocalServer(options);
  assert.equal((await (await request("/api/stocks", "GET", undefined, alice)).json()).stocks.length, 1);
  assert.equal((await request("/api/auth/logout", "POST", {}, alice)).status, 200);
  assert.equal((await request("/api/stocks", "GET", undefined, alice)).status, 401);
  const passwordLogin = await request("/api/auth/login", "POST", { email: "alice@example.test", password: "Local runtime test password 123!" });
  assert.equal(passwordLogin.status, 200, await passwordLogin.clone().text());
  // Real HTTP must preserve both Set-Cookie headers from the OAuth callback.
  service.env.APP_ORIGIN = `http://127.0.0.1:${service.port}`;
  const oauthStart = await fetch(`${service.env.APP_ORIGIN}/api/auth/linuxdo/start`, { redirect: "manual" });
  assert.equal(oauthStart.status, 302);
  const state = new URL(oauthStart.headers.get("Location")).searchParams.get("state");
  const browserCookie = oauthStart.headers.getSetCookie()[0].split(";")[0];
  const callback = await fetch(`${service.env.APP_ORIGIN}/api/auth/linuxdo/callback?code=mock&state=${state}`, {
    headers: { Cookie: browserCookie }, redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), `${service.env.APP_ORIGIN}/discovery`);
  assert.equal(callback.headers.getSetCookie().length, 2);
  const oauthCookie = callback.headers.getSetCookie().find(value => value.startsWith("diviwish_session=")).split(";")[0];
  const oauthUser = (await (await request("/api/auth/session", "GET", undefined, oauthCookie)).json()).user;
  assert.equal(oauthUser.email, null); assert.equal(oauthUser.linuxdoUsername, "runtime-user");
  assert.deepEqual((await (await request("/api/stocks", "GET", undefined, oauthCookie)).json()).stocks, []);
  console.log("Local HTTP runtime passed: LinuxDO OAuth callback/cookies and static login page, registration, sessions, account isolation, restart persistence, CSRF and logout. No real emails or personal databases used.");
} finally {
  if (service) await service.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
