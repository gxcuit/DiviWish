"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MarketSelection } from "../../../worker/market-indices";
import type { RegressionPoint, RegressionSnapshot, RelativePoint, RelativeSnapshot } from "../../../worker/market-types";
import styles from "./market-overview.module.css";

const ranges = [{ years: 1, label: "1年" }, { years: 3, label: "3年" }, { years: 5, label: "5年" }, { years: 10, label: "10年" }, { years: 0, label: "全部" }];
const number = (value: number | null, digits = 3) => value === null ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
type Line<Row> = { label: string; color: string; value: (row: Row) => number | null; dashed?: boolean };

function RangeSelector({ years, onChange, label }: { years: number; onChange: (years: number) => void; label: string }) {
  return <div role="group" aria-label={label} className={styles.segment}>{ranges.map(range => <button key={range.years} aria-pressed={years === range.years} onClick={() => onChange(range.years)}>{range.label}</button>)}</div>;
}

function range<Row extends { date: string }>(series: Row[], years: number): Row[] {
  if (!years) return series;
  const cutoff = Date.parse(series.at(-1)!.date) - years * 365.25 * 86_400_000;
  return series.filter(row => Date.parse(row.date) >= cutoff);
}

function AnalysisChart<Row extends { date: string }>({ series, lines, band, logarithmic = false, label, readout, digits = 3 }: {
  series: Row[]; lines: Line<Row>[]; band?: { lower: (row: Row) => number | null; upper: (row: Row) => number | null; label: string };
  logarithmic?: boolean; label: string; readout: (row: Row) => ReactNode; digits?: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(900);
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.min(900, entries[0].contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const activeIndex = Math.min(selected ?? series.length - 1, series.length - 1), active = series[activeIndex];
  const values = series.flatMap(row => [...lines.map(line => line.value(row)), ...(band ? [band.lower(row), band.upper(row)] : [])])
    .filter((value): value is number => value !== null && Number.isFinite(value) && (!logarithmic || value > 0));
  const scale = (value: number) => logarithmic ? Math.log(value) : value;
  const min = Math.min(...values.map(scale)), max = Math.max(...values.map(scale));
  const padding = Math.max(max - min, logarithmic ? 0.01 : Math.abs(max) * 0.02, 1e-6) * 0.12;
  const low = min - padding, high = max + padding;
  const left = logarithmic ? 58 : 46, right = width - 12, top = 20, bottom = 270;
  const dates = series.map(row => Date.parse(row.date)), first = dates[0], last = dates.at(-1)!;
  const x = (i: number) => first === last ? (left + right) / 2 : left + (dates[i] - first) / (last - first) * (right - left);
  const y = (value: number) => bottom - (scale(value) - low) / (high - low) * (bottom - top);
  const path = (value: (row: Row) => number | null) => {
    let open = false;
    return series.map((row, i) => {
      const v = value(row);
      if (v === null) { open = false; return ""; }
      const result = `${open ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`; open = true; return result;
    }).join(" ");
  };
  const areas: string[] = [];
  if (band) {
    let run: { i: number; lower: number; upper: number }[] = [];
    const flush = () => {
      if (run.length) areas.push(run.map((row, i) => `${i ? "L" : "M"}${x(row.i)},${y(row.upper)}`).join(" ") + " " + [...run].reverse().map(row => `L${x(row.i)},${y(row.lower)}`).join(" ") + " Z");
      run = [];
    };
    series.forEach((row, i) => {
      const lower = band.lower(row), upper = band.upper(row);
      if (lower === null || upper === null) flush(); else run.push({ i, lower, upper });
    }); flush();
  }
  const ticks = Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4);
  const labels = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  return <>
    <div className={styles.readout} aria-live="polite"><strong>{active.date}</strong>{readout(active)}</div>
    <div className={styles.chart} ref={container}><svg viewBox={`0 0 ${width} 310`} role="img" aria-label={label}>
      {ticks.map(tick => <g key={tick}><line x1={left} x2={right} y1={bottom - (tick - low) / (high - low) * (bottom - top)} y2={bottom - (tick - low) / (high - low) * (bottom - top)} stroke="#edf0f2" /><text x={left - 8} y={bottom - (tick - low) / (high - low) * (bottom - top) + 4} textAnchor="end">{number(logarithmic ? Math.exp(tick) : tick, digits)}</text></g>)}
      {areas.map((area, i) => <path key={i} d={area} className={styles.bandArea} />)}
      {lines.map(line => <path key={line.label} d={path(line.value)} stroke={line.color} strokeDasharray={line.dashed ? "5 4" : undefined} />)}
      <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={bottom} stroke="#a9afb8" strokeDasharray="3 4" />
      {lines.map(line => line.value(active) !== null && <circle key={line.label} cx={x(activeIndex)} cy={y(line.value(active)!)} r={3.5} fill={line.color} stroke="white" strokeWidth={1.5} />)}
      {labels.map((i, index) => <text key={i} x={x(i)} y={298} textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}>{series[i].date}</text>)}
      <rect x={left} y={top} width={right - left} height={bottom - top} fill="transparent" onPointerMove={event => {
        const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
        const target = first + Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * width - left) / (right - left))) * (last - first);
        let lo = 0, hi = dates.length - 1;
        while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dates[mid] < target) lo = mid + 1; else hi = mid; }
        setSelected(lo > 0 && target - dates[lo - 1] < dates[lo] - target ? lo - 1 : lo);
      }} />
    </svg></div>
    <div className={styles.legend}>{lines.map(line => <span key={line.label}><i style={{ background: line.color }} />{line.label}</span>)}{band && <span><i className={styles.bandSwatch} />{band.label}</span>}</div>
    <label className={styles.scrubber}>查看交易日<input type="range" min={0} max={series.length - 1} value={activeIndex} onChange={event => setSelected(Number(event.target.value))} aria-label={`${label}查看交易日`} aria-valuetext={active.date} /></label>
  </>;
}

