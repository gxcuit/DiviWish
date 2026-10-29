import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHandler } from "../index.ts";
import { digest } from "../auth.ts";
import type { Env } from "../types.ts";
import { TestDatabase } from "./helpers.ts";

const ORIGIN = "https://app.example.test";
const PATH = "/api/auth/linuxdo";
function fixture() {
  const db = new TestDatabase();
  for (const name of ["0002_accounts.sql", "0003_passwords.sql", "0004_linuxdo.sql"]) db.sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const env: Env = { DB: db.binding, APP_ORIGIN: ORIGIN, AUTH_EMAIL_MODE: "resend", AUTH_SECRET: "x".repeat(64),
    TURNSTILE_SECRET_KEY: "test", TURNSTILE_SITE_KEY: "test", LINUXDO_CLIENT_ID: "test-client", LINUXDO_CLIENT_SECRET: "test-secret" };
  const state = { now: Math.floor(Date.now() / 1000), calls: 0, fail: false, redirectAt: "",
    profile: { id: 42 as number | string, username: "alice", active: true, silenced: false, email: "existing@example.test" } };
  const handler = createHandler(undefined, { clock: () => state.now, fetcher: async (input, init) => {
    state.calls++;
    // Reproduce Workers' unsupported redirect mode rather than silently
    // accepting the browser/Node-only "error" mode in the mock fetcher.
    if (init?.redirect === "error") throw new TypeError("Unsupported redirect mode");
    assert.equal(init?.redirect, "manual");
    if (state.redirectAt && String(input).endsWith(state.redirectAt)) return new Response(null, { status: 302, headers: { Location: "https://untrusted.example.test/collect" } });
    if (state.fail) return new Response("secret provider error", { status: 500 });
    if (String(input).endsWith("/oauth2/token")) {
      const form = new URLSearchParams(String(init!.body));
      assert.equal(form.get("client_id"), env.LINUXDO_CLIENT_ID);
      assert.equal(form.get("client_secret"), env.LINUXDO_CLIENT_SECRET);
      assert.equal(form.get("redirect_uri"), `${ORIGIN}${PATH}/callback`);
      assert.equal(form.get("grant_type"), "authorization_code");
      return Response.json({ access_token: "private-provider-token", token_type: "Bearer" });
    }
    assert.equal(String(input), "https://connect.linux.do/api/user");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-provider-token");
    return Response.json(state.profile);
  } });
  const request = (path: string, cookie = "", method = "GET", extra: Record<string, string> = {}, body: unknown = {}) => handler(new Request(`${ORIGIN}${path}`, {
    method, headers: { Cookie: cookie, ...(method === "POST" ? { "Content-Type": "application/json", Origin: ORIGIN } : {}), ...extra },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  }), env);
  async function begin(cookie = "", link = false) {
    const response = await request(`${PATH}/${link ? "link" : "start"}`, cookie, link ? "POST" : "GET");
    assert.equal(response.status, link ? 200 : 302, await response.clone().text());
    const location = new URL(link ? (await response.json()).url : response.headers.get("Location")!);
    assert.equal(location.origin, "https://connect.linux.do");
    assert.equal(location.searchParams.get("scope"), "user");
    assert.ok(!location.href.includes(env.LINUXDO_CLIENT_SECRET!));
    const browser = response.headers.getSetCookie()[0].split(";")[0];
    const callback = `${PATH}/callback?code=test-code&state=${location.searchParams.get("state")}`;
    return { response, browser, callback };
  }
  async function login(previousCookie = "") {
    const flow = await begin(previousCookie);
    const response = await request(flow.callback, `${flow.browser}; ${previousCookie}`);
    assert.equal(response.headers.get("Location"), `${ORIGIN}/discovery`);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("diviwish_session="))!.split(";")[0];
    const user = (await (await request("/api/auth/session", cookie)).json()).user;
    return { user, cookie, response };
  }
  return { db, env, state, handler, request, begin, login };
}

