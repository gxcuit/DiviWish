import { createHandler } from "../../index.ts";
import type { Env } from "../../types.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

// Used only by scripts/test-linuxdo-runtime.mjs with a fresh local D1 database.
// Native Request construction checks workerd compatibility; provider responses
// are simulated, so no real credentials or LinuxDO accounts are involved.
export const nativeOAuthTest = { async fetch(_request: Request, env: Env) {
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
    return Response.json({ runtime: "workerd", callback: true, session: true, portfolio: true, replayRejected: true, providerRedirectsRejected: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Native OAuth test failed" }, { status: 500 });
  }
} };

export default nativeOAuthTest;
