import type { D1Database } from "@cloudflare/workers-types";
import { bodyJson, HttpError, json, loopback } from "./http.ts";
import { localDevelopment, sendOtp, type SendOtp } from "./mail.ts";
import type { Env, User } from "./types.ts";
import { hashPassword, validatePassword, verifyPassword } from "./passwords.ts";

const COOKIE = "diviwish_session";
const SESSION_SECONDS = 30 * 24 * 3600;
const CODE_SECONDS = 10 * 60;
const invalidCode = () => new HttpError(400, "验证码无效或已过期，请重新获取");
const encoder = new TextEncoder();

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "请填写有效邮箱");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) {
    throw new HttpError(400, "请填写有效邮箱");
  }
  return email;
}

function secret(env: Env): string {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new HttpError(503, "登录服务尚未配置 AUTH_SECRET");
  return env.AUTH_SECRET;
}

export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function signedDigest(value: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function otp(): string {
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= 4_294_000_000);
  return String(value % 1_000_000).padStart(6, "0");
}

export function sessionToken(request: Request): string | null {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  const value = cookies.map(row => row.trim()).find(row => row.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function sessionCookie(value: string, env: Env, remove = false): string {
  const secure = new URL(env.APP_ORIGIN).protocol === "https:";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${remove ? 0 : SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

function validateConfiguration(request: Request, env: Env) {
  secret(env);
  const origin = new URL(env.APP_ORIGIN);
  if (!loopback(origin.hostname) && origin.protocol !== "https:") throw new HttpError(503, "线上登录必须使用 HTTPS");
  if (!localDevelopment(request, env) && (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || env.AUTH_EMAIL_MODE !== "resend")) {
    throw new HttpError(503, "线上登录需要配置 Turnstile 和 Resend");
  }
  if (Boolean(env.TURNSTILE_SECRET_KEY) !== Boolean(env.TURNSTILE_SITE_KEY)) throw new HttpError(503, "Turnstile 配置不完整");
}

async function verifyTurnstile(request: Request, env: Env, value: unknown, fetcher: typeof fetch, action = "send_otp") {
  if (!env.TURNSTILE_SECRET_KEY) {
    if (localDevelopment(request, env)) return;
    throw new HttpError(503, "人机验证尚未配置");
  }
  if (typeof value !== "string" || !value || value.length > 2048) throw new HttpError(400, "请先完成人机验证");
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: value, remoteip: request.headers.get("CF-Connecting-IP") || undefined }),
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch { throw new HttpError(503, "人机验证服务暂不可用，请重试"); }
  const url = new URL(request.url);
  const origins = new Set([env.APP_ORIGIN, ...(env.APP_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)]
    .map(value => new URL(value).origin));
  const allowedOrigin = localDevelopment(request, env) || (url.protocol === "https:" && origins.has(url.origin));
  if (!result.success || !allowedOrigin || result.hostname !== url.hostname || result.action !== action) {
    throw new HttpError(400, "人机验证未通过，请重新验证");
  }
}

export async function rateLimit(db: D1Database, key: string, limit: number, window: number, now: number) {
  const bucket = Math.floor(now / window);
  const row = await db.prepare("INSERT INTO auth_rate_limits(key,count,expires_at) VALUES(?,1,?) " +
    "ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count")
    .bind(`${key}:${bucket}`, (bucket + 1) * window, limit).first<{ count: number }>();
  if (!row) throw new HttpError(429, "请求过于频繁，请稍后重试");
}

type UserRow = { id: string; email: string; created_at: number; password_hash: string | null; linuxdo_id: string | null; linuxdo_username: string | null };
function publicUser(row: UserRow): User {
  return { id: row.id, email: row.email.startsWith("linuxdo:") ? null : row.email, created_at: row.created_at, hasPassword: Boolean(row.password_hash), linuxdoUsername: row.linuxdo_username };
}

export async function currentUser(request: Request, env: Env, now = Math.floor(Date.now() / 1000)): Promise<User | null> {
  const value = sessionToken(request);
  if (!value) return null;
  const row = await env.DB.prepare("SELECT users.id,users.email,users.created_at,users.password_hash,users.linuxdo_id,users.linuxdo_username FROM auth_sessions " +
    "JOIN users ON users.id=auth_sessions.user_id WHERE token_hash=? AND expires_at>?")
    .bind(await digest(value), now).first<UserRow>();
  return row ? publicUser(row) : null;
}

async function consumeCode(db: D1Database, env: Env, data: Record<string, unknown>, email: string,
  purpose: string, now: number) {
  if (typeof data.challengeId !== "string" || !/^[a-f0-9-]{36}$/.test(data.challengeId) || typeof data.code !== "string" || !/^\d{6}$/.test(data.code)) throw invalidCode();
  const hash = await signedDigest(`${data.challengeId}:${email}:${purpose}:${data.code}`, env);
  const result = await db.prepare("UPDATE auth_challenges SET attempts=attempts+1, " +
    "consumed_at=CASE WHEN code_hash=? THEN ? ELSE consumed_at END " +
    "WHERE id=? AND email=? AND purpose=? AND expires_at>? AND consumed_at IS NULL AND attempts<5 AND delivery_status='sent' " +
    "RETURNING consumed_at").bind(hash, now, data.challengeId, email, purpose, now)
    .first<{ consumed_at: number | null }>();
  if (!result || result.consumed_at === null) throw invalidCode();
}

async function sessionStatements(db: D1Database, userId: string, passwordHash: string, now: number, request: Request) {
  const value = token(), old = sessionToken(request);
  return { value, statements: [
    // Check the hash again after expensive verification: a concurrent password
    // reset must prevent an already-running old-password login creating a session.
    db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) " +
      "SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=?")
      .bind(await digest(value), now + SESSION_SECONDS, now, userId, passwordHash),
    ...(old ? [db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await digest(old))] : []),
  ] };
}

