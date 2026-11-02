import { dateString, timestamp } from "./validation.ts";
import { yearsBefore } from "./history.ts";
import type { DividendSnapshot, StockRecord } from "./types.ts";

export interface EtfDividend {
  period: string;
  date: string;
  record_date: string;
  pay_date: string;
  dps: number;
  status: string;
}
interface Split { date: string; ratio: number }
export interface EtfPage { dividends: EtfDividend[]; splits: Split[]; split_warning: boolean }
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
const rounded = (value: number) => Math.round(value * 1e10) / 1e10;

export function parseEtfPage(html: string, code: string): EtfPage {
  const title = text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (!title.includes(`(${code})`) || !title.includes("基金分红送配") || !/ETF/i.test(title)) throw new Error("天天基金证券身份不匹配，须为境内 ETF");
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(table =>
    [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
      [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => text(cell[1]))));
  const dividends = tables.find(rows => rows[0]?.includes("每10份分红") || rows[0]?.includes("每份分红"));
  if (!dividends || dividends[0][1] !== "权益登记日" || dividends[0][2] !== "除息日") throw new Error("天天基金分红表格式无法核实");
  const events: EtfDividend[] = [], seen = new Set<string>();
  for (const row of dividends.slice(1)) {
    if (row.length === 1 && row[0] === "暂无分红信息!") continue;
    const match = row[3]?.match(/^每(\d+)份派现金([0-9.]+)元$/);
    const dates = [row[1], row[2], row[4]].map(dateString);
    const cash = match ? Number(match[2]) / Number(match[1]) : NaN;
    if (!dates.every(Boolean) || !Number.isFinite(cash) || cash <= 0 || dates[0]! > dates[1]! || dates[2]! < dates[1]!) throw new Error("ETF 分红日期或金额无法核实");
    if (seen.has(dates[1]!)) throw new Error("ETF 分红除息日重复");
    seen.add(dates[1]!);
    events.push({ period: dates[1]!, date: dates[1]!, record_date: dates[0]!, pay_date: dates[2]!, dps: rounded(cash), status: "" });
  }
  if (!events.length && !dividends.some(row => row[0] === "暂无分红信息!")) throw new Error("ETF 分红表为空，不能确认为无分红");
  const splitTable = tables.find(rows => rows[0]?.includes("拆分折算比例"));
  const splits: Split[] = []; let warning = !splitTable;
  for (const row of splitTable?.slice(1) ?? []) {
    if (row.length === 1 && row[0] === "暂无拆分信息!") continue;
    const day = dateString(row[1]), match = row[3]?.match(/^([0-9.]+):([0-9.]+)$/);
    const ratio = match ? Number(match[2]) / Number(match[1]) : NaN;
    if (!day || !Number.isFinite(ratio) || ratio <= 0 || splits.some(split => split.date === day)) warning = true;
    else splits.push({ date: day, ratio });
  }
  return { dividends: events.sort((a, b) => a.date.localeCompare(b.date)), splits, split_warning: warning };
}

export function parseSinaDividends(body: string, symbol: string): Map<string, number> {
  const match = body.match(/^\s*var\s+([a-z]+\d+)hfq\s*=\s*(\{[^\n]*\})\s*;?\s*(?:\n|\/\*|$)/);
  if (!match || match[1] !== symbol) throw new Error("新浪 ETF 证券身份或格式无效");
  const payload = JSON.parse(match[2]);
  if (!Array.isArray(payload.data) || payload.data.length !== payload.total || !payload.data.length) throw new Error("新浪 ETF 记录不完整");
  const rows = payload.data.map((row: Record<string, unknown>) => ({ date: dateString(row.d), cash: Number(row.u), split: Number(row.s), factor: Number(row.f) }));
  rows.sort((a: { date: string | null }, b: { date: string | null }) => (a.date ?? "").localeCompare(b.date ?? ""));
  const result = new Map<string, number>(); let previous = 0; const seen = new Set<string>();
  for (const row of rows) {
    if (!row.date || !Number.isFinite(row.cash) || row.cash < 0 || !Number.isFinite(row.split) || row.split <= 0 || row.factor !== 1 || seen.has(row.date)) throw new Error("新浪 ETF 累计记录无法核实");
    seen.add(row.date);
    if (row.date === "1900-01-01") { if (row.cash !== 0) throw new Error("新浪占位值异常"); continue; }
    const delta = rounded(row.cash - previous); previous = row.cash;
    if (delta < 0) throw new Error("新浪累计分红发生回退，不能直接差分");
    if (delta > 0) result.set(row.date, delta);
  }
  return result;
}

