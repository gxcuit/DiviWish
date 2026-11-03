import { createHandler } from "../../index.ts";
import type { Env } from "../../types.ts";
import { dailyDividend } from "../../dividend-cache.ts";
import { providers } from "../../providers.ts";
import { validate } from "../../validation.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Used only by scripts/test-linuxdo-runtime.mjs with a fresh local D1 database.
// Native Request construction checks workerd compatibility; provider responses
// are simulated, so no real credentials or LinuxDO accounts are involved.
export const nativeOAuthTest = { async fetch(requestInfo: Request, env: Env) {
  if (new URL(requestInfo.url).pathname === "/health") return Response.json({ status: "ready" });
  let redirectAt = "", providerCalls = 0;
  const handler = createHandler(undefined, { fetcher: async (input, init) => {
    const outgoing = new Request(input, init);
    providerCalls++;
    check(outgoing.redirect === "manual", "Provider requests must not follow redirects");
    if (redirectAt && outgoing.url.endsWith(redirectAt)) return new Response(null, {
      status: 302, headers: { Location: "https://untrusted.example.test/collect" },
    });
    return outgoing.url.endsWith("/oauth2/token")
      ? Response.json({ access_token: "test-native-token", token_type: "Bearer" })
      : Response.json({ id: 424242, username: "native_test", active: true, silenced: false });
  } });
  const origin = env.APP_ORIGIN, prefix = "/api/auth/linuxdo";
  const request = (path: string, cookie = "") => handler(new Request(origin + path, { headers: { Cookie: cookie } }), env);
  async function start() {
    const response = await request(`${prefix}/start`);
    check(response.status === 302, "Authorization start failed");
    const state = new URL(response.headers.get("Location")!).searchParams.get("state");
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    return { path: `${prefix}/callback?code=test-native-code&state=${state}`, cookie };
  }
  try {
    const flow = await start(), callback = await request(flow.path, flow.cookie);
    check(callback.headers.get("Location") === `${origin}/discovery`, "Native OAuth callback failed");
    const session = callback.headers.get("Set-Cookie")?.match(/diviwish_session=[a-f0-9]{64}/)?.[0];
    check(session, "Session cookie was not issued");
    const account = await (await request("/api/auth/session", session)).json() as { user: { email: string | null; linuxdoUsername: string } };
    check(account.user.email === null && account.user.linuxdoUsername === "native_test", "Native session lookup failed");
    const stocks = await request("/api/stocks", session);
    check(stocks.status === 200, "Native account cannot access its portfolio");
    check(providerCalls === 2, "Unexpected provider calls");
    const replay = await request(flow.path, flow.cookie);
    check(new URL(replay.headers.get("Location")!).searchParams.has("auth_error") && providerCalls === 2, "Callback replay was accepted");
    for (const endpoint of ["/oauth2/token", "/api/user"]) {
      redirectAt = endpoint;
      const deniedFlow = await start(), denied = await request(deniedFlow.path, deniedFlow.cookie);
      const location = new URL(denied.headers.get("Location")!);
      check(location.origin === origin && location.searchParams.has("auth_error"), "Provider redirect was accepted");
      check(!denied.headers.get("Set-Cookie")?.includes("diviwish_session="), "Provider redirect issued a session");
    }
    let dividendCalls = 0;
    const source = { ...providers, fetchDividends: async () => {
      dividendCalls++;
      return { annual_dividend: 0.5, rolling_dividend: 0.6, annual_year: 2025, confirmed: true,
        ex_dividend_date: null, dividends: [], dividend_source: "native test", dividend_updated_at: "2026-11-03", dividend_fx_rate: null };
    } };
    const stock = validate({ code: "562060", market: "A", instrument_type: "etf", exchange: "sh", name: "native ETF", sector: "ETF" });
    const fetched = await dailyDividend(env.DB, stock, source);
    const cached = await dailyDividend(env.DB, { ...stock, annual_dividend: 999 }, source);
    check(!fetched.cached && cached.cached && dividendCalls === 1 && cached.snapshot.annual_dividend === 0.5, "Native daily D1 cache failed");
    const next = { ...stock, code: "515180" };
    let release = () => {}, started = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const slow = { ...source, fetchDividends: async () => { started(); await gate; return source.fetchDividends(); } };
    const pending = dailyDividend(env.DB, next, slow);
    try {
      await ready;
      let deduplicated = false;
      try { await dailyDividend(env.DB, next, source); } catch { deduplicated = true; }
      check(deduplicated && dividendCalls === 1, "Native cross-request D1 lease failed");
    } finally { release(); await pending; }
    return Response.json({ runtime: "workerd", callback: true, session: true, portfolio: true, replayRejected: true, providerRedirectsRejected: true, dailyDividends: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Native OAuth test failed" }, { status: 500 });
  }
} };

export default nativeOAuthTest;
