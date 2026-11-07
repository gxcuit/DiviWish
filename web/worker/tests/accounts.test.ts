import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { digest, normalizeEmail } from "../auth.ts";
import { parseSearch } from "../providers.ts";
import type { OtpMessage } from "../mail.ts";
import { sendResendOtp } from "../mail.ts";
import { HttpError } from "../http.ts";
import { hashPassword, validatePassword, verifyPassword } from "../passwords.ts";
import { TestDatabase } from "./helpers.ts";
import type { DividendSnapshot, Env, Providers, User } from "../types.ts";

const PASSWORD = "A long test passphrase 123!", NEXT_PASSWORD = "A different test passphrase 456!";
const DIVIDEND: DividendSnapshot = { annual_dividend: 2.7, rolling_dividend: 2.8, annual_year: 2025, confirmed: true,
  ex_dividend_date: "2026-07-01", dividends: [{ period: "2025-12-31", dps: 2.7, status: "实施分配" }],
  dividend_source: "test public reports", dividend_updated_at: "2026-10-28", dividend_fx_rate: null };
function accountFixture() {
  const db = new TestDatabase();
  for (const name of ["0002_accounts.sql", "0003_passwords.sql", "0004_linuxdo.sql"]) db.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const emails: OtpMessage[] = [];
  const state = { now: Math.floor(Date.now() / 1000), failDelivery: false, challengeSuccess: true, challengeHost: "localhost", challengeAction: "send_otp" };
  const env: Env = { DB: db.binding, APP_ORIGIN: "http://localhost:3000", AUTH_EMAIL_MODE: "console", AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID() };
  const source: Providers = { searchStocks: async () => [], fetchFx: async () => 0.9,
    fetchQuotes: async stocks => ({ quotes: new Map(stocks.map(stock => [stock.id!, { price: 20, quote_date: "2026-10-27" }])), errors: [] }),
    fetchKline: async () => ({ bars: [], adjustment: "none", quote: null }),
  };
  const handler = createHandler(source, { clock: () => state.now,
    deliver: async message => { if (state.failDelivery) throw new Error("test mail failure"); emails.push(message); return `test-${message.challengeId}`; },
    fetcher: async () => Response.json({ success: state.challengeSuccess, hostname: state.challengeHost, action: state.challengeAction }),
  });
  const request = (path: string, method = "GET", data?: unknown, cookie?: string, headers: Record<string, string> = {}) => handler(new Request(`http://localhost${path}`, {
    method, headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  async function code(email = "alice@example.test", purpose = "register") {
    const sent = await request("/api/auth/send-code", "POST", { email, purpose, turnstileToken: "test" });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.ok(!(await sent.json()).code);
    return emails.at(-1)!;
  }
  async function register(email = "alice@example.test", password = PASSWORD, keepDefaults = false) {
    const message = await code(email);
    const response = await request("/api/auth/register", "POST", { ...message, password });
    assert.equal(response.status, 201, await response.clone().text());
    const user = (await response.json()).user as User;
    // Most account regressions explicitly start after the user clears defaults.
    if (!keepDefaults) db.sqlite.prepare("DELETE FROM user_stocks WHERE user_id=?").run(user.id);
    return { user, cookie: response.headers.get("Set-Cookie")!.split(";")[0], response, message };
  }
  return { db, emails, state, env, source, request, code, register, handler };
}

test("signed-in users can find and save 513530 from its real QDII-ETF classification", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  f.source.searchStocks = async () => parseSearch('v_hint=' + JSON.stringify("sh~513530~港股通红利ETF华泰柏瑞~ggthletfhtbr~QDII-ETF"));
  assert.equal((await f.request("/api/stocks/search?q=513530")).status, 401);
  const alice = await f.register();
  const response = await f.request("/api/stocks/search?q=513530", "GET", undefined, alice.cookie);
  assert.equal(response.status, 200);
  const { suggestions } = await response.json();
  assert.equal(suggestions.length, 1); assert.equal(suggestions[0].existing, false);
  const { name, code, market, instrument_type, exchange } = suggestions[0];
  const saved = await f.request("/api/stocks", "POST", { name, code, market, instrument_type, exchange, sector: "ETF" }, alice.cookie);
  assert.equal(saved.status, 201);
  const stock = await saved.json();
  assert.equal(stock.name, "港股通红利ETF华泰柏瑞"); assert.equal(stock.code, "513530");
  assert.equal(stock.market, "A"); assert.equal(stock.instrument_type, "etf"); assert.equal(stock.exchange, "sh");
  assert.equal(stock.yield_basis, "rolling");
  const again = await (await f.request("/api/stocks/search?q=513530", "GET", undefined, alice.cookie)).json();
  assert.equal(again.suggestions.length, 1); assert.equal(again.suggestions[0].existing, true);
});

test("registration requires a password and email verification; login uses the saved password without sending email", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const message = await f.code("Alice@Example.test");
  assert.equal((await f.request("/api/auth/register", "POST", message)).status, 400);
  assert.equal((await f.request("/api/auth/register", "POST", { ...message, password: "short" })).status, 400);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n, 0);
  assert.equal((await f.request("/api/auth/verify", "POST", message)).status, 404);
  const registered = await f.request("/api/auth/register", "POST", { ...message, password: PASSWORD });
  assert.equal(registered.status, 201);
  const user = (await registered.json()).user;
  assert.equal(user.email, "alice@example.test"); assert.equal(user.hasPassword, true); assert.ok(!("password_hash" in user));
  const cookie = registered.headers.get("Set-Cookie")!.split(";")[0];
  const list = await (await f.request("/api/stocks", "GET", undefined, cookie)).json();
  assert.deepEqual(list.stocks.map((s: { code: string }) => s.code), ["600036", "510880"]); assert.deepEqual(list.sectors, ["未分类", "银行", "ETF"]);
  const loggedIn = await f.request("/api/auth/login", "POST", { email: "ALICE@example.test", password: PASSWORD });
  assert.equal(loggedIn.status, 200); assert.equal((await loggedIn.json()).user.id, user.id);
  assert.equal(f.emails.length, 1);
  const stored = f.db.sqlite.prepare("SELECT password_hash FROM users").get()!.password_hash as string;
  assert.ok(stored.startsWith("scrypt$")); assert.ok(!stored.includes(PASSWORD));
  const challenge = f.db.sqlite.prepare("SELECT code_hash FROM auth_challenges WHERE id=?").get(message.challengeId)!;
  assert.notEqual(challenge.code_hash, message.code);
});

