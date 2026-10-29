import { dateString, timestamp } from "./validation.ts";
import type { Bar, DividendEvent, HistorySnapshot } from "./types.ts";

export function yearsBefore(day: string, years: number): string {
  const [year, month, date] = day.split("-").map(Number), target = year - years;
  return `${target}-${String(month).padStart(2, "0")}-${String(Math.min(date, new Date(Date.UTC(target, month, 0)).getUTCDate())).padStart(2, "0")}`;
}

export function historyEnd(): string {
  // Only completed sessions: today's intraday bar must never enter the distribution.
  return new Date(Date.parse(timestamp().slice(0, 10) + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
}

export function buildHistory(events: DividendEvent[], prices: Bar[], asOf: string): HistorySnapshot {
  if (!dateString(asOf)) throw new Error("历史估值日期无效");
  const start = yearsBefore(asOf, 5), closes = new Map<string, number>();
  for (const row of prices) {
    if (!dateString(row.date) || !Number.isFinite(row.close) || row.close <= 0) throw new Error("历史收盘价或日期无效");
    if (row.date < start || row.date > asOf) continue;
    if (closes.has(row.date) && closes.get(row.date) !== row.close) throw new Error("同一交易日存在不同历史收盘价");
    closes.set(row.date, row.close);
  }
  const ordered = [...events].sort((a, b) => a.available.localeCompare(b.available) || a.period.localeCompare(b.period));
  if (ordered.some(event => !dateString(event.period) || !dateString(event.available) || event.available < event.period || !Number.isFinite(event.cash) || event.cash < 0)) throw new Error("历史分红记录无效");
  const active = new Map<string, DividendEvent>(), history: HistorySnapshot["history"] = [];
  let cursor = 0;
  for (const [day, close] of [...closes].sort(([a], [b]) => a.localeCompare(b))) {
    while (cursor < ordered.length && ordered[cursor].available < day) {
      active.set(ordered[cursor].period, ordered[cursor]); cursor++;
    }
    const latest = [...active.keys()].filter(period => period.endsWith("-12-31")).sort().at(-1);
    if (!latest) continue;
    const year = Number(latest.slice(0, 4));
    if (Number(day.slice(0, 4)) - year > 2) continue;
    const annual = Math.round([...active.values()].filter(event => event.period.startsWith(`${year}-`)).reduce((sum, event) => sum + event.cash, 0) * 1e8) / 1e8;
    history.push({ date: day, close, annual, year, yield: annual / close });
  }
  if (history.length < 60) throw new Error(`有效历史样本仅 ${history.length} 个交易日，至少需要 60 个`);
  const end = history.at(-1)!.date;
  if (Date.parse(asOf) - Date.parse(end) > 21 * 86400_000) throw new Error(`历史行情仅截至 ${end}，未使用过旧数据`);
  return { history, percentile_start: history[0].date, percentile_end: end, history_updated_at: timestamp(),
    history_source: "腾讯不复权日线；东方财富公开分红披露记录",
    history_note: "按当时已披露完整年度股息 ÷ 不复权收盘价；公告后下一交易日生效，仅纳入今日之前的完成交易日。按现存分红记录回溯，非逐日方案版本快照；送转配股可能影响名义每股口径。" };
}
