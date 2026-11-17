export class SourceHttpError extends Error {
  status: number;
  constructor(status: number) { super(`数据源 HTTP ${status}`); this.status = status; }
}

export type SourceFailure = { kind: "http" | "timeout" | "network" | "data"; message: string; status?: number; code?: string };
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

// Return only fixed classifications and allowlisted codes. Never expose raw errors, URLs or response bodies.
export function describeSourceFailure(error: unknown): SourceFailure {
  if (error instanceof SourceHttpError) return { kind: "http", status: error.status, message: `数据源 HTTP ${error.status}` };
  const value = error instanceof Error ? error : null;
  const cause = value?.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) :
    value && "code" in value ? String(value.code) : "";
  if (value?.name === "TimeoutError" || value?.name === "AbortError" || TIMEOUT_CODES.has(code)) {
    return { kind: "timeout", message: "数据源请求超时", ...(TIMEOUT_CODES.has(code) ? { code } : {}) };
  }
  if (NETWORK_CODES.has(code)) return { kind: "network", code, message: `数据源网络连接失败（${code}）` };
  if (value?.message === "fetch failed" || value?.message === "Network connection lost.") return { kind: "network", message: "数据源网络连接失败" };
  return { kind: "data", message: "数据源返回内容或数据校验异常" };
}