export function etfSnapshot(page: EtfPage, sina: Map<string, number> | null, asOf = timestamp().slice(0, 10)): DividendSnapshot {
  if (!dateString(asOf)) throw new Error("ETF 统计日期无效");
  const year = Number(asOf.slice(0, 4)) - 1, cutoff = yearsBefore(asOf, 1);
  const past = page.dividends.filter(row => row.date <= asOf), future = page.dividends.filter(row => row.date > asOf);
  const total = (rows: EtfDividend[]) => {
    if (rows.length && page.split_warning) return null;
    let sum = 0;
    for (const row of rows) {
      if (page.splits.some(split => split.date === row.date)) return null;
      const factor = page.splits.filter(split => split.date > row.date && split.date <= asOf).reduce((value, split) => value * split.ratio, 1);
      sum += row.dps / factor;
    }
    return Number.isFinite(sum) ? rounded(sum) : null;
  };
  const annual = total(past.filter(row => row.date.startsWith(`${year}-`))), rolling = total(past.filter(row => row.date > cutoff));
  const primary = new Map(past.map(row => [row.date, row.dps]));
  const mismatch = sina !== null && [...new Set([...primary.keys(), ...sina.keys()])].some(day => day <= asOf &&
    (!primary.has(day) || !sina.has(day) || Math.abs(primary.get(day)! - sina.get(day)!) > 1e-8));
  const verification = sina === null ? "unavailable" : mismatch ? "mismatch" : "matched";
  const notes = [sina === null ? "新浪交叉核验暂不可用，采用天天基金明细。" : mismatch ? "两源已除息记录存在差异，采用天天基金明细，请核实。" : "天天基金与新浪已除息记录一致。",
    annual === null || rolling === null ? "份额拆分口径无法可靠核实，受影响的派息率暂不计算。" : "",
    !past.length ? "查询成功，暂无已除息现金分红记录。" : ""].filter(Boolean).join(" ");
  return { annual_dividend: annual, rolling_dividend: rolling, annual_year: year, confirmed: past.length > 0,
    ex_dividend_date: past.at(-1)?.date ?? null, next_ex_dividend_date: future[0]?.date ?? null,
    dividends: [...page.dividends].reverse().map(row => ({ ...row, status: row.date > asOf ? "待除息" : row.pay_date > asOf ? "已除息，待发放" : "已发放" })),
    dividend_calendar_dates: page.dividends.map(row => row.date), dividend_verification: verification,
    dividend_note: notes, dividend_as_of: asOf, dividend_annual_start: `${year}-01-01`, dividend_annual_end: `${year}-12-31`, dividend_rolling_start: cutoff,
    dividend_source: "天天基金 ETF 分红明细；新浪 ETF 累计分红交叉核验", dividend_updated_at: timestamp(), dividend_fx_rate: null };
}

async function load(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(url).origin + "/" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`ETF 分红服务 HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ETF 分红服务返回空响应");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error("ETF 分红响应超过大小限制"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function fetchEtfDividends(stock: StockRecord): Promise<DividendSnapshot> {
  if (stock.market !== "A" || !["sh", "sz"].includes(stock.exchange ?? "") || !/^\d{6}$/.test(stock.code)) throw new Error("ETF 市场或交易所无效");
  const symbol = `${stock.exchange}${stock.code}`;
  const [main, check] = await Promise.allSettled([
    load(`https://fundf10.eastmoney.com/fhsp_${stock.code}.html`).then(body => parseEtfPage(body, stock.code)),
    load(`https://finance.sina.com.cn/realstock/company/${symbol}/hfq.js`).then(body => parseSinaDividends(body, symbol)),
  ]);
  if (main.status !== "fulfilled") throw main.reason;
  return etfSnapshot(main.value, check.status === "fulfilled" ? check.value : null);
}
