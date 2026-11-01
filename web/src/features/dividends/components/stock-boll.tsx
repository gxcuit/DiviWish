"use client";

import { useId, useState } from "react";
import { ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { useBoll } from "./boll-provider";
import { bollLabels } from "../boll-labels";
import type { BollBand, StockDetail } from "../types";
import styles from "./stock-boll.module.css";

const money = (value: number, currency: string) => `${currency}${value.toFixed(currency === "HK$" ? 3 : 2)}`;
const periods = [{ value: "day", label: "日线" }, { value: "week", label: "周线" }, { value: "month", label: "月线" }] as const;

function BandAxis({ band, price, currency }: { band: BollBand; price: number | null; currency: string }) {
  // Extend the scale to include out-of-band prices, retaining their real distance.
  const minimum = Math.min(band.lower, price ?? band.lower);
  const maximum = Math.max(band.upper, price ?? band.upper);
  const span = maximum - minimum || Math.max(Math.abs(band.middle) * 0.04, 1);
  const low = minimum - span * 0.15;
  const high = maximum + span * 0.15;
  const x = (value: number) => 24 + (value - low) / (high - low) * 512;
  const marker = price === null ? null : x(price);
  const anchor = marker !== null && marker < 110 ? "start" : marker !== null && marker > 450 ? "end" : "middle";
  return <>
    <svg className={styles.axis} viewBox="0 0 560 88" role="img" aria-label={`${band.label} BOLL：下轨 ${money(band.lower, currency)}，中轨 ${money(band.middle, currency)}，上轨 ${money(band.upper, currency)}；${price === null ? "当前价待核实" : `当前价 ${money(price, currency)}，${bollLabels[band.position].text}`}`}>
      <line x1="24" x2="536" y1="62" y2="62" stroke="#e4e8ee" strokeWidth="3" strokeLinecap="round" />
      <rect x={x(band.lower)} y="55" width={Math.max(x(band.upper) - x(band.lower), 0)} height="14" rx="7" fill="#e9edfa" />
      <line x1={x(band.lower)} x2={x(band.lower)} y1="53" y2="71" stroke="#4b89c8" strokeWidth="3" />
      <line x1={x(band.middle)} x2={x(band.middle)} y1="53" y2="71" stroke="#c58b27" strokeWidth="3" />
      <line x1={x(band.upper)} x2={x(band.upper)} y1="53" y2="71" stroke="#8b6db5" strokeWidth="3" />
      {marker !== null && price !== null && <g className={styles.currentMarker}>
        <text x={marker} y="25" textAnchor={anchor}>{money(price, currency)}</text>
        <path d={`M ${marker - 5} 35 L ${marker + 5} 35 L ${marker} 42 Z`} fill="currentColor" />
        <line x1={marker} x2={marker} y1="42" y2="62" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <circle cx={marker} cy="62" r="5" fill="currentColor" stroke="white" strokeWidth="2" />
      </g>}
    </svg>
    <dl className={styles.levels}>
      <div><dt><i className={styles.lowerDot} />下轨</dt><dd>{money(band.lower, currency)}</dd></div>
      <div><dt><i className={styles.middleDot} />中轨</dt><dd>{money(band.middle, currency)}</dd></div>
      <div><dt><i className={styles.upperDot} />上轨</dt><dd>{money(band.upper, currency)}</dd></div>
    </dl>
  </>;
}

export function StockBoll({ stock }: { stock: StockDetail }) {
  const { data, loading, error, refresh } = useBoll(stock);
  const [period, setPeriod] = useState<BollBand["period"]>("day");
  const periodGroup = useId();
  const currency = stock.market === "HK" ? "HK$" : "¥";

  return <section className={styles.section} aria-label={`${stock.name} BOLL 通道`} aria-busy={loading}>
    <div className={styles.heading}><h3><ChartNoAxesCombined size={17} />BOLL 通道 <span>20 周期 · 2σ</span></h3>
      <button type="button" disabled={loading} onClick={() => { void refresh(); }} aria-label="更新 BOLL 通道"><RefreshCw size={13} className={loading ? styles.spinning : ""} />{loading ? "加载中" : "更新"}</button>
    </div>
    {data && <div className={styles.quote}><span>当前价 <strong>{data.price === null ? "待核实" : money(data.price, currency)}</strong></span><small>{data.price_source} · {data.quote_date || "日期待核实"}{data.cached ? " · 5 分钟内缓存" : ""}</small></div>}
    <fieldset className={styles.periodPicker}>
      <legend className={styles.visuallyHidden}>BOLL 周期</legend>
      {periods.map(option => <label key={option.value}>
        <input type="radio" name={periodGroup} value={option.value} checked={period === option.value} onChange={() => setPeriod(option.value)} />
        <span>{option.label}</span>
      </label>)}
    </fieldset>
    {error && <p className={styles.error} role="alert">{error}{data ? "；下方保留上次结果，请留意数据日期。" : ""}</p>}
    {loading && !data && <p className={styles.loading} role="status">正在获取日线、周线、月线行情…</p>}
    {data && <div className={styles.frames}>{data.bands.filter(band => band.period === period).map(band => <article key={band.period} className={styles.frame}>
      <div className={styles.frameHeading}><h4>{band.label}</h4>{band.available && <span className={`${styles.position} ${["below_lower", "above_upper"].includes(band.position) ? styles.outside : ""}`}>{bollLabels[band.position].text}</span>}</div>
      {band.available ? <>
        <BandAxis band={band} price={data.price} currency={currency} />
        <p className={styles.caption}>K 线截至 {band.last_date} · {band.adjustment === "qfq" ? "前复权" : "未复权"}{data.quote_date && data.quote_date !== band.last_date ? " · 报价与 K 线日期不同" : ""}</p>
      </> : <p className={styles.unavailable}>{band.error}</p>}
    </article>)}</div>}
    <details className={styles.explanation}><summary>计算口径</summary><p>中轨为最近 20 根对应周期 K 线收盘价的简单均值，上下轨为中轨 ± 2 倍总体标准差。含当前尚未结束的日、周、月 K 线，其数值会随行情变化。各横轴独立缩放，红点表示当前价，蓝、金、紫刻度分别为下、中、上轨；超出通道时横轴自动延伸。数据来自腾讯证券，A 股以人民币、港股以港币显示。列表与详情共用通道数据，更新后同步显示。上下轨附近和中轨附近均按通道总宽度的 5% 判断；触及或越过上下轨仍单独区分。</p><p>参数参考 <a href="https://www.bollingerbands.com/bollinger-band-rules" target="_blank" rel="noreferrer">John Bollinger 的 BOLL 说明</a>。</p></details>
  </section>;
}
