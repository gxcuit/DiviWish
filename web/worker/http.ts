export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});

export function protectWrites(request: Request, configuredOrigin?: string) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return;
  const url = new URL(request.url), origin = request.headers.get("Origin");
  const configured = new URL(configuredOrigin || url.origin);
  const allowed = new Set([url.origin, configured.origin]);
  for (const candidate of [url, configured]) {
    if (!loopback(candidate.hostname)) continue;
    const port = candidate.port ? `:${candidate.port}` : "";
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) allowed.add(`${candidate.protocol}//${host}${port}`);
  }
  if (origin && !allowed.has(origin)) throw new HttpError(403, "仅允许同源页面提交请求");
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") throw new HttpError(403, "不接受跨站写入请求");
  if (request.method !== "DELETE" && request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "请使用 application/json 请求");
  }
}

export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const limit = 128 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) throw new HttpError(413, "请求内容不能超过 128 KiB");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, "请求内容不能超过 128 KiB"); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "JSON 格式无效"); }
}

export function validated<T>(action: () => T): T {
  try { return action(); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "资料格式无效"); }
}
