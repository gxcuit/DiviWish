import type { ForecastCurrency, ForecastFinancial, ForecastReconciliation, ForecastReconciliationInput } from "./forecast-types.ts";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function reconcileForecast(input: {
  row?: ForecastFinancial; eps: number | null; profit: number | null; ordinary: number | null;
  deduction: number | null; weighted: number | null; currency: ForecastCurrency;
  manual?: ForecastReconciliationInput | null; stable: boolean;
}): ForecastReconciliation {
  const { row, eps, profit, manual } = input;
  const result: ForecastReconciliation = { status: "review", parent_profit: profit, ordinary_profit: input.ordinary,
    equity_deduction: input.deduction, weighted_shares: input.weighted, participating_shares: row?.shares ?? null,
    share_basis: "期末普通股数，尚未核实参与分红口径", reason: "缺少普通股利润、权益工具扣减或匹配股本依据" };
  if (manual) {
    if (manual.currency !== input.currency) return { ...result, reason: "人工利润与盈利来源币种不匹配" };
    result.parent_profit = manual.parent_profit ?? profit;
    result.equity_deduction = manual.equity_deduction;
    result.weighted_shares = manual.weighted_shares;
    result.participating_shares = manual.participating_shares;
    result.share_basis = "人工核实的参与分红股数";
    // EPS already belongs to ordinary shareholders. Never subtract equity coupons twice.
    if (finite(manual.parent_profit) && finite(manual.equity_deduction)) result.ordinary_profit = manual.parent_profit - manual.equity_deduction;
    else if (finite(eps) && finite(manual.weighted_shares)) result.ordinary_profit = eps * manual.weighted_shares;
    else return { ...result, ordinary_profit: null, reason: "须提供全年归母利润与全年权益扣减，或预测基本 EPS 对应的加权平均普通股数" };
    return { ...result, status: "matched", reason: "采用人工财年假设及来源；普通股利润与参与股数分别计算，条件需自行核实" };
  }
  if (row?.currency !== input.currency) return { ...result, reason: "盈利和股本来源币种未匹配" };
  if (!finite(result.ordinary_profit) && finite(profit) && finite(input.deduction)) result.ordinary_profit = profit - input.deduction;
  // An explicitly disclosed weighted denominator can translate basic EPS into ordinary profit.
  if (!finite(result.ordinary_profit) && finite(eps) && finite(input.weighted) && input.weighted > 0) result.ordinary_profit = eps * input.weighted;
  if (row?.equity_status === "present" && !finite(result.ordinary_profit)) return { ...result,
    reason: "报表存在其他权益工具，尚缺全年普通股利润／权益工具损益扣减及对应股数；账面余额不能作为利润扣减" };
  if (row?.treasury_balance && row.treasury_balance > 0) return { ...result, reason: "存在库存股，期末总股数不能直接作为参与分红股数，请补充适用股数" };
  if (!finite(row?.shares) || row.shares <= 0 || !input.stable) return { ...result, reason: "股本发生变化或缺少匹配股数；不能使用 EPS × 期末股本还原普通股利润" };
  if (finite(result.ordinary_profit)) return { ...result, status: "approximation", share_basis: "暂按期末普通股数估计参与股数",
    reason: "普通股利润已核对，参与股数暂按期末股数假设；未来变动可能影响每股金额" };
  if (row?.equity_status !== "none_reported") return { ...result, reason: "权益工具口径未核实，请刷新或补充普通股利润与股本" };
  // No reconstructed parent/ordinary total: this is explicitly a per-share approximation.
  return { ...result, status: "approximation", share_basis: "基本 EPS 近似口径；稳定期末股数假设",
    reason: "报表未列非零其他权益工具及库存股，采用基本 EPS 近似；未将 EPS × 期末股数视为真实利润" };
}