test("password hashing uses unique salts, full Unicode/space input, constant-time verification and bounded costs", async () => {
  const password = " 中文密码与空格 long secret ";
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second); assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password.trim(), first), false); assert.equal(await verifyPassword("wrong", first), false);
  assert.equal(await verifyPassword(PASSWORD, null), false); assert.equal(await verifyPassword(PASSWORD, "scrypt$999999999$8$5$bad$bad"), false);
  for (const value of ["1234567", "中文密码七个字符", " ".repeat(7), "x".repeat(129)]) assert.equal(validatePassword(value), value);
  for (const value of [null, "short", "123456"]) assert.throws(() => validatePassword(value), HttpError);
});

test("seven-character passwords support registration, login and password reset without composition requirements", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const { cookie } = await f.register("short@example.test", "1234567");
  assert.equal((await f.request("/api/auth/login", "POST", { email: "short@example.test", password: "1234567" })).status, 200);
  f.state.now += 61;
  const message = await f.code("short@example.test", "reset_password");
  assert.equal((await f.request("/api/auth/reset-password", "POST", { ...message, password: "abcdefg" })).status, 200);
  assert.equal((await f.request("/api/stocks", "GET", undefined, cookie)).status, 401);
  assert.equal((await f.request("/api/auth/login", "POST", { email: "short@example.test", password: "abcdefg" })).status, 200);
});

test("stock preview requires login, validates identity, supports partial failure and never writes portfolio data", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  assert.equal((await f.request("/api/stocks/preview?market=A&code=601318")).status, 401);
  const { cookie } = await f.register();
  assert.equal((await f.request("/api/stocks/preview?market=HK&code=601318", "GET", undefined, cookie)).status, 400);
  f.source.fetchDividends = async stock => {
    assert.equal(stock.code, "601318"); assert.equal(stock.market, "A");
    return { annual_dividend: 2.7, rolling_dividend: 2.8, annual_year: 2025, confirmed: true, ex_dividend_date: "2026-07-01",
      dividends: [], dividend_source: "test", dividend_updated_at: "2026-10-28", dividend_fx_rate: null };
  };
  const preview = () => f.request("/api/stocks/preview?market=A&code=601318&dividends=force", "GET", undefined, cookie);
  const full = await (await preview()).json();
  assert.equal(full.quote.price, 20); assert.equal(full.dividends.annual_dividend, 2.7); assert.deepEqual(full.errors, []);
  f.source.fetchDividends = async () => { throw new Error("upstream failure"); };
  const partial = await preview(); assert.equal(partial.status, 200);
  const data = await partial.json(); assert.equal(data.quote.price, 20); assert.equal(data.dividends, null); assert.equal(data.errors.length, 1);
  f.source.fetchQuotes = async () => ({ quotes: new Map(), errors: [] });
  assert.equal((await preview()).status, 502);
  f.source.fetchDividends = async stock => {
    assert.equal(stock.code, "00941"); assert.equal(stock.market, "HK");
    return { annual_dividend: 4.5, rolling_dividend: 4.5, annual_year: 2025, confirmed: false, ex_dividend_date: null,
      dividends: [], dividend_source: "test", dividend_updated_at: "2026-10-28", dividend_fx_rate: 0.9 };
  };
  const dividendOnly = await (await f.request("/api/stocks/preview?market=HK&code=00941", "GET", undefined, cookie)).json();
  assert.equal(dividendOnly.quote, null); assert.equal(dividendOnly.dividends.annual_dividend, 4.5);
  assert.deepEqual((await (await f.request("/api/stocks", "GET", undefined, cookie)).json()).stocks, []);
});

test("wrong passwords, unknown accounts and OTP-only legacy accounts have the same login error", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  await f.register();
  f.db.sqlite.prepare("INSERT INTO users(id,email,created_at) VALUES('legacy','legacy@example.test',?)").run(f.state.now);
  const messages = [];
  for (const email of ["alice@example.test", "unknown@example.test", "legacy@example.test"]) {
    const response = await f.request("/api/auth/login", "POST", { email, password: "Incorrect password 123!" });
    assert.equal(response.status, 401); messages.push((await response.json()).error); assert.equal(response.headers.get("Set-Cookie"), null);
  }
  assert.deepEqual(messages, Array(3).fill("邮箱或密码不正确"));
});

test("password login is rate-limited per account before expensive hash verification", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  for (let i = 0; i < 10; i++) assert.equal((await f.request("/api/auth/login", "POST", { email: "alice@example.test", password: "wrong" })).status, 401);
  assert.equal((await f.request("/api/auth/login", "POST", { email: "alice@example.test", password: "wrong" })).status, 429);
});

test("OTP purpose, email binding, expiry, attempt budget and replay prevention are enforced", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const message = await f.code();
  assert.equal((await f.request("/api/auth/reset-password", "POST", { ...message, password: PASSWORD })).status, 400);
  assert.equal((await f.request("/api/auth/register", "POST", { ...message, email: "bob@example.test", password: PASSWORD })).status, 400);
  const wrong = message.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await f.request("/api/auth/register", "POST", { ...message, code: wrong, password: PASSWORD })).status, 400);
  assert.equal((await f.request("/api/auth/register", "POST", { ...message, password: PASSWORD })).status, 400);
  f.state.now += 61; const registered = await f.register();
  assert.equal((await f.request("/api/auth/register", "POST", { ...registered.message, password: PASSWORD })).status, 400);
  f.state.now += 61; const expired = await f.code("expired@example.test"); f.state.now += 601;
  assert.equal((await f.request("/api/auth/register", "POST", { ...expired, password: PASSWORD })).status, 400);
});

test("concurrent registration can consume a challenge only once", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const message = await f.code();
  const responses = await Promise.all([1, 2].map(() => f.request("/api/auth/register", "POST", { ...message, password: PASSWORD })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM auth_sessions").get()!.n, 1);
});

test("registration cannot replace an existing account password even with a valid registration code", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const account = await f.register(); f.state.now += 61;
  const message = await f.code();
  assert.equal((await f.request("/api/auth/register", "POST", { ...message, password: NEXT_PASSWORD })).status, 409);
  assert.equal((await f.request("/api/auth/login", "POST", { email: account.user.email, password: PASSWORD })).status, 200);
  assert.equal((await f.request("/api/auth/login", "POST", { email: account.user.email, password: NEXT_PASSWORD })).status, 401);
});