export async function requireUser(request: Request, env: Env): Promise<User> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "请先登录");
  return user;
}

export function createAuth({ deliver = sendOtp, fetcher = fetch, clock = () => Math.floor(Date.now() / 1000) }: {
  deliver?: SendOtp; fetcher?: typeof fetch; clock?: () => number;
} = {}) {
  return async (request: Request, env: Env): Promise<Response | null> => {
    const { pathname } = new URL(request.url), method = request.method;
    if (!pathname.startsWith("/api/auth/")) return null;
    validateConfiguration(request, env);
    const now = clock(), db = env.DB;
    if (pathname === "/api/auth/config" && method === "GET") return json({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      linuxdoEnabled: Boolean(env.LINUXDO_CLIENT_ID?.trim() && env.LINUXDO_CLIENT_SECRET?.trim()),
      emailMode: env.AUTH_EMAIL_MODE === "console" && localDevelopment(request, env) ? "console" : "resend",
    });
    if (pathname === "/api/auth/session" && method === "GET") return json({ user: await currentUser(request, env, now) });
    if (pathname === "/api/auth/logout" && method === "POST") {
      const value = sessionToken(request);
      if (value) await db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await digest(value)).run();
      return json({ message: "已退出登录" }, 200, { "Set-Cookie": sessionCookie("", env, true) });
    }
    const ip = request.headers.get("CF-Connecting-IP") || (localDevelopment(request, env) ? "local" : "unknown");
    const ipKey = await signedDigest(`ip:${ip}`, env);
    if (pathname === "/api/auth/send-code" && method === "POST") {
      const data = await bodyJson(request), email = normalizeEmail(data.email);
      const purpose = data.purpose;
      if (purpose !== "register" && purpose !== "reset_password") throw new HttpError(400, "请选择注册或重置密码的验证码用途");
      await rateLimit(db, `send-ip:${ipKey}`, 20, 3600, now);
      await verifyTurnstile(request, env, data.turnstileToken, fetcher);
      const emailKey = await signedDigest(`email:${email}`, env);
      const cooldown = await db.prepare("INSERT INTO auth_rate_limits(key,count,expires_at) VALUES(?,1,?) " +
        "ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE expires_at<=? RETURNING count")
        .bind(`send-cooldown:${emailKey}`, now + 60, now).first();
      if (!cooldown) throw new HttpError(429, "请等待 60 秒后重新获取验证码");
      await rateLimit(db, `send-hour:${emailKey}`, 5, 3600, now);
      await rateLimit(db, "send-global", 90, 86400, now);
      const id = crypto.randomUUID(), code = otp();
      await db.batch([
        db.prepare("DELETE FROM auth_challenges WHERE expires_at<?").bind(now - 86400),
        db.prepare("DELETE FROM auth_sessions WHERE expires_at<?").bind(now),
        db.prepare("DELETE FROM auth_rate_limits WHERE expires_at<?").bind(now),
        db.prepare("INSERT INTO auth_challenges(id,email,code_hash,expires_at,created_at,purpose) VALUES(?,?,?,?,?,?)")
          .bind(id, email, await signedDigest(`${id}:${email}:${purpose}:${code}`, env), now + CODE_SECONDS, now, purpose),
      ]);
      let emailId: string;
      try { emailId = await deliver({ email, code, challengeId: id }, env, request); }
      catch (error) {
        await db.prepare("UPDATE auth_challenges SET delivery_status='failed' WHERE id=?").bind(id).run();
        throw error instanceof HttpError ? error : new HttpError(502, "验证码邮件发送失败，请稍后重试");
      }
      await db.batch([
        db.prepare("UPDATE auth_challenges SET consumed_at=? WHERE email=? AND id<>? AND consumed_at IS NULL").bind(now, email, id),
        db.prepare("UPDATE auth_challenges SET delivery_status='sent',email_id=? WHERE id=?").bind(emailId, id),
      ]);
      return json({ challengeId: id, expiresIn: CODE_SECONDS, retryAfter: 60, message: env.AUTH_EMAIL_MODE === "console" ? "验证码已输出到本地后端终端" : "验证码已发送，请检查邮箱和垃圾邮件" });
    }
    if (pathname === "/api/auth/login" && method === "POST") {
      const data = await bodyJson(request), email = normalizeEmail(data.email);
      const emailKey = await signedDigest(`email:${email}`, env);
      await rateLimit(db, `login-ip:${ipKey}`, 30, 600, now);
      await rateLimit(db, `login-email:${emailKey}`, 10, 900, now);
      await verifyTurnstile(request, env, data.turnstileToken, fetcher, "password_login");
      if (typeof data.password !== "string" || !data.password) throw new HttpError(401, "邮箱或密码不正确");
      const user = await db.prepare("SELECT id,email,created_at,password_hash,linuxdo_id,linuxdo_username FROM users WHERE email=?").bind(email).first<UserRow>();
      if (!await verifyPassword(data.password, user?.password_hash ?? null) || !user?.password_hash) throw new HttpError(401, "邮箱或密码不正确");
      const session = await sessionStatements(db, user.id, user.password_hash, now, request);
      const results = await db.batch(session.statements);
      if (!results[0].meta.changes) throw new HttpError(401, "密码已变更，请使用新密码登录");
      return json({ user: publicUser(user), message: "登录成功" }, 200, { "Set-Cookie": sessionCookie(session.value, env) });
    }
    if (["/api/auth/register", "/api/auth/reset-password"].includes(pathname) && method === "POST") {
      await rateLimit(db, `verify-ip:${ipKey}`, 60, 600, now);
      const data = await bodyJson(request), email = normalizeEmail(data.email);
      const password = validatePassword(data.password);
      const registering = pathname === "/api/auth/register", purpose = registering ? "register" : "reset_password";
      await consumeCode(db, env, data, email, purpose, now);
      const existing = await db.prepare("SELECT id,email,created_at,password_hash,linuxdo_id,linuxdo_username FROM users WHERE email=?").bind(email).first<UserRow>();
      if (registering && existing) throw new HttpError(409, "该邮箱已注册，请登录或通过邮箱验证码设置密码");
      if (!registering && !existing) throw new HttpError(400, "该邮箱尚未注册，请先注册账号");
      const passwordHash = await hashPassword(password), userId = registering ? crypto.randomUUID() : existing!.id;
      const session = await sessionStatements(db, userId, passwordHash, now, request);
      const changes = registering ? [
        db.prepare("INSERT INTO users(id,email,created_at,password_hash) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING").bind(userId, email, now, passwordHash),
        db.prepare("INSERT INTO user_sectors(user_id,name) SELECT id,'未分类' FROM users WHERE id=? ON CONFLICT(user_id,name) DO NOTHING").bind(userId),
      ] : [
        db.prepare("UPDATE users SET password_hash=? WHERE id=? AND password_hash IS ?").bind(passwordHash, userId, existing!.password_hash),
        db.prepare("DELETE FROM auth_sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)").bind(userId, userId, passwordHash),
      ];
      const results = await db.batch([...changes, ...session.statements]);
      if (!results[0].meta.changes) throw new HttpError(409, registering ? "该邮箱已注册，请直接登录" : "密码已变更，请重新获取验证码");
      const user = await db.prepare("SELECT id,email,created_at,password_hash,linuxdo_id,linuxdo_username FROM users WHERE id=?").bind(userId).first<UserRow>();
      return json({ user: publicUser(user!), message: registering ? "注册成功，欢迎来到息望" : "密码已设置，请妥善保管" }, registering ? 201 : 200,
        { "Set-Cookie": sessionCookie(session.value, env) });
    }
    throw new HttpError(404, "账号接口不存在");
  };
}