export function RelativeBollChart({ data, selection }: { data: RelativeSnapshot; selection: MarketSelection }) {
  const [years, setYears] = useState(0);
  const latest = data.latest, visible = range(data.series, years);
  const lines: Line<RelativePoint>[] = [{ label: `${selection.a.short_name} / ${selection.b.short_name} 归一化比值`, color: "#285f9f", value: row => row.ratio }, { label: "MA242", color: "#d86b80", value: row => row.middle }];
  return <section className={`${styles.chartPanel} ${styles.analysisPanel}`} aria-label="242日比值BOLL">
    <div className={styles.chartHeading}><h3>{selection.a.short_name} / {selection.b.short_name} · 242日 BOLL</h3><RangeSelector years={years} onChange={setYears} label="BOLL时间范围" /></div>
    <div className={styles.analysisMetrics}><span>最新比值 <b>{number(latest.ratio)}</b></span><span>%B <b>{number(latest.percent_b, 2)}</b></span><span>带宽 <b>{percent(latest.bandwidth)}</b></span></div>
    <AnalysisChart key={`${years}:${data.series.length}`} series={visible} lines={lines} band={{ lower: row => row.lower, upper: row => row.upper, label: "±2σ 布林带" }} label={`${selection.a.short_name}与${selection.b.short_name}比值242日BOLL曲线`} readout={row => <><span>比值 {number(row.ratio)}</span><span>中轨 {number(row.middle)}</span><span>上轨 {number(row.upper)}</span><span>下轨 {number(row.lower)}</span></>} />
    {latest.middle === null && <p className={styles.warning}>近期连续共同有效交易日不足242个，暂不显示当前布林带。</p>}
    <p className={styles.caption}>统一以 {data.base_date} 为1：比值 =（A / A基值）÷（B / B基值）。中轨为242日均线，上下轨为均线 ± 2倍总体标准差。%B 不截断，超过1表示在上轨之外；带宽 =（上轨 − 下轨）/ 中轨。</p>
  </section>;
}

export function ValueRegressionChart({ data, selection }: { data: RegressionSnapshot; selection: MarketSelection }) {
  const [years, setYears] = useState(0);
  const visible = range(data.series, years);
  const lines: Line<RegressionPoint>[] = [{ label: selection.a.name, color: "#285f9f", value: row => row.close }, { label: "对数拟合直线", color: "#d86b80", value: row => row.fitted, dashed: true }];
  return <section className={`${styles.chartPanel} ${styles.analysisPanel}`} aria-label="价值回归">
    <div className={styles.chartHeading}><h3>价值回归 · {selection.a.name}</h3><RangeSelector years={years} onChange={setYears} label="价值回归时间范围" /></div>
    <div className={styles.analysisMetrics}><span>R² <b>{number(data.r_squared, 2)}</b></span><span>拟合年化 <b>{percent(data.annualized_return)}</b></span><span>年化波动 <b>{percent(data.annualized_volatility)}</b></span></div>
    <AnalysisChart key={`${years}:${data.count}`} series={visible} lines={lines} logarithmic digits={0} band={{ lower: row => row.lower, upper: row => row.upper, label: "±1.5σ 残差带" }} label={`${selection.a.name}价值回归对数坐标曲线`} readout={row => <><span>指数 {number(row.close, 2)}</span><span>拟合 {number(row.fitted, 2)}</span><span>偏离拟合 {percent(row.close / row.fitted - 1)}</span></>} />
    <p className={styles.caption}>对数纵轴 · 固定拟合区间 {data.start_date} → {data.end_date} · {data.count} 个样本。按经过的自然年拟合 ln（全收益指数），阴影为对数残差 ±1.5σ；切换范围只改变显示。年化波动按相邻交易日对数收益率及每年242日估算。全样本事后拟合会随新增数据变化，属于历史趋势参考。</p>
  </section>;
}