test("password reset revokes all existing sessions, rotates the cookie and preserves the portfolio", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const account = await f.register();
  const another = await f.request("/api/auth/login", "POST", { email: account.user.email, password: PASSWORD });
  const otherCookie = another.headers.get("Set-Cookie")!.split(";")[0];
  await f.request("/api/stocks", "POST", { code: "600001", market: "A", name: "保留标的", sector: "银行", price: 10 }, account.cookie);
  f.state.now += 61; const message = await f.code(account.user.email!, "reset_password");
  const reset = await f.request("/api/auth/reset-password", "POST", { ...message, password: NEXT_PASSWORD }, account.cookie);
  assert.equal(reset.status, 200); assert.equal((await reset.json()).user.id, account.user.id);
  for (const cookie of [account.cookie, otherCookie]) assert.equal((await f.request("/api/stocks", "GET", undefined, cookie)).status, 401);
  const newCookie = reset.headers.get("Set-Cookie")!.split(";")[0];
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, newCookie)).json()).stocks.length, 1);
  assert.equal((await f.request("/api/auth/login", "POST", { email: account.user.email, password: PASSWORD })).status, 401);
  assert.equal((await f.request("/api/auth/login", "POST", { email: account.user.email, password: NEXT_PASSWORD })).status, 200);
});

test("existing OTP-only accounts set their first password through mailbox verification without replacing identity or data", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  f.db.sqlite.prepare("INSERT INTO users(id,email,created_at) VALUES('legacy','legacy@example.test',?)").run(f.state.now);
  const token = "a".repeat(64);
  f.db.sqlite.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,'legacy',?,?)").run(await digest(token), f.state.now + 3600, f.state.now);
  const cookie = `diviwish_session=${token}`;
  assert.equal((await (await f.request("/api/auth/session", "GET", undefined, cookie)).json()).user.hasPassword, false);
  const code = await f.code("legacy@example.test", "reset_password");
  const response = await f.request("/api/auth/reset-password", "POST", { ...code, password: PASSWORD }, cookie);
  assert.equal(response.status, 200); const user = (await response.json()).user;
  assert.equal(user.id, "legacy"); assert.equal(user.hasPassword, true);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n, 1);
  assert.equal((await f.request("/api/stocks", "GET", undefined, cookie)).status, 401);
});

test("a password reset during an in-flight old-password login prevents creation of a stale session", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const account = await f.register(), changedHash = await hashPassword(NEXT_PASSWORD);
  const prepare = f.db.prepare.bind(f.db);
  let changed = false;
  t.mock.method(f.db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (sql === "SELECT id,email,created_at,password_hash,linuxdo_id,linuxdo_username FROM users WHERE email=?") {
      const first = statement.first.bind(statement);
      statement.first = async () => {
        const row = await first();
        if (!changed) {
          changed = true;
          f.db.sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(changedHash, account.user.id);
          f.db.sqlite.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(account.user.id);
        }
        return row;
      };
    }
    return statement;
  });
  const response = await f.request("/api/auth/login", "POST", { email: account.user.email, password: PASSWORD });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM auth_sessions").get()!.n, 0);
});

test("delivery failure preserves the preceding valid code; successful resend invalidates it", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const first = await f.code();
  assert.equal((await f.request("/api/auth/send-code", "POST", { email: first.email, purpose: "register" })).status, 429);
  f.state.now += 61; f.state.failDelivery = true;
  assert.equal((await f.request("/api/auth/send-code", "POST", { email: first.email, purpose: "register" })).status, 502);
  assert.equal((await f.request("/api/auth/register", "POST", { ...first, password: PASSWORD })).status, 201);
  f.state.now += 61; f.state.failDelivery = false; const old = await f.code("new@example.test");
  f.state.now += 61; await f.code("new@example.test");
  assert.equal((await f.request("/api/auth/register", "POST", { ...old, password: PASSWORD })).status, 400);
});

test("sessions expire and logout revokes access on the server", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close()); const account = await f.register();
  assert.match(account.response.headers.get("Set-Cookie")!, /HttpOnly; SameSite=Lax/);
  const logout = await f.request("/api/auth/logout", "POST", {}, account.cookie);
  assert.match(logout.headers.get("Set-Cookie")!, /Max-Age=0/);
  assert.equal((await f.request("/api/stocks", "GET", undefined, account.cookie)).status, 401);
  const login = await f.request("/api/auth/login", "POST", { email: account.user.email, password: PASSWORD });
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  f.db.sqlite.prepare("UPDATE auth_sessions SET expires_at=0").run();
  assert.equal((await f.request("/api/stocks", "GET", undefined, cookie)).status, 401);
});

test("private API ownership is independent of password login; other accounts cannot inspect or mutate resources", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  assert.equal((await f.request("/api/stocks")).status, 401);
  const alice = await f.register(), bob = await f.register("bob@example.test");
  const stock = { code: "600001", market: "A", name: "测试股票", sector: "银行", price: 10, annual_dividend: 0.5 };
  const a = await (await f.request("/api/stocks", "POST", stock, alice.cookie)).json();
  const b = await (await f.request("/api/stocks", "POST", { ...stock, price: 30 }, bob.cookie)).json();
  for (const [path, method, data] of [[`/api/stocks/${a.id}`, "GET", undefined], [`/api/stocks/${a.id}`, "PATCH", { watched: true }], [`/api/stocks/${a.id}`, "DELETE", undefined], [`/api/stocks/${a.id}/boll`, "GET", undefined]] as const) {
    assert.equal((await f.request(path, method, data, bob.cookie)).status, 404);
  }
  const bank = (await (await f.request("/api/sectors", "GET", undefined, alice.cookie)).json()).sectors.find((row: { name: string }) => row.name === "银行");
  assert.equal((await f.request(`/api/sectors/${bank.id}`, "DELETE", undefined, bob.cookie)).status, 404);
  await f.request("/api/refresh", "POST", {}, alice.cookie);
  assert.equal((await (await f.request(`/api/stocks/${b.id}`, "GET", undefined, bob.cookie)).json()).price, 30);
});

test("cross-site writes and incomplete production configuration remain blocked", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  for (const route of ["/api/auth/send-code", "/api/auth/register", "/api/auth/login", "/api/auth/reset-password"]) {
    assert.equal((await f.request(route, "POST", {}, undefined, { Origin: "https://evil.test" })).status, 403);
  }
  const secret = f.env.AUTH_SECRET; f.env.AUTH_SECRET = ""; assert.equal((await f.request("/api/auth/config")).status, 503); f.env.AUTH_SECRET = secret;
  f.env.APP_ORIGIN = "https://app.example.test";
  assert.equal((await f.handler(new Request("https://app.example.test/api/auth/config"), f.env)).status, 503);
});

