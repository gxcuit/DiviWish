import { currentUser, digest, rateLimit, sessionCookie, sessionToken, signedDigest, token } from "./auth.ts";
import { HttpError, json, loopback } from "./http.ts";
import type { Env } from "./types.ts";

const BASE = "https://connect.linux.do";
const PREFIX = "/api/auth/linuxdo";
const COOKIE = "diviwish_linuxdo_state";
const TTL = 600;
const SESSION_SECONDS = 30 * 24 * 3600;

function redirect(location: string, cookie?: string) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
}

function stateCookie(value: string, env: Env) {
  return `${COOKIE}=${value}; Path=${PREFIX}; HttpOnly; SameSite=Lax; Max-Age=${value ? TTL : 0}${new URL(env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`;
}

// Workers supports only follow/manual (not redirect:"error"). Manual mode
// plus the non-2xx check rejects redirects without forwarding credentials.
async function providerJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(502, "LinuxDO 服务暂不可用，请重新登录");
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, "LinuxDO 返回了无效数据");
  let text = "", length = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) { await reader.cancel(); throw new HttpError(502, "LinuxDO 返回数据过大"); }
    text += decoder.decode(value, { stream: true });
  }
  const data: unknown = JSON.parse(text + decoder.decode());
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(502, "LinuxDO 返回了无效数据");
  return data as Record<string, unknown>;
}

