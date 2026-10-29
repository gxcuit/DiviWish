import { Resend } from "resend";
import { HttpError, loopback } from "./http.ts";
import type { Env } from "./types.ts";

export type OtpMessage = { email: string; code: string; challengeId: string };
export type SendOtp = (message: OtpMessage, env: Env, request: Request) => Promise<string>;

export function localDevelopment(request: Request, env: Env) {
  return loopback(new URL(request.url).hostname) && loopback(new URL(env.APP_ORIGIN).hostname);
}

// The same template payload and idempotency key are reused for every retry.
// Injecting the SDK/fetch in tests avoids sending actual mail.
export async function sendResendOtp(message: OtpMessage, env: Env, client?: Pick<Resend, "emails">,
  sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))): Promise<string> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !env.RESEND_OTP_TEMPLATE_ID) {
    throw new HttpError(503, "邮件服务尚未配置，请配置 Resend 发送密钥、发件人和验证码模板");
  }
  client ??= new Resend(env.RESEND_API_KEY);
  for (let attempt = 0; attempt < 3; attempt++) {
    let retryDelay = 500 * 2 ** attempt;
    try {
      const { data, error, headers } = await client.emails.send({
        from: env.RESEND_FROM, to: [message.email],
        template: { id: env.RESEND_OTP_TEMPLATE_ID, variables: { CODE: message.code, EXPIRES_MINUTES: "10" } },
      }, { idempotencyKey: `diviwish-otp/${message.challengeId}`, signal: AbortSignal.timeout(12_000) });
      if (!error && data?.id) {
        console.info(JSON.stringify({ event: "auth.email.accepted", emailId: data.id }));
        return data.id;
      }
      const status = error?.statusCode;
      if (status && status !== 429 && status < 500) break;
      const retryAfter = headers?.["retry-after"];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        retryDelay = Math.max(retryDelay, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now());
        if (retryDelay > 10_000) break; // Keep all retries within the client's 60s request budget.
      }
    } catch { /* Network failures may be retried with the same idempotency key. */ }
    if (attempt < 2) await sleep(retryDelay);
  }
  throw new HttpError(502, "验证码邮件发送失败，请稍后重试");
}

export const sendOtp: SendOtp = async (message, env, request) => {
  if (env.AUTH_EMAIL_MODE === "console") {
    if (!localDevelopment(request, env)) throw new HttpError(503, "终端验证码模式仅限本机测试");
    console.info(`[DiviWish 本地测试验证码] ${message.email}: ${message.code}（10 分钟内有效）`);
    return `local-${message.challengeId}`;
  }
  if (env.AUTH_EMAIL_MODE !== "resend") throw new HttpError(503, "邮件服务模式配置无效");
  if (env.RESEND_TEST_RECIPIENT && message.email !== env.RESEND_TEST_RECIPIENT.toLowerCase()) {
    throw new HttpError(403, "本地邮件测试仅允许配置的收信邮箱");
  }
  return sendResendOtp(message, env);
};