test("Turnstile action is bound separately to sending codes and password login", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  f.env.TURNSTILE_SECRET_KEY = "test-secret"; f.env.TURNSTILE_SITE_KEY = "test-site";
  f.state.challengeSuccess = false;
  assert.equal((await f.request("/api/auth/send-code", "POST", { email: "alice@example.test", purpose: "register", turnstileToken: "test" })).status, 400);
  f.state.challengeSuccess = true; f.state.challengeHost = "evil.test";
  assert.equal((await f.request("/api/auth/send-code", "POST", { email: "alice@example.test", purpose: "register", turnstileToken: "test" })).status, 400);
  f.state.challengeHost = "localhost";
  assert.equal((await f.request("/api/auth/login", "POST", { email: "alice@example.test", password: PASSWORD, turnstileToken: "test" })).status, 400);
  f.state.challengeAction = "password_login";
  assert.equal((await f.request("/api/auth/login", "POST", { email: "alice@example.test", password: PASSWORD, turnstileToken: "test" })).status, 401);
  assert.equal(f.emails.length, 0);
});

test("mailboxes normalize case but preserve plus tags and reject malformed input", () => {
  assert.equal(normalizeEmail(" Alice+test@Example.COM "), "alice+test@example.com");
  for (const value of [null, "", "a@localhost", "a\r\nb@example.com", "<a@example.com>"]) assert.throws(() => normalizeEmail(value), HttpError);
});

test("Turnstile accepts both configured production origins and binds tokens to the current request hostname", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  await f.register();
  const primary = "https://diviwish.shaunko.tech", fallback = "https://diviwish.jackgao-china.workers.dev";
  f.env.APP_ORIGIN = primary; f.env.APP_ALLOWED_ORIGINS = fallback; f.env.AUTH_EMAIL_MODE = "resend";
  f.env.TURNSTILE_SITE_KEY = "test-site"; f.env.TURNSTILE_SECRET_KEY = "test-secret";
  const requestAt = (origin: string, route: string, data: Record<string, unknown>) => f.handler(new Request(origin + route, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...data, turnstileToken: "test" }),
  }), f.env);
  f.state.challengeAction = "password_login";
  for (const origin of [primary, fallback]) {
    f.state.challengeHost = new URL(origin).hostname;
    const loggedIn = await requestAt(origin, "/api/auth/login", { email: "alice@example.test", password: PASSWORD });
    assert.equal(loggedIn.status, 200, await loggedIn.clone().text());
    assert.match(loggedIn.headers.get("Set-Cookie")!, /; Secure/);
  }
  // A valid token for one allowed domain must not authorize login on the other.
  f.state.challengeHost = new URL(fallback).hostname;
  assert.equal((await requestAt(primary, "/api/auth/login", { email: "alice@example.test", password: PASSWORD })).status, 400);
  f.state.challengeHost = "unlisted.example.test";
  assert.equal((await requestAt("https://unlisted.example.test", "/api/auth/login", { email: "alice@example.test", password: PASSWORD })).status, 400);
  f.state.challengeHost = "localhost";
  assert.equal((await requestAt("http://localhost", "/api/auth/login", { email: "alice@example.test", password: PASSWORD })).status, 400);
  f.state.challengeAction = "send_otp";
  for (const [origin, email] of [[primary, "custom@example.test"], [fallback, "fallback@example.test"]]) {
    f.state.challengeHost = new URL(origin).hostname;
    assert.equal((await requestAt(origin, "/api/auth/send-code", { email, purpose: "register" })).status, 200);
  }
  f.state.challengeHost = new URL(primary).hostname;
  assert.equal((await requestAt(primary, "/api/auth/login", { email: "alice@example.test", password: PASSWORD })).status, 400);
});

test("official Resend template retries preserve idempotency, respect retry-after and reject permanent errors", async t => {
  const calls: { body: Record<string, unknown>; key: string | null }[] = [], delays: number[] = [];
  let status = 429;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
    if (calls.length === 1) return Response.json({ name: status === 429 ? "rate_limit_exceeded" : "restricted_api_key", message: "test", statusCode: status }, { status, headers: { "Retry-After": "2" } });
    return Response.json({ id: "email-test-id" });
  });
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  Object.assign(f.env, { RESEND_API_KEY: "re_test", RESEND_FROM: "DiviWish <login@mail.example.test>", RESEND_OTP_TEMPLATE_ID: "template-test" });
  assert.equal(await sendResendOtp({ email: "alice@example.test", code: "123456", challengeId: "attempt-1" }, f.env, undefined, async ms => { delays.push(ms); }), "email-test-id");
  assert.deepEqual(delays, [2000]); assert.deepEqual(calls[0], calls[1]);
  status = 403; calls.length = 0;
  await assert.rejects(sendResendOtp({ email: "alice@example.test", code: "123456", challengeId: "attempt-2" }, f.env, undefined, async () => {}), HttpError);
  assert.equal(calls.length, 1);
});

test("refresh backfills annual/rolling dividends, fiscal year and details, derives yields and keeps account ownership", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register("bob@example.test");
  const created = await f.request("/api/stocks", "POST", { name: "中国平安", code: "601318", market: "A", sector: "保险", target_yield: 0.05 }, alice.cookie);
  const { id } = await created.json();
  f.source.fetchDividends = async () => structuredClone(DIVIDEND);
  assert.equal((await f.request(`/api/stocks/${id}/refresh`, "POST", {}, bob.cookie)).status, 404);
  assert.equal((await f.request(`/api/stocks/${id}/refresh`, "GET", undefined, alice.cookie)).status, 405);
  assert.equal((await f.request(`/api/stocks/${id}/refresh`, "POST", {}, alice.cookie, { Origin: "https://evil.test" })).status, 403);
  const refreshed = await f.request(`/api/stocks/${id}/refresh`, "POST", {}, alice.cookie);
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  assert.equal((await refreshed.json()).dividends_updated, 1);
  const detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, alice.cookie)).json();
  assert.equal(detail.annual_dividend, 2.7); assert.equal(detail.rolling_dividend, 2.8); assert.equal(detail.annual_year, 2025);
  assert.deepEqual(detail.dividends, DIVIDEND.dividends); assert.equal(detail.confirmed, true); assert.equal(detail.ex_dividend_date, "2026-07-01");
  assert.equal(detail.dividend_yield, 2.7 / 20); assert.equal(detail.rolling_yield, 2.8 / 20); assert.equal(detail.target_price, 2.7 / 0.05);
  assert.equal(detail.target_yield, 0.05); assert.ok(!("_refresh_id" in detail));
  assert.deepEqual((await (await f.request("/api/stocks", "GET", undefined, bob.cookie)).json()).stocks, []);
});

