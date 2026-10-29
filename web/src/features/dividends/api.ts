export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<Result>(path: string, options?: RequestInit): Promise<Result> {
  const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store", signal });
  const result = await response.json().catch(() => ({ error: "服务暂时不可用，请确认本地后端已启动。" }));
  if (!response.ok) {
    throw new ApiError([result.error || result.message || "请求失败，请稍后重试。", ...(Array.isArray(result.errors) ? result.errors : [])].join("；"), response.status);
  }
  return result as Result;
}
