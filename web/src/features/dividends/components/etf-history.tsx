import type { StockDetail } from "../types";
import styles from "./dashboard.module.css";

const rate = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const price = (value: number | null) => value === null ? "—" : `¥${value.toFixed(4)}`;

export function EtfHistory({ stock, state, onRetry }: { stock: StockDetail; state?: { loading: boolean; error: string }; onRetry: () => void }) {
  const basis = stock.yield_basis || "annual";
  const label = basis === "annual" ? "上一自然年派息率" : basis === "rolling" ? "滚动12个月派息率" : "自定义估算派息率";
  return <section aria-label="ETF 派息率历史分位">
    <h3>{label}历史分位 <strong className={styles.red}>{rate(stock.percentile)}</strong></h3>
    {state?.loading && <p className={styles.muted} role="status">正在获取历史行情与分红，计算年度及滚动派息率分位…</p>}
    {state?.error && <p className={styles.formError} role="alert">{state.error}</p>}
    <button className={styles.historyRetry} disabled={state?.loading} onClick={onRetry}>{state?.loading ? "计算中…" : "重新获取历史数据"}</button>
    {stock.percentile_unavailable_reason && <p className={styles.muted}>{stock.percentile_unavailable_reason}</p>}
    <div className={styles.detailMetrics}>
      <div><span>30 分位{label} / 对应价格</span><strong>{rate(stock.quantile_30_yield)} / {price(stock.quantile_30_price)}</strong></div>
      <div><span>60 分位{label} / 对应价格</span><strong>{rate(stock.quantile_60_yield)} / {price(stock.quantile_60_price)}</strong></div>
      <div><span>90 分位{label} / 对应价格</span><strong>{rate(stock.quantile_90_yield)} / {price(stock.quantile_90_price)}</strong></div>
    </div>
    <p className={styles.muted}>统计 {stock.percentile_start || "—"} 至 {stock.percentile_end || "—"} · {stock.percentile_count} 个有效交易日（最多近五年，至少60日）。<br />分位 = 历史所选派息率 ≤ 当前所选派息率的样本占比。对应价格 = 当前所选口径每份分红 ÷ 分位派息率；分位派息率为零时无对应价格。分位、价格及列表网格均采用已保存的{label}。</p>
    <p className={styles.muted}>{basis === "annual" ? "历史各交易日采用上一完整自然年按除息日统计的现金分红，折算至当日份额，再除以当日不复权收盘价；不会纳入当年后续分红。" : basis === "rolling" ? "各交易日按此前12个月（左开右闭）已除息分红计算；两笔年度分红可能暂时重叠，也可能出现空档。" : "以当前价格 × 自定义派息率得到估算每份分红，再除以历史收盘价。这是估算回溯，不代表历史实际派息；报价变化后会重算。"}</p>
    {stock.history_note && <p className={styles.muted}>{stock.history_note}</p>}
    {stock.history_updated_at && <p className={styles.muted}>历史更新 {stock.history_updated_at}<br />来源：{stock.history_source}</p>}
  </section>;
}