test("global refresh updates dividends even if quotes fail; later dividend failures preserve saved snapshots", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const { cookie } = await f.register();
  const { id } = await (await f.request("/api/stocks", "POST", { name: "中国平安", code: "601318", market: "A", sector: "保险", price: 50 }, cookie)).json();
  f.source.fetchQuotes = async () => { throw new Error("quote offline"); };
  f.source.fetchDividends = async () => structuredClone(DIVIDEND);
  const dividendOnly = await f.request("/api/refresh?dividends=force", "POST", {}, cookie); assert.equal(dividendOnly.status, 200);
  assert.equal((await dividendOnly.json()).dividends_updated, 1);
  const read = async () => (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  const saved = await read(); assert.equal(saved.price, 50); assert.equal(saved.annual_dividend, 2.7); assert.equal(saved.dividend_yield, 2.7 / 50);
  f.source.fetchDividends = async () => { throw new Error("report offline"); };
  assert.equal((await f.request("/api/refresh?dividends=force", "POST", {}, cookie)).status, 502);
  assert.deepEqual(await read(), saved);
  f.source.fetchQuotes = async () => ({ quotes: new Map([[id, { price: 60, quote_date: "2026-10-28" }]]), errors: [] });
  const quoteOnly = await f.request("/api/refresh?dividends=force", "POST", {}, cookie); assert.equal(quoteOnly.status, 200);
  const result = await quoteOnly.json(); assert.equal(result.quotes_updated, 1); assert.equal(result.dividends_updated, 0); assert.match(result.errors.join(""), /保留原股息/);
  const detail = await read(); assert.equal(detail.price, 60); assert.equal(detail.annual_year, 2025); assert.deepEqual(detail.dividends, saved.dividends);
});

test("refresh preserves concurrent manual dividends, price, watch and grid edits, and skips changed identities", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const { cookie } = await f.register();
  const { id } = await (await f.request("/api/stocks", "POST", { name: "中国平安", code: "601318", market: "A", sector: "保险", price: 50 }, cookie)).json();
  f.source.fetchDividends = async () => {
    const edit = await f.request(`/api/stocks/${id}`, "PATCH", { annual_dividend: 3, price: 70, watched: true, grid_end: 0.09 }, cookie); assert.equal(edit.status, 200);
    return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request("/api/refresh?dividends=force", "POST", {}, cookie)).status, 502);
  let detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.annual_dividend, 3); assert.equal(detail.price, 70); assert.equal(detail.watched, true); assert.equal(detail.grid_end, 0.09);
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, cookie)).json()).meta.last_refresh, null);
  f.source.fetchDividends = async () => {
    await f.request(`/api/stocks/${id}`, "PATCH", { grid_end: 0.1, watched: false }, cookie); return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request("/api/refresh?dividends=force", "POST", {}, cookie)).status, 200);
  detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.annual_dividend, 2.7); assert.equal(detail.price, 20); assert.equal(detail.grid_end, 0.1); assert.equal(detail.watched, false);
  f.source.fetchDividends = async () => {
    await f.request(`/api/stocks/${id}`, "PATCH", { code: "600036" }, cookie); return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request("/api/refresh?dividends=force", "POST", {}, cookie)).status, 502);
  detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.code, "600036"); assert.equal(detail.annual_dividend, null); assert.equal(detail.price, null);
});

test("Hong Kong refresh stores verified FX and supports zero dividends without treating them as missing", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const { cookie } = await f.register();
  const { id } = await (await f.request("/api/stocks", "POST", { name: "测试港股", code: "00941", market: "HK", sector: "电信" }, cookie)).json();
  f.source.fetchDividends = async () => ({ ...structuredClone(DIVIDEND), annual_dividend: 0, rolling_dividend: 0, dividend_fx_rate: 0.9 });
  f.source.fetchFx = async () => { throw new Error("FX offline"); };
  assert.equal((await f.request(`/api/stocks/${id}/refresh`, "POST", {}, cookie)).status, 200);
  const detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.annual_dividend, 0); assert.equal(detail.dividend_yield, 0); assert.equal(detail.rolling_yield, 0);
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, cookie)).json()).meta.fx_rate, 0.9);
});

test("history backfill persists samples, derives percentile/quantiles, is private and retains old data after upstream failure", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register('bob@example.test');
  const { id } = await (await f.request('/api/stocks', 'POST', { name:'招商银行',code:'600036',market:'A',sector:'银行',price:10,annual_dividend:1 }, alice.cookie)).json();
  const snapshot = { history:Array.from({length:80},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),close:10,annual:i<40?0.5:1,year:2025,yield:i<40?0.05:0.1})),
    percentile_start:'2026-01-01',percentile_end:'2026-03-21',history_source:'test',history_updated_at:'2026-03-22',history_note:'test method' };
  f.source.fetchHistory = async () => structuredClone(snapshot);
  assert.equal((await f.request(`/api/stocks/${id}/history`,'POST',{},bob.cookie)).status,404);
  assert.equal((await f.request(`/api/stocks/${id}/history`,'POST',{},alice.cookie,{Origin:'https://evil.test'})).status,403);
  const response=await f.request(`/api/stocks/${id}/history`,'POST',{},alice.cookie); assert.equal(response.status,200);
  const detail=await response.json(); assert.equal(detail.percentile_count,80); assert.equal(detail.percentile,1); assert.equal(detail.quantile_60_yield,0.1);assert.equal(detail.quantile_60_price,10);
  assert.equal((await (await f.request('/api/stocks','GET',undefined,alice.cookie)).json()).stocks[0].history,undefined);
  f.source.fetchHistory=async()=>{throw new Error('上游历史日线暂不可用');};
  const failed=await f.request(`/api/stocks/${id}/history`,'POST',{},alice.cookie);assert.equal(failed.status,502);assert.match((await failed.json()).error,/历史日线暂不可用/);
  assert.deepEqual((await (await f.request(`/api/stocks/${id}`,'GET',undefined,alice.cookie)).json()).history,detail.history);
});

test("historical backfill preserves concurrent nonfinancial settings and rejects changed dividend/security identity", async t => {
  const f=accountFixture();t.after(()=>f.db.sqlite.close());const {cookie}=await f.register();
  const {id}=await (await f.request('/api/stocks','POST',{name:'招商银行',code:'600036',market:'A',sector:'银行',annual_dividend:1},cookie)).json();
  const snapshot={history:[],percentile_start:'2021-01-01',percentile_end:'2026-01-01',history_source:'test',history_updated_at:'2026-01-01',history_note:'test'};
  f.source.fetchHistory=async()=>{await f.request(`/api/stocks/${id}`,'PATCH',{watched:true,grid_end:0.09},cookie);return snapshot;};
  assert.equal((await f.request(`/api/stocks/${id}/history`,'POST',{},cookie)).status,200);
  let detail=await (await f.request(`/api/stocks/${id}`,'GET',undefined,cookie)).json();assert.equal(detail.watched,true);assert.equal(detail.grid_end,0.09);
  f.source.fetchHistory=async()=>{await f.request(`/api/stocks/${id}`,'PATCH',{annual_dividend:2},cookie);return snapshot;};
  assert.equal((await f.request(`/api/stocks/${id}/history`,'POST',{},cookie)).status,409);
  detail=await (await f.request(`/api/stocks/${id}`,'GET',undefined,cookie)).json();assert.deepEqual(detail.history,[]);assert.equal(detail.history_updated_at,undefined);
});

