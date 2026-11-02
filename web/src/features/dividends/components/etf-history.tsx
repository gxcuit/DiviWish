import { useState } from "react";
import type { StockDetail } from "../types";
import styles from "./dashboard.module.css";

const rate = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const price = (value: number | null) => value === null ? "—" : `¥${value.toFixed(4)}`;

export function EtfHistory({ stock, state, onRetry }: { stock: StockDetail; state?: { loading: boolean; error: string }; onRetry: () => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const rows = stock.percentile_history;
  const basis = stock.yield_basis || "annual";
  const label = basis === "annual" ? "上一自然年派息率" : basis === "rolling" ? "滚动12个月派息率" : "自定义估算派息率";
  const notes = { overlap: "分红窗口重叠：近12个月内包含两笔相隔至少270天的分红，可能受年度派息日期提前影响。",
    gap: "分红窗口空档：上一笔分红已满12个月，尚未有新分红；可能受年度派息日期推迟影响。",
    no_cash: "此前12个月无现金派息。", before_first: "截至该交易日尚无首次现金派息。" };
  const specials: { start: number; end: number; kind: "overlap" | "gap" }[] = [];
  rows.forEach((row, i) => {
    if (row.window_status !== "overlap" && row.window_status !== "gap") return;
    const last = specials.at(-1);
    if (last?.kind === row.window_status && last.end === i - 1) last.end = i;
    else specials.push({ start: i, end: i, kind: row.window_status });
  });
  const index = Math.min(selected ?? rows.length - 1, rows.length - 1), point = rows[index];
  const max = Math.max(...rows.map(row => row.yield), stock.quantile_90_yield ?? 0, stock.selected_yield ?? 0, 0.01) * 1.12;
  const x = (i: number) => 10 + i / Math.max(rows.length - 1, 1) * 560;
  const y = (value: number) => 180 - value / max * 166;
  return <section aria-label="ETF 派息率历史分位">
    <h3>{label}历史分位 <strong className={styles.red}>{rate(stock.percentile)}</strong></h3>
    {state?.loading && <p className={styles.muted} role="status">正在获取历史行情与分红，计算年度及滚动派息率分位…</p>}
    {state?.error && <p className={styles.formError} role="alert">{state.error}</p>}
    <button className={styles.historyRetry} disabled={state?.loading} onClick={onRetry}>{state?.loading ? "计算中…" : "重新获取历史数据"}</button>
    {rows.length > 0 ? <div className={styles.chart}>
      <div className={styles.etfPlot}><div className={styles.etfAxis}><span>{rate(max)}</span><span>{rate(max / 2)}</span><span>0.00%</span></div>
      <svg viewBox="0 0 600 190" preserveAspectRatio="none" role="img" aria-label={`近五年${label}历史曲线，虚线为60和90分位`} onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSelected(Math.max(0, Math.min(rows.length - 1, Math.round(((event.clientX - rect.left) / rect.width * 600 - 10) / 560 * (rows.length - 1)))));
      }}>
        {specials.map(range => <rect key={range.start} x={x(range.start)} y="14" width={Math.max(2, x(Math.min(range.end + 1, rows.length - 1)) - x(range.start))} height="166" fill={range.kind === "overlap" ? "#fbbf24" : "#60a5fa"} opacity="0.22"><title>{range.kind === "overlap" ? "分红窗口重叠" : "分红窗口空档"} {rows[range.start].date} 至 {rows[range.end].date}</title></rect>)}
        {[0, 0.5, 1].map(factor => <g key={factor}><line x1="10" x2="570" y1={y(max * factor)} y2={y(max * factor)} stroke="#e5e7eb" /></g>)}
        {[[stock.quantile_60_yield, "60", "#d97706"], [stock.quantile_90_yield, "90", "#7c3aed"]].map(([value, label, color]) => typeof value === "number" && <g key={label}><line x1="10" x2="570" y1={y(value)} y2={y(value)} stroke={String(color)} strokeDasharray="6 4" /></g>)}
        <path d={rows.map((row, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(row.yield).toFixed(2)}`).join(" ")} fill="none" stroke="#c5392e" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        {point && <g><line x1={x(index)} x2={x(index)} y1="14" y2="180" stroke="#9ca3af" strokeDasharray="3 3" /><circle cx={x(index)} cy={y(point.yield)} r="3" fill="#c5392e" /></g>}
      </svg></div>
      <div className={styles.chartLabels}><span>{rows[0].date}</span><span>{rows.at(-1)!.date}</span></div>
      <div className={styles.etfLegend}><span>橙色虚线：60 分位</span><span>紫色虚线：90 分位</span></div>
      <input className={styles.historySlider} aria-label="选择历史交易日" type="range" min="0" max={rows.length - 1} value={index} onChange={event => setSelected(Number(event.target.value))} />
      {point && <p className={styles.muted} aria-live="polite">{point.date} · {label} {rate(point.yield)} · 收盘价 {price(point.close)}</p>}
      {point?.window_status && <p className={styles.windowNote} role="status">{notes[point.window_status]}</p>}
      {specials.length > 0 && <details className={styles.windowSummary}><summary>滚动窗口特殊情况 · {specials.length} 段（黄色重叠／蓝色空档）</summary>
        <p>以下为日期间隔规则提示，保留全部样本和真实派息率；不推断基金未来派息。</p>
        {specials.map(range => <button key={range.start} onClick={() => setSelected(range.start)}>{rows[range.start].date} ～ {rows[range.end].date} · {range.kind === "overlap" ? "分红窗口重叠" : "分红窗口空档"}</button>)}
      </details>}
    </div> : !state?.loading && <p className={styles.muted}>{stock.history_status === "not_applicable" ? "暂无可用派息率分位。" : "历史数据尚未获取成功。"}</p>}
    {stock.percentile_unavailable_reason && <p className={styles.muted}>{stock.percentile_unavailable_reason}</p>}
    <div className={styles.detailMetrics}>
      <div><span>60 分位{label} / 对应价格</span><strong>{rate(stock.quantile_60_yield)} / {price(stock.quantile_60_price)}</strong></div>
      <div><span>90 分位{label} / 对应价格</span><strong>{rate(stock.quantile_90_yield)} / {price(stock.quantile_90_price)}</strong></div>
    </div>
    <p className={styles.muted}>统计 {stock.percentile_start || "—"} 至 {stock.percentile_end || "—"} · {stock.percentile_count} 个有效交易日（最多近五年，至少60日）。<br />分位 = 历史所选派息率 ≤ 当前所选派息率的样本占比。对应价格 = 当前所选口径每份分红 ÷ 分位派息率；分位派息率为零时无对应价格。曲线、分位、价格及列表网格均采用已保存的{label}。</p>
    <p className={styles.muted}>{basis === "annual" ? "历史各交易日采用上一完整自然年按除息日统计的现金分红，折算至当日份额，再除以当日不复权收盘价；不会纳入当年后续分红。" : basis === "rolling" ? "各交易日按此前12个月（左开右闭）已除息分红计算；两笔年度分红可能暂时重叠，也可能出现空档。" : "以当前价格 × 自定义派息率得到估算每份分红，再除以历史收盘价。这是估算回溯，不代表历史实际派息；报价变化后会重算。"}</p>
    {stock.history_note && <p className={styles.muted}>{stock.history_note}</p>}
    {stock.history_updated_at && <p className={styles.muted}>历史更新 {stock.history_updated_at}<br />来源：{stock.history_source}</p>}
  </section>;
}
