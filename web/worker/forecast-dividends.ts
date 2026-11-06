import type { ForecastDistribution, ForecastDividend, ForecastDividendStatus } from "./forecast-types.ts";

/** These are fiscal-year distributions, never a buyer's next-12-month cash flow. */
export function forecastDistribution(events: ForecastDividend[], year: number, today: string,
  convert: (amount: number, currency: ForecastDividend["currency"]) => number | null,
  shares: number | null, available: boolean): ForecastDistribution {
  const current = events.filter(d => d.period.startsWith(`${year}-`) && d.evidence.date <= today);
  const amount = (d: ForecastDividend) => {
    if (d.ambiguous || d.amount === null || !Number.isFinite(d.amount)) return null;
    if (shares && d.participating_shares && Math.abs(d.participating_shares / shares - 1) > 0.001) return null;
    return convert(d.amount, d.currency);
  };
  const sum = (selected: ForecastDividend[]) => {
    if (!available) return null;
    const amounts = selected.map(amount);
    return amounts.some(v => v === null) ? null : amounts.reduce<number>((s, v) => s + v!, 0);
  };
  const ordinary = current.filter(d => !d.special && d.status !== "cancelled");
  const bucket = (status: ForecastDividendStatus) => sum(ordinary.filter(d => d.status === status));
  // Proposed distributions are announced, but conditional guidance is not an approved amount.
  const announcedEvents = ordinary.filter(d => ["implemented", "approved", "proposed"].includes(d.status ?? "unknown") && !d.lower_bound);
  const unverified = ordinary.some(d => !d.status || d.status === "unknown");
  return { events: current, implemented: bucket("implemented"), approved: bucket("approved"), proposed: bucket("proposed"),
    conditional: ordinary.filter(d => d.status === "conditional").length > 1 ? null : bucket("conditional"), special: sum(current.filter(d => d.special && ["implemented", "approved", "proposed"].includes(d.status ?? ""))),
    announced: unverified ? null : sum(announcedEvents), remaining: null, remaining_kind: "unavailable",
    reason: !available ? "尚无可核实分红记录" : unverified ? "旧记录未核实分红状态，请刷新" :
      current.some(d => amount(d) === null) ? "部分金额、币种或参与分红股数待核实，不估填合计" : "已公布普通分红包括已实施、已批准和预案；条件性指引、特别股息另列。" };
}