test("saved historical basis and upgraded caches remain isolated to the signed-in portfolio", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register("basis-bob@example.test");
  const added = await f.request("/api/stocks", "POST", { name: "口径测试", code: "600036", market: "A", sector: "银行", price: 10, annual_dividend: 0.5, rolling_dividend: 0.6 }, alice.cookie);
  const { id } = await added.json();
  const history = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: 10, annual: 0.5, year: 2025, yield: i < 40 ? 0.02 : 0.05, rolling_yield: i < 40 ? 0.03 : 0.09 }));
  const updatedAt = new Date(Date.now() + 8 * 3600_000).toISOString();
  f.db.sqlite.prepare("UPDATE user_stocks SET document=json_set(document,'$.history',json(?),'$.history_updated_at',?) WHERE id=?")
    .run(JSON.stringify(history.map(row => ({ date: row.date, close: row.close, annual: row.annual, year: row.year, yield: row.yield }))), updatedAt, id);
  let calls = 0;
  f.source.fetchHistory = async () => { calls++; return { history, history_version: 2, history_updated_at: updatedAt,
    percentile_start: history[0].date, percentile_end: history.at(-1)!.date, history_source: "test", history_note: "test" }; };
  await f.request(`/api/stocks/${id}`, "PATCH", { yield_basis: "rolling" }, alice.cookie);
  assert.equal((await (await f.request(`/api/stocks/${id}`, "GET", undefined, alice.cookie)).json()).percentile, null);
  assert.equal((await f.request(`/api/stocks/${id}/history`, "POST", {}, bob.cookie)).status, 404);
  const detail = await (await f.request(`/api/stocks/${id}/history`, "POST", {}, alice.cookie)).json();
  assert.equal(detail.quantile_30_yield, 0.03); assert.equal(detail.quantile_30_price, 20);
  assert.equal(detail.percentile, 0.5); assert.equal(detail.quantile_60_yield, 0.09);
  assert.ok(detail.percentile_history.every((row: { yield: number }, i: number) => row.yield === history[i].rolling_yield));
  await f.request(`/api/stocks/${id}`, "PATCH", { yield_basis: "custom", custom_yield: 0.08 }, alice.cookie);
  const custom = await (await f.request(`/api/stocks/${id}/history`, "POST", {}, alice.cookie)).json();
  assert.equal(calls, 1); assert.equal(custom.percentile, 1); assert.equal(custom.quantile_60_price, 10);
  assert.ok(custom.percentile_history.every((row: { yield: number }) => row.yield === 0.08));
  assert.equal((await f.request(`/api/stocks/${id}`, "GET", undefined, bob.cookie)).status, 404);
  assert.ok(!("percentile_history" in (await (await f.request("/api/stocks", "GET", undefined, alice.cookie)).json()).stocks[0]));
});

test("BOLL reuses only public band data across requests and force refresh honors each account's own quote", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register('boll-bob@example.test');
  const create = async (cookie: string, price: number, quoteDate: string) => {
    const response = await f.request('/api/stocks', 'POST', {code:'600036',name:'招商银行',market:'A',sector:'银行',price},cookie);
    assert.equal(response.status,201,await response.clone().text());
    const {id} = await response.json();
    f.db.sqlite.prepare("UPDATE user_stocks SET document=json_set(document,'$.quote_date',?) WHERE id=?").run(quoteDate,id);
    return id;
  };
  const a = await create(alice.cookie,40,'2026-10-30'), b = await create(bob.cookie,60,'2026-10-31');
  let calls = 0;
  f.source.fetchKline = async () => {
    calls++;
    return { bars: Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,close:30+i})),adjustment:'qfq',quote:{price:50,quote_date:'2026-10-29'} };
  };
  assert.equal((await f.request(`/api/stocks/${a}/boll`)).status,401);
  const first = await (await f.request(`/api/stocks/${a}/boll`,'GET',undefined,alice.cookie)).json();
  assert.equal(first.price,40); assert.equal(first.cached,false); assert.equal(calls,3);
  const second = await (await f.request(`/api/stocks/${b}/boll`,'GET',undefined,bob.cookie)).json();
  assert.equal(second.price,60); assert.equal(second.cached,true); assert.equal(calls,3);
  assert.equal((await f.request(`/api/stocks/${a}/boll`,'GET',undefined,bob.cookie)).status,404);
  const forced = await (await f.request(`/api/stocks/${a}/boll?refresh=1`,'GET',undefined,alice.cookie)).json();
  assert.equal(forced.price,40); assert.equal(forced.cached,false); assert.equal(calls,6);
});


test("account refresh saves yearly metrics with owner isolation and preserves concurrent baseline edits", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register("bob@example.test");
  const stock = await (await f.request("/api/stocks", "POST", { code: "600036", market: "A", name: "招商银行", sector: "银行" }, alice.cookie)).json();
  f.source.fetchQuotes = async () => ({ quotes: new Map([[stock.id, { price: 43.55, quote_date: "2026-10-30", year_start_price: 40.084, year_start_date: "2025-12-31", year_start_year: 2026, year_start_adjustment: "qfq" }]]), errors: [] });
  f.source.fetchDividends = async () => ({ ...DIVIDEND, annual_dividend: 2.016, annual_eps: 5.7, annual_eps_year: 2025, annual_eps_currency: "CNY" });
  assert.equal((await f.request(`/api/stocks/${stock.id}/refresh`, "POST", {}, alice.cookie)).status, 200);
  const detail = await (await f.request(`/api/stocks/${stock.id}`, "GET", undefined, alice.cookie)).json();
  assert.equal(detail.year_change, 43.55 / 40.084 - 1); assert.equal(detail.payout_ratio, 2.016 / 5.7);
  assert.equal((await f.request(`/api/stocks/${stock.id}`, "GET", undefined, bob.cookie)).status, 404);
  f.source.fetchQuotes = async () => {
    await f.request(`/api/stocks/${stock.id}`, "PATCH", { year_start_price: 50 }, alice.cookie);
    return { quotes: new Map([[stock.id, { price: 99, quote_date: "2026-10-30", year_start_price: 40 }]]), errors: [] };
  };
  await f.request(`/api/stocks/${stock.id}/refresh`, "POST", {}, alice.cookie);
  const edited = await (await f.request(`/api/stocks/${stock.id}`, "GET", undefined, alice.cookie)).json();
  assert.equal(edited.year_start_price, 50); assert.equal(edited.price, 43.55);
  await f.request(`/api/stocks/${stock.id}`, "PATCH", { annual_dividend: 1 }, alice.cookie);
  assert.equal((await (await f.request(`/api/stocks/${stock.id}`, "GET", undefined, alice.cookie)).json()).payout_ratio, null);
});

