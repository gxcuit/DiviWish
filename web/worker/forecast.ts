import { forecastDistribution } from "./forecast-dividends.ts";
import { reconcileForecast } from "./forecast-reconciliation.ts";
import type { StockRecord } from "./types.ts";
import type { ForecastCommitment, ForecastCurrency, ForecastManual, ForecastResult, ForecastSnapshot } from "./forecast-types.ts";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const forecastToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const forecastYear = () => Number(forecastToday().slice(0, 4));
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };

/** Convert only with an explicitly identified currency. Rates are CNY per unit. */
export function forecastConversion(from: ForecastCurrency, to: ForecastCurrency, fx: unknown, usd?: number): number | null {
  if (from === to) return 1;
  const rates = { CNY: 1, HKD: finite(fx) && fx > 0 ? fx : null, USD: finite(usd) && usd > 0 ? usd : null };
  return rates[from] && rates[to] ? rates[from]! / rates[to]! : null;
}

function earnings(snapshot: ForecastSnapshot, today: string) {
  const year = snapshot.year;
  const rows = snapshot.financials.filter(row => row.notice_date && row.notice_date <= today && row.period <= today && row.start === `${row.period.slice(0, 4)}-01-01`)
    .sort((a, b) => b.period.localeCompare(a.period) || b.notice_date.localeCompare(a.notice_date));
  const actual = rows.find(row => row.period === `${year}-12-31`);
  const consensus = snapshot.consensus;
  if (actual) return { basis: "actual" as const, row: actual, eps: actual.eps, profit: actual.profit, period: actual.period, source: actual.source, ordinary: actual.ordinary_profit ?? null, deduction: actual.equity_deduction ?? null, weighted: actual.weighted_shares ?? null, stable: true };
  if (consensus && consensus.year === year && consensus.analysts > 0 && consensus.updated_at <= today &&
    new Date(today).getTime() - new Date(consensus.updated_at).getTime() <= 183 * 86400_000 && finite(consensus.eps)) {
    const latest = rows[0];
    return { basis: "consensus" as const, row: latest, eps: consensus.eps, profit: consensus.profit ?? null, period: `${year}-12-31`, source: consensus.source, ordinary: null, deduction: null, weighted: null, stable: Boolean(latest?.shares && rows.filter(r => r.period >= `${year - 1}-12-31`).every(r => r.shares && Math.abs(r.shares / latest.shares! - 1) < 0.001)) };
  }
  const latest = rows[0];
  if (!latest || Number(latest.period.slice(0, 4)) < year - 1) return null;
  if (latest.period.endsWith("12-31")) return { basis: "ttm" as const, row: latest, eps: latest.eps, profit: latest.profit, period: latest.period, source: latest.source, ordinary: latest.ordinary_profit ?? null, deduction: latest.equity_deduction ?? null, weighted: latest.weighted_shares ?? null, stable: true };
  const y = Number(latest.period.slice(0, 4)), end = latest.period.slice(4);
  const annual = rows.find(row => row.period === `${y - 1}-12-31` && row.currency === latest.currency);
  const previous = rows.find(row => row.period === `${y - 1}${end}` && row.currency === latest.currency);
  if (!annual || !previous) return null;
  const profit = [latest.profit, annual.profit, previous.profit].every(finite) ? latest.profit! + annual.profit! - previous.profit! : null;
  // Adding EPS across different capital bases is invalid. Require stable share counts.
  const sameShares = [latest, annual, previous].every(row => finite(row.shares) && row.shares! > 0 && finite(latest.shares) && Math.abs(row.shares! / latest.shares! - 1) < 0.001);
  const eps = sameShares && [latest.eps, annual.eps, previous.eps].every(finite) ? latest.eps! + annual.eps! - previous.eps! : null;
  const cumulative = (key: "ordinary_profit" | "equity_deduction") => [latest[key], annual[key], previous[key]].every(finite) ? latest[key]! + annual[key]! - previous[key]! : null;
  return { basis: "ttm" as const, row: latest, eps, profit, ordinary: cumulative("ordinary_profit"), deduction: cumulative("equity_deduction"), weighted: null, stable: sameShares, period: latest.period, source: latest.source };
}