test("LinuxDO creates a private account without a mailbox/password, rotates sessions and retains data after username changes", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const first = await f.login();
  assert.equal(first.user.email, null); assert.equal(first.user.hasPassword, false); assert.equal(first.user.linuxdoUsername, "alice");
  assert.equal(first.response.headers.getSetCookie().length, 2);
  assert.match(first.response.headers.getSetCookie().join(";"), /HttpOnly; SameSite=Lax/);
  assert.match(first.response.headers.getSetCookie().join(";"), /; Secure/);
  f.db.sqlite.prepare("INSERT INTO user_metadata(user_id,key,value) VALUES(?,'test',?)").run(first.user.id, JSON.stringify("saved"));
  const added = await f.request("/api/stocks", first.cookie, "POST", {}, { code: "600036", market: "A", name: "保留股票", sector: "银行", price: 10 });
  assert.equal(added.status, 201, await added.clone().text()); const stockId = (await added.json()).id;
  f.state.profile.username = "renamed";
  const again = await f.login(first.cookie);
  assert.equal((await f.request("/api/stocks", first.cookie)).status, 401); assert.equal(again.user.id, first.user.id); assert.equal(again.user.linuxdoUsername, "renamed");
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n, 1);
  assert.equal(f.db.sqlite.prepare("SELECT value FROM user_metadata WHERE user_id=?").get(first.user.id)!.value, '"saved"');
  assert.equal((await (await f.request("/api/stocks", again.cookie)).json()).stocks[0].id, stockId);
  f.state.profile.id = 43; const other = await f.login();
  assert.equal((await f.request(`/api/stocks/${stockId}`, other.cookie)).status, 404);
  assert.equal((await f.request(`/api/stocks/${stockId}`, other.cookie, "DELETE")).status, 404);
  assert.equal((await f.request("/api/auth/logout", again.cookie, "POST")).status, 200);
  assert.equal((await f.request("/api/stocks", again.cookie)).status, 401);
  assert.equal((await (await f.request("/api/auth/config")).json()).linuxdoEnabled, true);
  f.env.LINUXDO_CLIENT_SECRET = "";
  assert.equal((await (await f.request("/api/auth/config")).json()).linuxdoEnabled, false);
  assert.equal((await f.request(`${PATH}/start`)).status, 503);
});

test("state requires the initiating browser, expires, and can be consumed only once", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const flow = await f.begin();
  assert.match((await f.request(flow.callback)).headers.get("Location")!, /auth_error=/);
  assert.equal(f.state.calls, 0);
  assert.match((await f.request(flow.callback, "diviwish_linuxdo_state=" + "f".repeat(64))).headers.get("Location")!, /auth_error=/);
  assert.equal(f.state.calls, 0);
  assert.equal((await f.request(flow.callback, flow.browser)).headers.get("Location"), `${ORIGIN}/discovery`);
  assert.match((await f.request(flow.callback, flow.browser)).headers.get("Location")!, /auth_error=/);
  assert.equal(f.state.calls, 2);
  const expired = await f.begin(); f.state.now += 601;
  assert.match((await f.request(expired.callback, expired.browser)).headers.get("Location")!, /auth_error=/);
  assert.equal(f.state.calls, 2);
});

test("cancelled authorization, provider failure, and inactive or malformed profiles never issue a session", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const cancelled = await f.begin();
  const denied = await f.request(cancelled.callback + "&error=access_denied&error_description=secret", cancelled.browser);
  assert.match(denied.headers.get("Location")!, /auth_error=/); assert.ok(!denied.headers.get("Location")!.includes("secret"));
  assert.equal(f.state.calls, 0);
  for (const profile of [{ active: false }, { silenced: true }, { id: "untrusted" }]) {
    const before = { ...f.state.profile }; Object.assign(f.state.profile, profile);
    const flow = await f.begin(); const response = await f.request(flow.callback, flow.browser);
    assert.match(response.headers.get("Location")!, /auth_error=/); assert.ok(!response.headers.getSetCookie().some(value => value.startsWith("diviwish_session=")));
    f.state.profile = before;
  }
  f.state.fail = true; const flow = await f.begin();
  const failed = await f.request(flow.callback, flow.browser);
  assert.match(failed.headers.get("Location")!, /auth_error=/); assert.ok(!failed.headers.get("Location")!.includes("secret"));
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n, 0);
});

