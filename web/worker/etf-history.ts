import { etfSnapshot, type EtfDividend, type EtfPage, type EtfSplit } from "./etf.ts";
import { yearsBefore } from "./history.ts";
import { dateString, timestamp } from "./validation.ts";
import type { Bar, HistorySnapshot, RollingWindowStatus } from "./types.ts";

// Eastmoney can date a conversion on Friday while the exchange's new units
// start trading on Monday. Only a corroborated Sina factor supplies that day.
export function tradingSplits(page: EtfPage, sina: EtfSplit[] | null, firstCash: string, end: string): EtfSplit[] {
  if (page.split_warning) throw new Error("份额拆分资料不完整，无法可靠回溯");
  const relevant = page.splits.filter(row => row.date >= firstCash && row.date <= end && Math.abs(row.ratio - 1) > 1e-8);
  if (relevant.length && !sina) throw new Error("拆分交易生效日未完成新浪核验，无法可靠回溯");
  const used = new Set<string>();
  const result = relevant.map(row => {
    const matches = sina!.filter(check => !used.has(check.date) && check.date >= row.date &&
      Date.parse(check.date) - Date.parse(row.date) <= 14 * 86400_000 && Math.abs(check.ratio / row.ratio - 1) < 1e-6);
    if (matches.length !== 1) throw new Error(`拆分 ${row.date} 的交易生效日或比例无法核实`);
    used.add(matches[0].date);
    return matches[0];
  });
  if (sina?.some(row => row.date >= firstCash && row.date <= end && !used.has(row.date))) throw new Error("两源拆分记录不一致，无法可靠回溯");
  return result;
}

// These are explanatory flags, never a correction to cash amounts. Requiring
// exactly two distant payments avoids classifying monthly/quarterly payouts as
// an annual overlap. The gap flag expires after 45 days; prolonged zero cash
// remains explicitly "no_cash" rather than being assumed a scheduling delay.
export function rollingWindowStatus(past: EtfDividend[], day: string): RollingWindowStatus | undefined {
  const active = past.filter(row => row.date <= day), cutoff = yearsBefore(day, 1);
  const window = active.filter(row => row.date > cutoff);
  const days = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 86400_000;
  if (window.length === 2 && days(window[1].date, window[0].date) >= 270) return "overlap";
  if (window.length) return undefined;
  if (!active.length) return "before_first";
  const latest = active.at(-1)!, previous = active.at(-2);
  if (previous) {
    const interval = days(latest.date, previous.date);
    if (interval >= 270 && interval <= 460 && days(cutoff, latest.date) <= 45) return "gap";
  }
  return "no_cash";
}

export function buildEtfHistory(page: EtfPage, sina: { dividends: Map<string, number>; splits: EtfSplit[] } | null, prices: Bar[], asOf: string): HistorySnapshot {
  if (!dateString(asOf)) throw new Error("历史统计日期无效");
  const start = yearsBefore(asOf, 5), closes = new Map<string, number>();
  for (const row of prices) {
    if (!dateString(row.date) || !Number.isFinite(row.close) || row.close <= 0) throw new Error("历史收盘价或日期无效");
    if (row.date < start || row.date > asOf) continue;
    if (closes.has(row.date) && closes.get(row.date) !== row.close) throw new Error("同一交易日存在不同历史收盘价");
    closes.set(row.date, row.close);
  }
  const past = page.dividends.filter(row => row.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const verification = etfSnapshot(page, sina?.dividends ?? null, asOf).dividend_note;
  const meta = { history_version: 4, history_updated_at: timestamp(),
    history_source: "腾讯不复权日线；天天基金 ETF 分红明细；新浪拆分与分红交叉核验",
    history_note: `年度按各历史日上一完整自然年已除息分红，滚动按此前12个月（左开右闭）已除息分红，均折算至当日份额后除以当日不复权收盘价；仅纳入今日之前完成的交易日。窗口标注不改变原始分红或剔除样本。${verification}` };
  const empty = (reason: string): HistorySnapshot => ({ ...meta, history_status: "not_applicable", history: [], percentile_start: "", percentile_end: "", history_note: reason + " " + meta.history_note });
  if (!past.length) return empty("查询成功，暂无已除息现金分红，派息率分位不适用。");
  const relevantCash = past.filter(row => row.date >= `${Number(start.slice(0, 4)) - 1}-01-01`);
  const splits = relevantCash.length ? tradingSplits(page, sina?.splits ?? null, relevantCash[0].date, asOf) : [];
  if (splits.some(split => past.some(row => row.date === split.date))) throw new Error("拆分与除息同日，分红份额口径无法可靠核实");
  const history: HistorySnapshot["history"] = [];
  for (const [day, close] of [...closes].sort(([a], [b]) => a.localeCompare(b))) {
    const cutoff = yearsBefore(day, 1);
    const sum = (events: EtfDividend[]) => events.reduce((total, row) => {
      const factor = splits.filter(split => split.date > row.date && split.date <= day).reduce((value, split) => value * split.ratio, 1);
      return total + row.dps / factor;
    }, 0);
    const cash = sum(past.filter(row => row.date > cutoff && row.date <= day));
    const year = Number(day.slice(0, 4)) - 1;
    const annual = sum(past.filter(row => row.date.startsWith(`${year}-`)));
    if (![cash, annual].every(value => Number.isFinite(value) && value >= 0)) throw new Error("拆分折算结果无效");
    history.push({ date: day, close, annual, year, yield: annual / close, rolling_yield: cash / close, window_status: rollingWindowStatus(past, day) });
  }
  if (history.length < 60) throw new Error(`有效历史样本仅 ${history.length} 个交易日，至少需要 60 个`);
  const end = history.at(-1)!.date;
  if (Date.parse(asOf) - Date.parse(end) > 21 * 86400_000) throw new Error(`历史行情仅截至 ${end}，未使用过旧数据`);
  if (!history.some(row => row.yield > 0 || row.rolling_yield! > 0)) return empty("近五年有效交易日的年度和滚动派息率均为零，派息率分位不适用。");
  return { ...meta, history_status: "ready", history, percentile_start: history[0].date, percentile_end: end };
}