export function calculateForecast(stock: StockRecord, fx: unknown, today = forecastToday()): ForecastResult {
  const year = Number(today.slice(0, 4)), currency = stock.market === "HK" ? "HKD" : "CNY";
  const snapshot = stock.forecast_snapshot;
  const manual = stock.forecast_manual?.year === year ? stock.forecast_manual : null;
  const result: ForecastResult = { year, reconciliation: { status: "review", parent_profit: null, ordinary_profit: null, equity_deduction: null, weighted_shares: null, participating_shares: null, share_basis: "待核实", reason: "尚无盈利核对资料" },
    distribution: forecastDistribution([], year, today, () => null, null, false), status: "unavailable", dividend: null, currency, yield: null, basis: null, earnings_basis: null, earnings_currency: null, conversion_rate: null, commitment: null,
    eps: null, profit_per_share: null, payout_ratio: null, payout_years: [], earnings_period: null, formula: "", reason: "请获取当前财年预估数据", notes: [], sources: [],
    updated_at: snapshot?.fetched_at ?? null, stale: Boolean(stock.forecast_error) || Boolean(snapshot?.data_stale) || !snapshot?.fetched_at.startsWith(today),
    search: { status: "not_found", from: `${year - 5}-01-01`, to: today, reviewed: [], notes: [], remaining: 0 } };
  if (stock.instrument_type === "etf") return { ...result, status: "unsupported", reason: "ETF 不适用个股盈利分红模型" };
  const current = snapshot?.year === year ? snapshot : null;
  if (current) {
    const { pending, continuations, ...search } = current.search;
    result.search = { ...search, remaining: pending.length + (continuations?.length ?? 0) };
    result.notes.push(...current.errors, ...search.notes);
  }
  if (stock.forecast_error) result.notes.push(stock.forecast_error);
  if (stock.forecast_manual && !manual) result.notes.push("人工参数不属于当前财年，已停止使用，请更新适用年份。");
  if (current && current.fiscal_end !== "12-31") return { ...result, status: "unsupported", reason: "未核实十二月年结，暂不自动计算此股票的财年预估" };
  const convert = (amount: number, from: ForecastCurrency, record = true) => {
    const conversion = forecastConversion(from, currency, fx, current?.fx.USD);
    if (record && conversion !== null) result.conversion_rate = conversion;
    return conversion === null ? null : amount * conversion;
  };
  result.distribution = forecastDistribution(current?.dividends ?? [], year, today, (amount, c) => convert(amount, c, false),
    manual?.reconciliation?.participating_shares ?? current?.financials[0]?.shares ?? null, Boolean(current && (current.dividends.length || !current.errors.some(e => e.startsWith("历史分红")))));
  const finish = (cash: number | null, basis: ForecastResult["basis"], formula: string, lower = false) => {
    if (cash === null || !finite(cash) || cash < 0) return { ...result, reason: "缺少匹配币种、参与分红股数或有效金额，无法估算" };
    const announced = result.distribution.announced;
    if (announced === null && result.distribution.events.some(d => !d.special && d.status !== "conditional" && d.status !== "cancelled")) return { ...result, reason: "同财年已公布分红金额、状态或股本待核实，暂停全年估算" };
    if (announced !== null && announced > cash + 1e-8) return { ...result, status: "conflict" as const, reason: "已公告普通分红高于全年结果，暂停估算，请核实公告或人工参数",
      distribution: { ...result.distribution, remaining: null, remaining_kind: "unavailable" as const, reason: "全年模型低于已公布金额，剩余预测暂停；已公布分红继续展示" } };
    result.distribution = { ...result.distribution, remaining: announced === null ? null : Math.round((cash - announced) * 1e8) / 1e8,
      remaining_kind: announced === null ? "unavailable" : lower ? "lower_bound" : "estimate" };
    return { ...result, status: lower ? "lower_bound" as const : "ready" as const, dividend: Math.round(cash * 1e8) / 1e8,
      yield: finite(stock.price) && stock.price > 0 ? cash / stock.price : null, basis, formula,
      reason: lower ? "承诺条件成立时的预估下限，并非确定派息" : "当前财年全年口径，包含同财年中期分红" };
  };
  const plans = (current?.dividends ?? []).filter(d => d.period === `${year}-12-31` && d.complete && !d.lower_bound && ["implemented", "approved", "proposed"].includes(d.status ?? ""));
  if (plans.length && !manual?.commitment) {
    const parts = (current?.dividends ?? []).filter(d => d.period.startsWith(`${year}-`) && !d.special && !d.lower_bound && ["implemented", "approved", "proposed"].includes(d.status ?? ""));
    const amounts = parts.map(d => d.ambiguous || d.amount === null ? null : convert(d.amount, d.currency));
    result.sources = parts.map(d => d.evidence);
    return finish(amounts.some(v => v === null) ? null : amounts.reduce<number>((s, v) => s + v!, 0), "plan", "同财年已公布各期每股现金分红合计 ÷ 当前股价");
  }
  const candidates = (current?.commitments ?? []).filter(c => c.approved && c.start_year <= year && c.end_year >= year);
  const signatures = new Set(candidates.map(c => JSON.stringify([c.kind, c.value, c.currency, c.lower_bound, c.profit_basis, c.conditions])));
  const commitment = manual?.commitment ?? (!current?.search.pending.length && !current?.search.continuations?.length && current?.search.status !== "failed" && signatures.size === 1 ? candidates[0] : null);
  if (current?.search.pending.length || current?.search.continuations?.length) result.notes.push("公告仍在分批核实，自动承诺暂不采用；当前展示盈利模型估算。");
  if (signatures.size > 1 && !manual?.commitment) result.notes.push("公告承诺存在冲突，暂用历史支付率模型，请人工核实。");
  if (commitment) {
    result.commitment = commitment;
    result.sources.push(commitment.evidence);
    if (commitment.conditions) result.notes.push(`适用条件：${commitment.conditions}`);
    if (commitment.kind === "per_share") return finish(convert(commitment.value, commitment.currency), manual?.commitment ? "manual" : "commitment", "承诺每股全年现金股息 ÷ 当前股价", commitment.lower_bound);
    if (commitment.kind === "total") return finish(finite(commitment.shares) && commitment.shares > 0 ? convert(commitment.value / commitment.shares, commitment.currency) : null,
      manual?.commitment ? "manual" : "commitment", "承诺全年现金分红总额 ÷ 公告适用参与分红股数 ÷ 当前股价", commitment.lower_bound);
  }
  if (!current) return { ...result, reason: "缺少当前财年盈利资料，请刷新预估数据" };
  const income = earnings(current, today);
  if (!income) return { ...result, reason: "无有效当年盈利预测，且缺少可匹配的利润 TTM 报表" };
  const earningCurrency = income.basis === "consensus" ? current.consensus!.currency : income.row!.currency;
  result.earnings_basis = manual?.reconciliation?.parent_profit != null ? "manual" : income.basis;
  result.earnings_currency = earningCurrency;
  result.earnings_period = result.earnings_basis === "manual" ? `${year}-12-31` : income.period;
  result.eps = income.eps;
  result.reconciliation = reconcileForecast({ row: income.row, eps: income.eps, profit: income.profit, ordinary: income.ordinary, deduction: income.deduction,
    weighted: income.weighted, currency: earningCurrency, stable: income.stable, manual: manual?.reconciliation });
  const reconciled = result.reconciliation;
  result.profit_per_share = reconciled.status !== "review" && finite(reconciled.parent_profit) && reconciled.participating_shares ? reconciled.parent_profit / reconciled.participating_shares : null;
  if (manual?.reconciliation) result.sources.push({ url: manual.reconciliation.source_url, title: "人工利润与股本核对依据", date: today, excerpt: manual.reconciliation.conditions });
  if (income.row?.balance_source) result.sources.push({ url: income.row.balance_source, title: "资产负债表：权益工具与库存股核查（余额不等于利润扣减）", date: income.row.notice_date });
  result.notes.push(reconciled.reason);

  const ordinaryPerShare = finite(reconciled.ordinary_profit) && reconciled.participating_shares ? reconciled.ordinary_profit / reconciled.participating_shares : income.eps;
  result.sources.push({ url: income.source, title: income.basis === "ttm" ? "利润 TTM：上年全年＋本年累计－上年同期累计" : income.basis === "consensus" ? "机构盈利预测" : "年度实际盈利", date: income.basis === "consensus" ? current.consensus!.updated_at : income.row!.notice_date });
  if (income.basis === "ttm" && result.earnings_basis !== "manual") result.notes.push(`按截至 ${income.period} 的 TTM 盈利估算，不代表目标财年实际盈利。`);
  if (reconciled.status === "review") return { ...result, reason: reconciled.reason };
  let ratio = manual?.payout_ratio ?? null;
  let numerator = ordinaryPerShare;
  let usedCommitment = false;
  if (commitment?.kind === "ratio") {
    const matched = commitment.profit_basis === "parent" ? result.profit_per_share : commitment.profit_basis === "ordinary" ? ordinaryPerShare : null;
    if (finite(matched) && matched > 0 && commitment.currency === earningCurrency) {
      numerator = matched;
      ratio = commitment.value;
      usedCommitment = true;
    } else {
      result.notes.push("承诺比例所用利润分母或币种与预测不匹配，暂用历史参考支付率。");
    }
  }
  if (ratio === null) {
    const history: { year: number; ratio: number }[] = [];
    for (let y = year - 1; y >= year - 5 && history.length < 3; y--) {
      const annual = current.financials.find(f => f.period === `${y}-12-31` && f.start === `${y}-01-01` && f.notice_date <= today);
      const dividends = current.dividends.filter(d => d.period.startsWith(`${y}-`));
      if (!annual || !finite(annual.eps) || annual.eps <= 0 || !dividends.some(d => d.complete && ["implemented", "approved"].includes(d.status ?? "")) || dividends.some(d => !d.special && (d.ambiguous || d.amount === null || !["implemented", "approved"].includes(d.status ?? "")))) continue;
      const normal = dividends.filter(d => !d.special);
      if (normal.some(d => d.currency !== annual.currency)) continue;
      const ordinaryProfit = finite(annual.ordinary_profit) ? annual.ordinary_profit : finite(annual.profit) && finite(annual.equity_deduction) ? annual.profit - annual.equity_deduction : null;
      const totalMatched = finite(ordinaryProfit) && ordinaryProfit > 0 && normal.every(d => finite(d.participating_shares) && d.participating_shares > 0);
      const stable = finite(annual.shares) && annual.shares > 0 && normal.every(d => !d.participating_shares || Math.abs(d.participating_shares / annual.shares! - 1) < 0.001)
        && current.financials.filter(f => f.period.startsWith(`${y}-`)).every(f => finite(f.shares) && Math.abs(f.shares! / annual.shares! - 1) < 0.001);
      if (!totalMatched && (!stable || (annual.treasury_balance ?? 0) > 0)) { result.notes.push(`${y} 年加权股本、期末股本或参与分红股数不一致，跳过每股支付率近似。`); continue; }
      const payout = totalMatched ? normal.reduce((s, d) => s + d.amount! * d.participating_shares!, 0) / ordinaryProfit : normal.reduce((s, d) => s + d.amount!, 0) / annual.eps;
      if (payout > 1) { result.notes.push(`${y} 年普通支付率超过100%，作为异常年份跳过。`); continue; }
      history.push({ year: y, ratio: payout });
    }
    if (!history.length) return { ...result, reason: "缺少同财年同币种的有效历史支付率，请补充参考支付率" };
    ratio = median(history.map(h => h.ratio));
    result.payout_years = history.map(h => h.year);
    result.sources.push(...current.dividends.filter(d => history.some(h => d.period.startsWith(`${h.year}-`)) && !d.special).map(d => d.evidence));
    result.notes.push("历史支付率优先采用普通现金分红总额 ÷ 普通股利润；资料不足且股数稳定时采用每股现金股息 ÷ 基本 EPS 近似，基本 EPS 已含权益工具损益调整，不重复扣减。");
  }
  result.payout_ratio = ratio;
  if (!finite(numerator) || numerator <= 0) return { ...result, reason: "匹配口径盈利非正或股本不一致，无法按盈利估算；不据此判断公司不分红" };
  return finish(convert(numerator * ratio, earningCurrency), usedCommitment ? manual?.commitment ? "manual" : "commitment" : manual?.payout_ratio != null || manual?.reconciliation ? "manual" : "historical",
    `${usedCommitment && commitment?.profit_basis === "parent" ? "预计归母净利润 ÷ 匹配股数" : finite(reconciled.ordinary_profit) ? "预计普通股利润 ÷ 参与分红股数" : "预计基本每股收益（股数稳定假设）"} × ${usedCommitment ? "承诺支付率" : manual?.payout_ratio != null ? "人工参考支付率" : "历史普通支付率中位数"} ÷ 当前股价`, Boolean(usedCommitment && commitment?.lower_bound));
}