test("binding requires the original live session, preserves email/password/data and never merges by provider email", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.db.sqlite.prepare("INSERT INTO users(id,email,created_at,password_hash) VALUES('existing','existing@example.test',?,'saved-hash')").run(f.state.now);
  const emailToken = "e".repeat(64), emailCookie = `diviwish_session=${emailToken}`;
  f.db.sqlite.prepare("INSERT INTO auth_sessions VALUES(?,'existing',?,?)").run(await digest(emailToken), f.state.now + 3600, f.state.now);
  assert.equal((await f.request(`${PATH}/link`, "", "POST")).status, 401);
  assert.equal((await f.request(`${PATH}/link`, emailCookie, "GET")).status, 405);
  assert.equal((await f.request(`${PATH}/link`, emailCookie, "POST", { Origin: "https://evil.test" })).status, 403);
  const flow = await f.begin(emailCookie, true);
  const response = await f.request(flow.callback, `${flow.browser}; ${emailCookie}`);
  assert.equal(response.headers.get("Location"), `${ORIGIN}/discovery?linuxdo=linked`);
  const after = (await (await f.request("/api/auth/session", emailCookie)).json()).user;
  assert.equal(after.email, "existing@example.test"); assert.equal(after.hasPassword, true); assert.equal(after.linuxdoUsername, "alice");
  assert.equal((await f.login()).user.id, "existing");
  assert.equal((await f.request(`${PATH}/link`, emailCookie, "POST")).status, 409);
  f.state.profile.id = 99;
  const separate = await f.login(); assert.notEqual(separate.user.id, "existing"); assert.equal(separate.user.email, null);
});

test("binding rejects changed/revoked sessions and identities already owned by another account", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  await f.login();
  f.db.sqlite.prepare("INSERT INTO users(id,email,created_at) VALUES('other','other@example.test',?)").run(f.state.now);
  const value = "a".repeat(64), cookie = `diviwish_session=${value}`;
  f.db.sqlite.prepare("INSERT INTO auth_sessions VALUES(?,'other',?,?)").run(await digest(value), f.state.now + 3600, f.state.now);
  const conflict = await f.begin(cookie, true);
  assert.match((await f.request(conflict.callback, `${conflict.browser}; ${cookie}`)).headers.get("Location")!, /discovery\?auth_error=/);
  const revoked = await f.begin(cookie, true);
  await f.request("/api/auth/logout", cookie, "POST");
  const before = f.state.calls;
  assert.match((await f.request(revoked.callback, `${revoked.browser}; ${cookie}`)).headers.get("Location")!, /auth_error=/);
  assert.equal(f.state.calls, before);
  assert.equal(f.db.sqlite.prepare("SELECT linuxdo_id FROM users WHERE id='other'").get()!.linuxdo_id, null);
});

test("alternate domains redirect to the registered origin before setting cookies and cannot accept a callback", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const response = await f.handler(new Request(`https://alternate.example.test${PATH}/start`), f.env);
  assert.equal(response.headers.get("Location"), `${ORIGIN}${PATH}/start`); assert.equal(response.headers.get("Set-Cookie"), null);
  const flow = await f.begin();
  const callback = await f.handler(new Request(`https://alternate.example.test${flow.callback}`, { headers: { Cookie: flow.browser } }), f.env);
  assert.match(callback.headers.get("Location")!, /auth_error=/); assert.equal(f.state.calls, 0);
});


test("provider redirects are rejected at both credential-bearing endpoints without following Location", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  for (const [endpoint, calls] of [["/oauth2/token", 1], ["/api/user", 2]] as const) {
    f.state.redirectAt = endpoint; f.state.calls = 0;
    const flow = await f.begin();
    const response = await f.request(flow.callback, flow.browser);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("Location")!).origin, ORIGIN);
    assert.match(new URL(response.headers.get("Location")!).searchParams.get("auth_error")!, /LinuxDO 服务暂不可用/);
    assert.equal(f.state.calls, calls);
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith("diviwish_session=")));
  }
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n, 0);
});