export function createLinuxdoAuth({ fetcher = fetch, clock = () => Math.floor(Date.now() / 1000) }: {
  fetcher?: typeof fetch; clock?: () => number;
} = {}) {
  return async (request: Request, env: Env): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX + "/")) return null;
    const callback = url.pathname === `${PREFIX}/callback`;
    try {
      if (!env.LINUXDO_CLIENT_ID?.trim() || !env.LINUXDO_CLIENT_SECRET?.trim()) throw new HttpError(503, "LinuxDO 登录尚未配置");
      const origin = new URL(env.APP_ORIGIN).origin;
      if (!loopback(new URL(origin).hostname) && !origin.startsWith("https://")) throw new HttpError(503, "LinuxDO 登录需要 HTTPS");
      // Canonicalize before setting host-only cookies; the alternate domain must
      // start and finish the flow on the registered application domain.
      if (url.origin !== origin && !loopback(url.hostname)) {
        if (callback || request.method !== "GET") throw new HttpError(400, "请在应用主域名重新发起 LinuxDO 登录");
        return redirect(`${origin}${PREFIX}/start`);
      }
      const now = clock(), db = env.DB, redirectUri = `${origin}${PREFIX}/callback`;
      const link = url.pathname === `${PREFIX}/link`;
      if ((url.pathname === `${PREFIX}/start` && request.method === "GET") || (link && request.method === "POST")) {
        const user = await currentUser(request, env, now);
        if (link && !user) throw new HttpError(401, "请先登录再绑定 LinuxDO");
        if (link && user?.linuxdoUsername) throw new HttpError(409, "当前账号已绑定 LinuxDO");
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        await rateLimit(db, `linuxdo:${await signedDigest(ip, env)}`, 30, 600, now);
        const state = token(), browser = token();
        await db.batch([
          db.prepare("DELETE FROM auth_oauth_states WHERE expires_at<=?").bind(now),
          db.prepare("DELETE FROM auth_rate_limits WHERE expires_at<=?").bind(now),
          db.prepare("INSERT INTO auth_oauth_states(state_hash,browser_hash,user_id,session_hash,expires_at) VALUES(?,?,?,?,?)")
            .bind(await digest(state), await digest(browser), link ? user!.id : null, link ? await digest(sessionToken(request)!) : null, now + TTL),
        ]);
        const auth = new URL(`${BASE}/oauth2/authorize`);
        auth.search = new URLSearchParams({ client_id: env.LINUXDO_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "user", state }).toString();
        return link ? json({ url: auth.href }, 200, { "Set-Cookie": stateCookie(browser, env) }) : redirect(auth.href, stateCookie(browser, env));
      }
      if (!callback || request.method !== "GET") throw new HttpError(405, "不支持的 LinuxDO 请求");
      const state = url.searchParams.get("state");
      const browser = request.headers.get("Cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!state || !/^[a-f0-9]{64}$/.test(state) || !browser || !/^[a-f0-9]{64}$/.test(browser)) throw new HttpError(400, "登录状态无效，请重新发起 LinuxDO 登录");
      const flow = await db.prepare("DELETE FROM auth_oauth_states WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING user_id,session_hash")
        .bind(await digest(state), await digest(browser), now).first<{ user_id: string | null; session_hash: string | null }>();
      if (!flow) throw new HttpError(400, "登录已过期或已使用，请重新发起 LinuxDO 登录");
      if (url.searchParams.has("error")) throw new HttpError(400, "你已取消 LinuxDO 授权，可以重新登录");
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) throw new HttpError(400, "LinuxDO 未返回有效授权码");
      const session = sessionToken(request), current = await currentUser(request, env, now);
      if (flow.user_id && (!session || current?.id !== flow.user_id || await digest(session) !== flow.session_hash)) throw new HttpError(401, "绑定期间登录状态已改变，请重新登录后绑定");
      const access = await providerJson(fetcher, `${BASE}/oauth2/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri,
          client_id: env.LINUXDO_CLIENT_ID, client_secret: env.LINUXDO_CLIENT_SECRET }),
      });
      if (typeof access.access_token !== "string" || !access.access_token || access.access_token.length > 16384 || (access.token_type !== undefined && String(access.token_type).toLowerCase() !== "bearer")) throw new HttpError(502, "LinuxDO 未返回有效访问令牌");
      const profile = await providerJson(fetcher, `${BASE}/api/user`, { headers: { Authorization: `Bearer ${access.access_token}`, Accept: "application/json" } });
      const subject = typeof profile.id === "number" && Number.isSafeInteger(profile.id) ? String(profile.id) : profile.id;
      if (typeof subject !== "string" || !/^[1-9]\d{0,19}$/.test(subject) || typeof profile.username !== "string" || !profile.username.trim() || profile.username.length > 100) throw new HttpError(502, "LinuxDO 用户资料无效");
      if (profile.active !== true || profile.silenced !== false) throw new HttpError(403, "此 LinuxDO 账号当前无法登录");
      const existing = await db.prepare("SELECT id FROM users WHERE linuxdo_id=?").bind(subject).first<{ id: string }>();
      if (flow.user_id) {
        if (existing && existing.id !== flow.user_id) throw new HttpError(409, "该 LinuxDO 账号已绑定其他息望账号");
        const updated = await db.prepare("UPDATE users SET linuxdo_id=?,linuxdo_username=? WHERE id=? AND (linuxdo_id IS NULL OR linuxdo_id=?) AND EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND user_id=? AND expires_at>?)")
          .bind(subject, profile.username, flow.user_id, subject, flow.session_hash, flow.user_id, now).run();
        if (!updated.meta.changes) throw new HttpError(409, "账号状态已改变，请重新登录后绑定");
        return redirect(`${origin}/discovery?linuxdo=linked`, stateCookie("", env));
      }
      const userId = existing?.id ?? crypto.randomUUID();
      // The reserved non-email key preserves the original NOT NULL email schema.
      // It cannot pass normalizeEmail and is never returned as an email address.
      await db.batch([
        db.prepare("INSERT INTO users(id,email,created_at,linuxdo_id,linuxdo_username) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(userId, `linuxdo:${subject}`, now, subject, profile.username),
        db.prepare("UPDATE users SET linuxdo_username=? WHERE linuxdo_id=?").bind(profile.username, subject),
        db.prepare("INSERT INTO user_sectors(user_id,name) SELECT id,'未分类' FROM users WHERE linuxdo_id=? ON CONFLICT(user_id,name) DO NOTHING").bind(subject),
      ]);
      const value = token();
      await db.batch([
        db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(now),
        db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE linuxdo_id=?")
          .bind(await digest(value), now + SESSION_SECONDS, now, subject),
        ...(session ? [db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await digest(session))] : []),
      ]);
      const response = redirect(`${origin}/discovery`, stateCookie("", env));
      response.headers.append("Set-Cookie", sessionCookie(value, env));
      return response;
    } catch (error) {
      if (!callback) throw error;
      // Use only controlled messages. Provider payloads, tokens and codes must
      // never appear in URLs, logs or HTML.
      const message = error instanceof HttpError ? error.message : "LinuxDO 登录失败，请稍后重新尝试";
      const signedIn = await currentUser(request, env, clock()).catch(() => null);
      return redirect(`${new URL(env.APP_ORIGIN).origin}/${signedIn ? "discovery" : "login"}?auth_error=${encodeURIComponent(message)}`, stateCookie("", env));
    }
  };
}