test("new email accounts receive private defaults once; deleting them and signing in keeps the portfolio empty", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register("starter-alice@example.test", PASSWORD, true), bob = await f.register("starter-bob@example.test", PASSWORD, true);
  const list = await (await f.request("/api/stocks", "GET", undefined, alice.cookie)).json();
  assert.deepEqual(list.stocks.map((s: { code: string }) => s.code), ["600036", "510880"]);
  assert.deepEqual(list.sectors, ["未分类", "银行", "ETF"]);
  assert.equal(list.stocks[1].instrument_type, "etf"); assert.equal(list.stocks[1].exchange, "sh");
  assert.equal(list.stocks[1].yield_basis, "rolling"); assert.equal(list.stocks[1].price, null);
  const other = await (await f.request("/api/stocks", "GET", undefined, bob.cookie)).json();
  assert.ok(other.stocks.every((s: { id: number }) => !list.stocks.some((a: { id: number }) => a.id === s.id)));
  for (const stock of list.stocks) await f.request(`/api/stocks/${stock.id}`, "DELETE", undefined, alice.cookie);
  const login = await f.request("/api/auth/login", "POST", { email: alice.user.email, password: PASSWORD });
  assert.equal(login.status, 200); const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  assert.deepEqual((await (await f.request("/api/stocks", "GET", undefined, cookie)).json()).stocks, []);
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, bob.cookie)).json()).stocks.length, 2);
});

test("existing accounts, including previously emptied ones, only gain the ETF category once", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register();
  f.db.sqlite.prepare("DELETE FROM user_metadata WHERE user_id=?").run(alice.user.id);
  f.db.sqlite.prepare("DELETE FROM user_sectors WHERE user_id=? AND name='ETF'").run(alice.user.id);
  const created = await (await f.request("/api/stocks", "POST", { code: "600036", market: "A", name: "旧记录", sector: "自定义板块", watched: true, price: 12.3 }, alice.cookie)).json();
  const before = await (await f.request(`/api/stocks/${created.id}`, "GET", undefined, alice.cookie)).json();
  const list = await (await f.request("/api/stocks", "GET", undefined, alice.cookie)).json();
  assert.equal(list.stocks.length, 1); assert.ok(list.sectors.includes("ETF"));
  assert.deepEqual(await (await f.request(`/api/stocks/${created.id}`, "GET", undefined, alice.cookie)).json(), before);
  await f.request(`/api/stocks/${created.id}`, "DELETE", undefined, alice.cookie);
  assert.deepEqual((await (await f.request("/api/stocks", "GET", undefined, alice.cookie)).json()).stocks, []);
  const sectors = await (await f.request("/api/sectors", "GET", undefined, alice.cookie)).json();
  const etf = sectors.sectors.find((s: { name: string }) => s.name === "ETF");
  await f.request(`/api/sectors/${etf.id}`, "DELETE", undefined, alice.cookie);
  assert.ok(!(await (await f.request("/api/stocks", "GET", undefined, alice.cookie)).json()).sectors.includes("ETF"));
});

test("new account and its defaults roll back together if a starter insert fails", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  f.db.sqlite.exec("CREATE TRIGGER fail_starter BEFORE INSERT ON user_stocks WHEN NEW.code='510880' BEGIN SELECT RAISE(ABORT,'starter test failure'); END");
  const message = await f.code("rollback@example.test");
  const failed = await f.request("/api/auth/register", "POST", { ...message, password: PASSWORD });
  assert.equal(failed.status, 500);
  for (const table of ["users", "user_stocks", "user_metadata", "auth_sessions"]) assert.equal(f.db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  f.db.sqlite.exec("DROP TRIGGER fail_starter"); f.state.now += 61;
  const success = await f.register("rollback@example.test", PASSWORD, true);
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, success.cookie)).json()).stocks.length, 2);
});


test("portfolio dividend continuation persists across handlers, ignores single refreshes and stays account-owned", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register();
  const bob = await f.register("bob@example.test");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls: string[] = [];
  f.source.fetchQuotes = async () => ({ quotes: new Map(), errors: [] });
  f.source.fetchDividends = async stock => {
    calls.push(stock.code);
    if (calls.length % 4 === 0) now += 20_000;
    return structuredClone(DIVIDEND);
  };
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) {
    const response = await f.request("/api/stocks", "POST", { code: String(600001 + i), market: "A", name: `股票${i}`, sector: "银行" }, alice.cookie);
    assert.equal(response.status, 201);
    ids.push((await response.json()).id);
  }
  const bobStock = await (await f.request("/api/stocks", "POST", { code: "600001", market: "A", name: "Bob股票", sector: "银行" }, bob.cookie)).json();
  const first = await (await f.request("/api/refresh", "POST", {}, alice.cookie)).json();
  assert.equal(first.dividends_updated, 8);
  assert.ok(first.errors.some((error: string) => error.includes("其余 4 支")));
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM user_metadata WHERE user_id=? AND key='dividend_refresh_cursor'").get(bob.user.id)!.n, 0);
  await f.request(`/api/stocks/${ids[11]}/refresh`, "POST", {}, alice.cookie);
  await f.request(`/api/stocks/${ids[7]}`, "DELETE", undefined, alice.cookie);
  calls = [];
  const restarted = createHandler(f.source, { clock: () => f.state.now });
  const response = await restarted(new Request("http://localhost/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: alice.cookie }, body: "{}",
  }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["600009", "600010", "600011"]); // The last stock is already cached.
  for (const id of ids.slice(8)) assert.equal((await (await f.request(`/api/stocks/${id}`, "GET", undefined, alice.cookie)).json()).annual_dividend, 2.7);
  assert.equal((await (await f.request(`/api/stocks/${bobStock.id}`, "GET", undefined, bob.cookie)).json()).annual_dividend, null);
  calls = [];
  assert.equal((await f.request("/api/refresh", "POST", {}, bob.cookie)).status, 200);
  assert.deepEqual(calls, []); // Bob reuses Alice's public snapshot, never her personal row.
});