export function validateForecastManual(value: unknown): ForecastManual | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("预估人工参数格式无效");
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.year) || Number(v.year) < 2000 || Number(v.year) > 2200) throw new Error("请填写有效适用财年");
  const payout = v.payout_ratio ?? null;
  if (payout !== null && (!finite(payout) || payout < 0 || payout > 1)) throw new Error("参考支付率须为0%至100%");
  let commitment: ForecastCommitment | null = null;
  if (v.commitment !== null && v.commitment !== undefined) {
    if (typeof v.commitment !== "object" || Array.isArray(v.commitment)) throw new Error("承诺参数格式无效");
    const c = v.commitment as Record<string, unknown>;
    if (!["per_share", "total", "ratio"].includes(String(c.kind)) || !finite(c.value) || c.value < 0 || c.kind === "ratio" && c.value > 1 || !["CNY", "HKD", "USD"].includes(String(c.currency))) throw new Error("承诺类型、金额、比例或币种无效");
    if (!Number.isInteger(c.start_year) || !Number.isInteger(c.end_year) || Number(c.start_year) < 2000 || Number(c.end_year) > 2200 || Number(c.start_year) > Number(c.end_year)) throw new Error("承诺适用年份无效");
    if (Number(v.year) < Number(c.start_year) || Number(v.year) > Number(c.end_year)) throw new Error("承诺未覆盖所选财年");
    if (typeof c.lower_bound !== "boolean" || typeof c.conditions !== "string" || c.conditions.length > 2000) throw new Error("请填写承诺条件及是否下限");
    if (c.kind === "ratio" && !["parent", "ordinary"].includes(String(c.profit_basis))) throw new Error("请选择承诺比例的利润分母");
    if (c.kind === "total" && (!finite(c.shares) || c.shares <= 0)) throw new Error("总额承诺须填写公告适用的参与分红股数");
    const e = c.evidence as Record<string, unknown> | null;
    if (!e || typeof e.url !== "string" || e.url.length > 2000) throw new Error("请填写公告链接");
    let url: URL;
    try { url = new URL(e.url); } catch { throw new Error("公告链接须为有效的 HTTPS 地址"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("公告链接须为 HTTPS 地址");
    commitment = { kind: c.kind as ForecastCommitment["kind"], value: c.value, currency: c.currency as ForecastCurrency, start_year: Number(c.start_year), end_year: Number(c.end_year),
      lower_bound: c.lower_bound, conditions: c.conditions, approved: true, ...(c.kind === "ratio" ? { profit_basis: c.profit_basis as "parent" | "ordinary" } : {}),
      ...(c.kind === "total" ? { shares: Number(c.shares) } : {}), evidence: { url: url.href, title: "人工补充公告（请自行核实）", date: forecastToday() } };
  }
  let reconciliation: ForecastManual["reconciliation"] = null;
  if (v.reconciliation != null) {
    if (typeof v.reconciliation !== "object" || Array.isArray(v.reconciliation)) throw new Error("利润股本核对参数格式无效");
    const r = v.reconciliation as Record<string, unknown>;
    if (!["CNY", "HKD", "USD"].includes(String(r.currency))) throw new Error("请选择利润核对币种");
    for (const key of ["parent_profit", "equity_deduction", "weighted_shares"] as const) {
      if (r[key] !== null && !finite(r[key])) throw new Error("利润、权益扣减和股数须为有效数值或留空");
    }
    if (finite(r.equity_deduction) && r.equity_deduction < 0 || finite(r.weighted_shares) && r.weighted_shares <= 0 || !finite(r.participating_shares) || r.participating_shares <= 0) throw new Error("权益扣减不可为负，参与股数和加权股数须大于零");
    if (!(finite(r.parent_profit) && finite(r.equity_deduction)) && !finite(r.weighted_shares)) throw new Error("请填写全年归母利润与权益扣减，或预测 EPS 对应加权股数");
    let url: URL;
    try { url = new URL(String(r.source_url)); } catch { throw new Error("利润股本依据须为 HTTPS 链接"); }
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) throw new Error("利润股本依据须为 HTTPS 链接");
    if (typeof r.conditions !== "string" || r.conditions.length > 2000) throw new Error("请填写利润与股本假设（最多2000字）");
    reconciliation = { currency: r.currency as ForecastCurrency, parent_profit: r.parent_profit as number | null, equity_deduction: r.equity_deduction as number | null,
      weighted_shares: r.weighted_shares as number | null, participating_shares: r.participating_shares, source_url: url.href, conditions: r.conditions };
  }
  return { year: Number(v.year), payout_ratio: payout as number | null, commitment, ...(reconciliation ? { reconciliation } : {}) };
}
