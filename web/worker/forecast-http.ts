/** Bound upstream bodies, including decompressed content, before parsing them. */
export async function forecastBytes(url: string, init: RequestInit = {}, limit = 2 * 1024 * 1024, timeout = 10_000): Promise<Uint8Array> {
  const response = await fetch(url, { ...init, headers: { "User-Agent": "Mozilla/5.0", ...init.headers }, signal: AbortSignal.timeout(timeout), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`公开数据来源 HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("公开数据来源内容为空");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > limit) { await reader.cancel(); throw new Error("公开数据超过单次大小限制，请人工核实"); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function forecastText(url: string, init: RequestInit = {}, limit?: number): Promise<string> {
  return new TextDecoder().decode(await forecastBytes(url, init, limit));
}
export async function forecastReport(name: string, filter: string, columns = "ALL", sort = "REPORT_DATE", size = 60) {
  const query = new URLSearchParams({ reportName: name, filter, columns, pageSize: String(size), pageNumber: "1", ...(sort ? { sortColumns: sort, sortTypes: "-1" } : {}) });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${query}`;
  const data = JSON.parse(await forecastText(url));
  if (!data.success || !Array.isArray(data.result?.data)) throw new Error(`公开财务报表 ${name} 无有效数据`);
  return { rows: data.result.data as Record<string, unknown>[], url };
}
export function forecastNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string" || String(value).trim() === "") return null;
  const n = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(n) ? n : null;
}
