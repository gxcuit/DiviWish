import type { StockDetail } from "../types";
import styles from "./dashboard.module.css";

export function StockDividendDetails({ stock }: { stock: StockDetail }) {
  const source = stock.dividend_source || stock.source;
  const sourceUrl = /^https:\/\/(datacenter-web|datacenter)\.eastmoney\.com\//.test(source) ? source : null;
  return <>
    <h3>{stock.annual_year ? `${stock.annual_year} 财年分红明细` : "年度分红明细"}</h3>
    <p className={styles.muted}>按分红所属报告期汇总，不是该自然年到账金额。年末分红可能在次年实施；除息日也不等于实际到账日。</p>
    {stock.dividends.length ? <div className={styles.dividendParts}>{stock.dividends.map((part, index) => <div key={`${part.period}-${index}`}>
      <span>所属报告期 {part.period}<small>{part.status}<br />除息日 {part.date || "未提供"} · 登记日 {part.record_date || "未提供"}<br />发放日 {part.pay_date || "来源未提供"}
        {part.plan_notice_date && <><br />预案公告日 {part.plan_notice_date}</>}
        {part.notice_date && <><br />方案最新公告日 {part.notice_date}</>}
      </small></span>
      <strong>¥{part.dps.toFixed(3)} / 股</strong>
    </div>)}</div> : <p className={styles.muted}>暂无可核实的分笔明细</p>}
    <p className={styles.muted}>分红来源：{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">东方财富公开分红资料（原始记录）</a> : source}
      {stock.dividend_updated_at && <><br />分红数据更新于 {stock.dividend_updated_at.replace("T", " ")}</>}
    </p>
  </>;
}
