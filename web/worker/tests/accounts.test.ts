import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { digest, normalizeEmail } from "../auth.ts";
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
  async function register(email = "alice@example.test", password = PASSWORD) {
    const message = await code(email);
    const response = await request("/api/auth/register", "POST", { ...message, password });
    assert.equal(response.status, 201, await response.clone().text());
    return { user: (await response.json()).user as User, cookie: response.headers.get("Set-Cookie")!.split(";")[0], response, message };
  }
  return { db, emails, state, env, source, request, code, register, handler };
}

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
  assert.deepEqual(list.stocks, []); assert.deepEqual(list.sectors, ["未分类"]);
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
  const preview = () => f.request("/api/stocks/preview?market=A&code=601318", "GET", undefined, cookie);
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
  const dividendOnly = await f.request("/api/refresh", "POST", {}, cookie); assert.equal(dividendOnly.status, 200);
  assert.equal((await dividendOnly.json()).dividends_updated, 1);
  const read = async () => (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  const saved = await read(); assert.equal(saved.price, 50); assert.equal(saved.annual_dividend, 2.7); assert.equal(saved.dividend_yield, 2.7 / 50);
  f.source.fetchDividends = async () => { throw new Error("report offline"); };
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 502);
  assert.deepEqual(await read(), saved);
  f.source.fetchQuotes = async () => ({ quotes: new Map([[id, { price: 60, quote_date: "2026-10-28" }]]), errors: [] });
  const quoteOnly = await f.request("/api/refresh", "POST", {}, cookie); assert.equal(quoteOnly.status, 200);
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
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 502);
  let detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.annual_dividend, 3); assert.equal(detail.price, 70); assert.equal(detail.watched, true); assert.equal(detail.grid_end, 0.09);
  assert.equal((await (await f.request("/api/stocks", "GET", undefined, cookie)).json()).meta.last_refresh, null);
  f.source.fetchDividends = async () => {
    await f.request(`/api/stocks/${id}`, "PATCH", { grid_end: 0.1, watched: false }, cookie); return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 200);
  detail = await (await f.request(`/api/stocks/${id}`, "GET", undefined, cookie)).json();
  assert.equal(detail.annual_dividend, 2.7); assert.equal(detail.price, 20); assert.equal(detail.grid_end, 0.1); assert.equal(detail.watched, false);
  f.source.fetchDividends = async () => {
    await f.request(`/api/stocks/${id}`, "PATCH", { code: "600036" }, cookie); return structuredClone(DIVIDEND);
  };
  assert.equal((await f.request("/api/refresh", "POST", {}, cookie)).status, 502);
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
