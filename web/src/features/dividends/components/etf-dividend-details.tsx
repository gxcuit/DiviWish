import { EtfHistory } from "./etf-history";
import type { StockDetail } from "../types";
import styles from "./dashboard.module.css";

const cash = (value: number | null) => value === null ? "—" : `¥${value.toFixed(4)}`;
const rate = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;

export function EtfDividendDetails({ stock, historyState, onRetry }: { stock: StockDetail; historyState?: { loading: boolean; error: string }; onRetry: () => void }) {
  return <>
    <div className={styles.detailMetrics}>
      <div><span>上一自然年派息率（{stock.annual_year ?? "—"}）</span><strong>{rate(stock.dividend_yield)}</strong><small className={styles.metricNote}>{stock.dividend_annual_start || "待查询"} 至 {stock.dividend_annual_end || "待查询"} 已除息分红合计 ÷ 当前场内价格。</small></div>
      <div><span>滚动12个月派息率</span><strong>{rate(stock.rolling_yield)}</strong><small className={styles.metricNote}>{stock.dividend_rolling_start || "待查询"} 之后至 {stock.dividend_as_of || "待查询"}，按除息日统计，排除未来分红。</small></div>
      <div><span>上一自然年每份分红</span><strong>{cash(stock.annual_dividend)}</strong></div>
      <div><span>滚动12个月每份分红</span><strong>{cash(stock.rolling_dividend)}</strong></div>
      <div><span>目标派息率</span><strong>{rate(stock.target_yield)}</strong></div>
      <div><span>目标价格（选用口径）</span><strong>{cash(stock.target_price)}</strong></div>
      <div><span>年内涨跌</span><strong>{rate(stock.year_change)}</strong><small className={styles.metricNote}>基准 {stock.year_start_date || "待获取"}，不含现金分红再投资。</small></div>
      <div><span>下次已公告除息日</span><strong>{stock.next_ex_dividend_date || "暂无"}</strong></div>
    </div>
    <p className={styles.muted}>现金分红合计按可核实的拆分比例折算至统计日份额；原始逐次金额保留分红时口径。ETF 实际派息率与跟踪指数股息率不同。</p>
    {stock.dividend_note && <p className={stock.dividend_verification === "matched" ? styles.muted : styles.formError} role="status">{stock.dividend_note}</p>}
    {stock.verification_note && <p className={styles.formError}>{stock.verification_note}</p>}
    <EtfHistory key={`${stock.id}-${stock.yield_basis}`} stock={stock} state={historyState} onRetry={onRetry} />
    <h3>逐次现金分红（人民币／份）</h3>
    {stock.dividends.length ? <div className={styles.dividendParts}>{stock.dividends.map(part => <div key={part.date || part.period}>
      <span>除息 {part.date || part.period}<small>{part.status} · 登记 {part.record_date || "—"}<br />发放 {part.pay_date || "—"}</small></span><strong>{cash(part.dps)}</strong>
    </div>)}</div> : <p className={styles.muted}>{stock.dividend_as_of ? "查询成功，暂无现金分红记录" : "尚未获取分红明细，请刷新"}</p>}
    <p className={styles.muted}>最近已除息日 {stock.ex_dividend_date || "暂无"}<br />统计日期 {stock.dividend_as_of || "待获取"}<br />数据来源：{stock.source}</p>
  </>;
}
