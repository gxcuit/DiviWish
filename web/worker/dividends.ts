import { dateString, timestamp } from "./validation.ts";
import type { DividendEvent, DividendSnapshot, StockRecord } from "./types.ts";

type Row = Record<string, unknown>;
interface Event {
  period: string;
  status: string;
  confirmed: boolean;
  exDate: string | null;
  notice: string | null;
  amount: () => number;
  hkdAmount?: () => number;
}
const round = (value: number) => Math.round(value * 1e8) / 1e8;
const date = (value: unknown) => typeof value === "string" ? dateString(value.slice(0, 10).replaceAll("/", "-")) : null;
function numeric(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function cashA(row: Row): number {
  if (/不分配|不分红/.test(String(row.ASSIGN_PROGRESS ?? ""))) return 0;
  const text = String(row.IMPL_PLAN_PROFILE ?? "");
  const match = text.match(/10派\s*(\d+(?:\.\d+)?)/);
  const value = match ? Number(match[1]) : numeric(row.PRETAX_BONUS_RMB);
  if (value === null || !Number.isFinite(value) || value < 0) throw new Error("分红金额缺失，未将缺失值当作零");
  return value / 10;
}
function cashHk(row: Row, fx: number | null): { cny: number; hkd: number } {
  const text = String(row.PLAN_EXPLAIN ?? "");
  if (/不派息|不分配|不派股息/.test(text)) return { cny: 0, hkd: 0 };
  if (!/^每股/.test(text) || (text.match(/每股/g) ?? []).length > 1) throw new Error("港股分红方案包含非标准或多笔派息，需人工核实");
  const rmb = text.match(/(?:人民币|人民幣|RMB|CNY)\s*(\d+(?:\.\d+)?)\s*元/i);
  if (rmb) return { cny: Number(rmb[1]), hkd: 0 };
  const hkd = text.match(/(?:港币|港幣|港元|HKD)\s*(\d+(?:\.\d+)?)(?:\s*元)?/i);
  if (hkd && fx !== null && Number.isFinite(fx) && fx > 0 && fx < 10) return { cny: round(Number(hkd[1]) * fx), hkd: Number(hkd[1]) };
  throw new Error(hkd ? "港币分红缺少有效汇率，保留原分红" : "分红币种或金额无法确认，保留原分红");
}
function hkPeriod(row: Row): string | null {
  const year = String(row.YEAR ?? ""), type = String(row.REPORT_TYPE ?? "");
  if (!/^\d{4}$/.test(year)) return null;
  if (/^(年度|末期|四季度|第四季度)分配$/.test(type)) return `${year}-12-31`;
  if (/^(中期|二季度|第二季度)分配$/.test(type)) return `${year}-06-30`;
  if (/^(一季度|第一季度)分配$/.test(type)) return `${year}-03-31`;
  if (/^(三季度|第三季度)分配$/.test(type)) return `${year}-09-30`;
  return null;
}

/** Public report records -> RMB annual/rolling cash per share. No payment-year inference. */
export function parseDividends(rows: Row[], stock: Pick<StockRecord, "code" | "market">,
  { today = timestamp().slice(0, 10), fxRate = null, fiscalEnd = "12-31", source = "东方财富公开分红资料" }:
  { today?: string; fxRate?: number | null; fiscalEnd?: string; source?: string } = {}): DividendSnapshot {
  if (!dateString(today)) throw new Error("分红计算日期无效");
  if (stock.market === "HK" && fiscalEnd !== "12-31") throw new Error("此港股的财政年结日不是 12 月 31 日，暂不自动合并分红，请人工核实");
  const events = new Map<string, Event>(), unsupportedYears: number[] = [];
  for (const row of rows) {
    if (String(row.SECURITY_CODE ?? "") !== stock.code) throw new Error("分红接口返回了其他证券的数据");
    const notice = date(row.PLAN_NOTICE_DATE) ?? date(row.NOTICE_DATE);
    if (notice && notice > today) continue;
    const period = stock.market === "A" ? date(row.REPORT_DATE) : hkPeriod(row);
    if (!period) {
      if (stock.market === "HK" && /^\d{4}$/.test(String(row.YEAR ?? ""))) unsupportedYears.push(Number(row.YEAR));
      continue;
    }
    if (period > today) continue;
    const exDate = date(row.EX_DIVIDEND_DATE);
    const progress = String(row.ASSIGN_PROGRESS ?? "");
    if (stock.market === "A" && !/实施分配|特别分配|不分配|不分红|董事会决议通过|股东大会决议通过|股东大会通过/.test(progress)) continue;
    const implemented = stock.market === "A" ? /实施分配|特别分配|不分配|不分红/.test(progress) : Boolean(exDate && exDate <= today);
    const confirmed = /不分配|不分红/.test(progress) || Boolean(implemented && exDate && exDate <= today);
    const status = stock.market === "A" ? progress : exDate && exDate <= today ? "已除净" : "已公告，待除净";
    const next: Event = { period, status, confirmed, exDate, notice,
      amount: () => stock.market === "A" ? cashA(row) : cashHk(row, fxRate).cny,
      ...(stock.market === "HK" ? { hkdAmount: () => cashHk(row, fxRate).hkd } : {}) };
    const previous = events.get(period);
    if (!previous || (confirmed && !previous.confirmed) || (confirmed === previous.confirmed && (notice ?? "") > (previous.notice ?? ""))) events.set(period, next);
    else if (confirmed === previous.confirmed && notice === previous.notice && Math.abs(next.amount() - previous.amount()) > 1e-8) throw new Error("同一报告期存在不同分红记录，需人工核实");
  }
  const periods = [...events.keys()].sort(), annualPeriod = periods.filter(period => period.endsWith("-12-31")).at(-1);
  if (!annualPeriod) throw new Error("尚无已披露的完整年度分红，不能把中期分红当作全年");
  const year = Number(annualPeriod.slice(0, 4));
  if (Number(today.slice(0, 4)) - year > 2) throw new Error("完整年度分红报告期过旧，保留原分红");
  if (unsupportedYears.some(value => value >= year && value <= Number(today.slice(0, 4)))) throw new Error("港股含无法确定报告期的分配记录，需人工核实");
  const annual = [...events.values()].filter(event => event.period.startsWith(`${year}-`)).sort((a, b) => a.period.localeCompare(b.period));
  const latest = periods.at(-1)!;
  const cutoff = `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`;
  const rolling = [...events.values()].filter(event => event.period > cutoff && event.period <= latest);
  const total = (parts: Event[]) => round(parts.reduce((sum, event) => sum + event.amount(), 0));
  return { annual_dividend: total(annual), rolling_dividend: total(rolling), annual_year: year,
    confirmed: annual.every(event => event.confirmed), ex_dividend_date: [...events.values()].map(event => event.exDate).filter((value): value is string => value !== null).sort().at(-1) ?? null,
    dividends: annual.map(event => ({ period: event.period, dps: round(event.amount()), status: event.status, ...(event.exDate ? { date: event.exDate } : {}), ...(event.hkdAmount ? { hkd_dps: event.hkdAmount() } : {}) })),
    dividend_hkd_annual: round(annual.reduce((sum, event) => sum + (event.hkdAmount?.() ?? 0), 0)),
    dividend_hkd_rolling: round(rolling.reduce((sum, event) => sum + (event.hkdAmount?.() ?? 0), 0)),
    dividend_source: source, dividend_updated_at: timestamp(), dividend_fx_rate: stock.market === "HK" ? fxRate : null,
  };
}

// Bound public upstream JSON; a missing/error response never becomes a zero dividend.
async function report(reportName: string, code: string, hk: boolean): Promise<{ rows: Row[]; source: string }> {
  const query = new URLSearchParams({ reportName, columns: "ALL", pageNumber: "1", pageSize: "100", source: hk ? "F10" : "WEB", client: "PC",
    filter: reportName.endsWith("SECURITYINFO") ? `(SECUCODE="${code}.HK")` : `(SECURITY_CODE="${code}")${hk ? '(IS_BFP="0")' : ""}`,
    ...(reportName.endsWith("SECURITYINFO") ? {} : { sortColumns: hk ? "NOTICE_DATE,EX_DIVIDEND_DATE" : "REPORT_DATE", sortTypes: hk ? "-1,-1" : "-1" }) });
  const source = `${hk ? "https://datacenter.eastmoney.com/securities" : "https://datacenter-web.eastmoney.com"}/api/data/v1/get?${query}`;
  const response = await fetch(source, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`分红来源 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("分红来源未返回内容");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512 * 1024) { await reader.cancel(); throw new Error("分红来源响应超过大小限制"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { success?: boolean; result?: { pages?: number; data?: Row[] } };
  if (payload.success !== true || !Array.isArray(payload.result?.data) || !payload.result.data.length) throw new Error("来源未返回可核实的分红资料，保留原值");
  if (payload.result.pages && payload.result.pages > 1) throw new Error("分红记录超过单次读取范围，未使用不完整数据");
  return { rows: payload.result.data, source };
}

export async function fetchDividends(stock: StockRecord, fetchFx: () => Promise<number>): Promise<DividendSnapshot> {
  if (stock.market === "A") {
    const result = await report("RPT_SHAREBONUS_DET", stock.code, false);
    return parseDividends(result.rows, stock, { source: result.source });
  }
  const [result, profile, fxRate] = await Promise.all([
    report("RPT_HKF10_MAIN_DIVBASIC", stock.code, true), report("RPT_HKF10_INFO_SECURITYINFO", stock.code, true), fetchFx().catch(() => null),
  ]);
  const fiscalEnd = String(profile.rows[0]?.YEAR_SETTLE_DAY ?? "");
  return parseDividends(result.rows, stock, { fiscalEnd, fxRate, source: result.source });
}

export function parseHistoricalDividends(rows: Row[], stock: Pick<StockRecord, "code" | "market">, asOf: string): DividendEvent[] {
  const selected = new Map<string, Row>();
  for (const row of rows) {
    if (String(row.SECURITY_CODE ?? "") !== stock.code) throw new Error("历史分红包含其他证券的数据");
    const period = stock.market === "A" ? date(row.REPORT_DATE) : hkPeriod(row);
    if (!period || period > asOf || Number(period.slice(0, 4)) < Number(asOf.slice(0, 4)) - 7) continue;
    if (stock.market === "A" && !/实施分配|特别分配|不分配|不分红|董事会决议通过|股东大会决议通过|股东大会通过/.test(String(row.ASSIGN_PROGRESS ?? ""))) continue;
    const previous = selected.get(period);
    const implemented = (item: Row) => /实施分配|特别分配|不分配|不分红/.test(String(item.ASSIGN_PROGRESS ?? ""));
    if (!previous || (implemented(row) && !implemented(previous)) ||
      (implemented(row) === implemented(previous) && String(row.NOTICE_DATE ?? "") > String(previous.NOTICE_DATE ?? ""))) selected.set(period, row);
  }
  return [...selected].map(([period, row]) => {
    const available = ["PLAN_NOTICE_DATE", "PUBLISH_DATE", "NOTICE_DATE", "EX_DIVIDEND_DATE"]
      .map(key => date(row[key])).find(day => day !== null && day >= period);
    if (!available) throw new Error(`${period} 缺少可核实的历史分红披露日期`);
    let cash: number;
    if (stock.market === "A") {
      const plan = String(row.IMPL_PLAN_PROFILE ?? "");
      cash = row.PRETAX_BONUS_RMB == null && /^10(?:(?:送|转)\d+(?:\.\d+)?)+(?:股)?$/.test(plan) ? 0 : cashA(row);
    } else {
      const plan = String(row.PLAN_EXPLAIN ?? "");
      if (/(?:人民币|人民幣|RMB|CNY|美元|USD)/i.test(plan)) throw new Error("此港股分红需要对应历史汇率，暂不能可靠计算历史分位");
      cash = cashHk(row, 1).hkd; // Native HKD dividend / native HKD unadjusted price.
    }
    return { period, available, cash };
  }).filter(event => event.available <= asOf);
}

export async function fetchHistoricalDividends(stock: StockRecord, asOf: string): Promise<DividendEvent[]> {
  if (stock.market === "HK") {
    const profile = await report("RPT_HKF10_INFO_SECURITYINFO", stock.code, true);
    if (String(profile.rows[0]?.YEAR_SETTLE_DAY ?? "") !== "12-31") throw new Error("此港股财年不是 12 月 31 日，暂不能可靠回溯年度股息");
  }
  const result = await report(stock.market === "A" ? "RPT_SHAREBONUS_DET" : "RPT_HKF10_MAIN_DIVBASIC", stock.code, stock.market === "HK");
  return parseHistoricalDividends(result.rows, stock, asOf);
}