test("failed dividend batches advance only the owner's continuation without changing stock data or refresh dates", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const { cookie, user } = await f.register();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls: string[] = [];
  f.source.fetchQuotes = async () => ({ quotes: new Map(), errors: [] });
  f.source.fetchDividends = async stock => {
    calls.push(stock.code); now += 40_000;
    throw new Error("offline");
  };
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const saved = await (await f.request("/api/stocks", "POST", { code: String(600001 + i), market: "A", name: `股票${i}`, sector: "银行", annual_dividend: 0.8 }, cookie)).json();
    ids.push(saved.id);
  }
  const before = await (await f.request(`/api/stocks/${ids[0]}`, "GET", undefined, cookie)).json();
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 502);
  assert.equal(calls.length, 4);
  assert.deepEqual(await (await f.request(`/api/stocks/${ids[0]}`, "GET", undefined, cookie)).json(), before);
  assert.equal(f.db.sqlite.prepare("SELECT value FROM user_metadata WHERE user_id=? AND key='last_refresh'").get(user.id), undefined);
  calls = [];
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 502);
  assert.equal(calls[0], "600005");
});


test("daily dividends are shared across accounts while quotes display first and private settings remain isolated", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register(), bob = await f.register("bob-cache@example.test");
  const add = async (cookie: string, sector: string, target_yield: number, annual_dividend: number) =>
    (await f.request("/api/stocks", "POST", { code: "562060", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector, target_yield, annual_dividend }, cookie)).json();
  const a = await add(alice.cookie, "Alice板块", 0.05, 999), b = await add(bob.cookie, "Bob板块", 0.08, 777);
  await f.request(`/api/stocks/${a.id}`, "PATCH", { watched: true }, alice.cookie);
  let calls = 0, started = () => {}, release = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.source.fetchDividends = async identity => {
    calls++; assert.equal(identity.code, "562060"); assert.equal(identity.annual_dividend, null);
    assert.equal(identity.sector, "未分类"); assert.equal(identity.watched, false);
    started(); await gate; return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request(`/api/stocks/${a.id}/refresh?phase=quotes`, "POST", {}, alice.cookie)).status, 200);
  assert.equal((await f.request(`/api/stocks/${b.id}/refresh?phase=quotes`, "POST", {}, bob.cookie)).status, 200);
  assert.equal(calls, 0);
  const read = async (id: number, cookie: string) => (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal((await read(a.id, alice.cookie)).price, 20);
  const first = f.request(`/api/stocks/${a.id}/refresh?phase=dividends`, "POST", {}, alice.cookie);
  try {
    await ready;
    const pending = await f.request(`/api/stocks/${b.id}/refresh?phase=dividends`, "POST", {}, bob.cookie);
    assert.equal(pending.status, 502); assert.match(JSON.stringify(await pending.json()), /正在更新/);
    assert.equal((await read(b.id, bob.cookie)).annual_dividend, 777);
    release(); assert.equal((await first).status, 200);
    const cached = await f.request(`/api/stocks/${b.id}/refresh?phase=dividends`, "POST", {}, bob.cookie);
    assert.equal(cached.status, 200); assert.equal((await cached.json()).dividends_cached, 1); assert.equal(calls, 1);
    const aliceStock = await read(a.id, alice.cookie), bobStock = await read(b.id, bob.cookie);
    assert.equal(aliceStock.annual_dividend, 2.7); assert.equal(bobStock.annual_dividend, 2.7);
    assert.equal(aliceStock.sector, "Alice板块"); assert.equal(bobStock.sector, "Bob板块");
    assert.equal(aliceStock.watched, true); assert.equal(bobStock.watched, false);
    assert.equal(aliceStock.target_yield, 0.05); assert.equal(bobStock.target_yield, 0.08);
    const preview = await f.request("/api/stocks/preview?code=562060&market=A&instrument_type=etf&exchange=sh", "GET", undefined, bob.cookie);
    assert.equal((await preview.json()).dividends.annual_dividend, 2.7); assert.equal(calls, 1);
    await f.request(`/api/stocks/${a.id}`, "PATCH", { annual_dividend: 123 }, alice.cookie);
    await f.request(`/api/stocks/${b.id}/refresh?phase=dividends`, "POST", {}, bob.cookie);
    assert.equal((await read(a.id, alice.cookie)).annual_dividend, 123);
    assert.equal((await read(b.id, bob.cookie)).annual_dividend, 2.7);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM public_dividend_cache").get()!.n, 1);
    const stored = JSON.parse(f.db.sqlite.prepare("SELECT snapshot FROM public_dividend_cache").get()!.snapshot as string);
    assert.equal(stored.annual_dividend, 2.7);
    for (const key of ["user_id", "sector", "watched", "target_yield", "price", "history"]) assert.ok(!(key in stored), key);
    assert.equal((await f.request(`/api/stocks/${a.id}/refresh?phase=dividends`, "POST", {}, bob.cookie)).status, 404);
    assert.equal((await f.request("/api/refresh?phase=invalid", "POST", {}, alice.cookie)).status, 400);
  } finally { release(); await first; }
});

test("manual forecasts and disabled automatic routes remain owner-scoped", async t => {
  const f = accountFixture(); t.after(() => f.db.sqlite.close());
  const alice = await f.register("forecast-alice@example.test"), bob = await f.register("forecast-bob@example.test");
  const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const add = async (cookie: string) => {
    const response = await f.request("/api/stocks", "POST", { code: "601665", market: "A", name: "测试股票", sector: "银行", price: 10, yield_basis: "forecast" }, cookie);
    assert.equal(response.status, 201); return (await response.json()).id as number;
  };
  const first = await add(alice.cookie), second = await add(bob.cookie);
  const manual = { year, kind: "per_share", value: 2, currency: "CNY", note: "alice-private-estimate" };
  assert.equal((await f.request(`/api/stocks/${first}/forecast`, "POST", {})).status, 401);
  assert.equal((await f.request(`/api/stocks/${first}/forecast`, "GET", undefined, bob.cookie)).status, 404);
  assert.equal((await f.request(`/api/stocks/${first}`, "PATCH", { forecast_manual: manual }, bob.cookie)).status, 404);
  assert.equal((await f.request(`/api/stocks/${first}`, "PATCH", { forecast_manual: manual }, alice.cookie)).status, 200);
  assert.equal((await f.request(`/api/stocks/${first}/forecast`, "POST", {}, alice.cookie)).status, 410);
  const a = await (await f.request(`/api/stocks/${first}`, "GET", undefined, alice.cookie)).json();
  const b = await (await f.request(`/api/stocks/${second}`, "GET", undefined, bob.cookie)).json();
  assert.equal(a.forecast.dividend, 2); assert.equal(b.forecast.dividend, null); assert.equal(b.forecast_manual, undefined);
  assert.equal((await f.request(`/api/stocks/${first}`, "PATCH", { forecast_manual: null }, bob.cookie)).status, 404);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM public_forecast_cache").get()!.n, 0);
});
