"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { DEFAULT_MARKET_SELECTION, MARKET_A_OPTIONS, MARKET_B_OPTIONS, resolveMarketSelection, type MarketSelection } from "../../../worker/market-indices";
import type { MarketPoint, MarketSnapshot } from "../../../worker/market-types";
import { api } from "../dividends/api";
import { RelativeBollChart, ValueRegressionChart } from "./market-analysis";
import styles from "./market-overview.module.css";

const ranges = [{ years: 0.5, label: "近半年" }, { years: 1, label: "近1年" }, { years: 3, label: "近3年" }, { years: 5, label: "近5年" }];
const percent = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
const points = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}`;
const trend = (value: number) => value > 0 ? styles.positive : value < 0 ? styles.negative : "";

function MarketChart({ series, returns, selection }: { series: MarketPoint[]; returns: boolean; selection: MarketSelection }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(900);
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.min(900, entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const activeIndex = Math.min(selected ?? series.length - 1, series.length - 1);
  const active = series[activeIndex];
  const values = series.flatMap(row => returns ? [row.dividend_return, row.a500_return] : [row.spread]);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = Math.max(max - min, 0.02);
  const low = min - span * 0.12, high = max + span * 0.12;
  const left = 46, right = width - 14, top = 20, bottom = 270;
  const x = (i: number) => series.length === 1 ? (left + right) / 2 : left + i / (series.length - 1) * (right - left);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const line = (key: "spread" | "dividend_return" | "a500_return") => series.map((row, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(row[key]).toFixed(2)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4);
  const indices = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  return <>
    <div className={styles.readout} aria-live="polite"><strong>{active.date}</strong><span>收益差 <b className={trend(active.spread)}>{points(active.spread)} 个百分点</b></span><span>{selection.a.short_name} {percent(active.dividend_return)}</span><span>{selection.b.short_name} {percent(active.a500_return)}</span></div>
    <div className={styles.chart} ref={container}>
      <svg viewBox={`0 0 ${width} 310`} role="img" aria-label={returns ? "两条全收益指数的40日涨跌幅历史曲线，单位百分比" : `${selection.a.name}减${selection.b.name}的40日收益差历史曲线，单位百分点`}>
        {ticks.map(tick => <g key={tick}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="#edf0f2" /><text x={left - 10} y={y(tick) + 4} textAnchor="end">{(tick * 100).toFixed(1)}{returns ? "%" : ""}</text></g>)}
        <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="#98a2b3" strokeDasharray="5 5" />
        {returns ? <><path d={line("dividend_return")} stroke="#df453b" /><path d={line("a500_return")} stroke="#3979b7" /></> : <path d={line("spread")} stroke="#df453b" />}
        <line x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={bottom} stroke="#a9afb8" strokeDasharray="3 4" />
        {(returns ? ["dividend_return", "a500_return"] as const : ["spread"] as const).map(key => <circle key={key} cx={x(activeIndex)} cy={y(active[key])} r={4} fill={key === "a500_return" ? "#3979b7" : "#df453b"} stroke="white" strokeWidth={2} />)}
        {indices.map((i, index) => <text key={i} x={x(i)} y={298} textAnchor={index === 0 ? "start" : index === indices.length - 1 ? "end" : "middle"}>{series[i].date}</text>)}
        <rect x={left} y={top} width={right - left} height={bottom - top} fill="transparent" onPointerMove={event => {
          const svg = event.currentTarget.ownerSVGElement!;
          const rect = svg.getBoundingClientRect();
          const svgX = (event.clientX - rect.left) / rect.width * width;
          setSelected(Math.max(0, Math.min(series.length - 1, Math.round((svgX - left) / (right - left) * (series.length - 1)))));
        }} />
      </svg>
    </div>
    <div className={styles.legend}><span><i />{returns ? selection.a.name : `40日收益差（${selection.a.short_name} − ${selection.b.short_name}）`}</span>{returns && <span><i className={styles.blue} />{selection.b.name}</span>}<span className={styles.unit}>单位：{returns ? "%" : "百分点"}</span></div>
    <label className={styles.scrubber}>查看交易日<input type="range" min={0} max={series.length - 1} value={activeIndex} onChange={event => setSelected(Number(event.target.value))} aria-label="查看历史交易日" aria-valuetext={`${active.date}，收益差 ${points(active.spread)} 个百分点`} /></label>
    <p className={styles.caption}>所选交易日的计算区间：{active.start_date} → {active.date} · 图表展示 {series.length} 个有效观察日</p>
  </>;
}

export function MarketOverview() {
  const [data, setData] = useState<MarketSnapshot | null>(null);
  const [selection, setSelection] = useState<MarketSelection>(DEFAULT_MARKET_SELECTION);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [years, setYears] = useState(1);
  const [returns, setReturns] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (target: MarketSelection, force = false) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setSelection(target); setLoading(true); setError("");
    // Never show the previous combination under newly selected labels.
    setData(current => current?.selection.a.code === target.a.code && current?.selection.b.code === target.b.code ? current : null);
    try {
      const query = new URLSearchParams({ a: target.a.code, b: target.b.code, ...(force ? { refresh: "1" } : {}) });
      const snapshot = await api<MarketSnapshot>(`/market?${query}`, { signal: request.signal });
      if (request.signal.aborted) return;
      if (snapshot.selection?.a.code !== target.a.code || snapshot.selection?.b.code !== target.b.code) throw new Error("返回的指数组合不一致，请重新获取");
      setData(snapshot);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "市场数据获取失败，请稍后重试");
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    let initial = DEFAULT_MARKET_SELECTION;
    try {
      const saved = JSON.parse(window.localStorage.getItem("diviwish:market-selection:v1") || "null");
      if (typeof saved?.a === "string" && typeof saved?.b === "string") initial = resolveMarketSelection(saved.a, saved.b);
    } catch { /* Invalid or unavailable browser storage uses the default selection. */ }
    void load(initial);
    return () => controller.current?.abort();
  }, [load]);

  function choose(a: string, b: string) {
    const next = resolveMarketSelection(a, b);
    try { window.localStorage.setItem("diviwish:market-selection:v1", JSON.stringify({ a: next.a.code, b: next.b.code })); } catch { /* Selection still works without persistence. */ }
    void load(next);
  }

  const latest = data?.latest;
  const cutoff = latest ? new Date(Date.parse(latest.date) - years * 365.25 * 86_400_000).toISOString().slice(0, 10) : "";
  const visible = data?.series.filter(row => row.date >= cutoff) ?? [];
  return <section className={styles.market} aria-label="市场情况">
    <div className={styles.intro}><div><span className={styles.eyebrow}><Activity size={15} />市场风格观察</span><h2>40日收益差</h2><p>{selection.a.name}（A）− {selection.b.name}（B）</p></div><button className={styles.refresh} disabled={loading} onClick={() => void load(selection, true)}><RefreshCw size={15} className={loading ? styles.spinning : ""} />{loading ? "获取中" : "刷新数据"}</button></div>
    <div className={styles.indexSelectors} role="group" aria-label="市场指数组合">
      <label>A · 比较指数<select aria-label="A 比较指数" value={selection.a.code} onChange={event => choose(event.target.value, selection.b.code)}>{MARKET_A_OPTIONS.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</select></label>
      <span className={styles.subtract} aria-hidden="true">−</span>
      <label>B · 基准指数<select aria-label="B 基准指数" value={selection.b.code} onChange={event => choose(selection.a.code, event.target.value)}>{MARKET_B_OPTIONS.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}</select></label>
    </div>
    {error && <div className={styles.warning} role="alert">{error}{data && "；当前保留上次成功数据。"}</div>}
    {data?.warning && <div className={styles.warning} role="status">{data.warning}</div>}
    {!data && <div className={styles.empty} role="status">{loading ? <><RefreshCw className={styles.spinning} size={24} /><p>正在获取两条全收益指数历史…</p></> : <><Activity size={28} /><p>暂时无法展示市场数据</p><button className={styles.refresh} onClick={() => void load(selection, true)}>重新获取</button></>}</div>}
    {data && latest && <>
      <div className={styles.cards}>
        <div className={styles.primaryCard}><span>最新40日收益差</span><strong className={trend(latest.spread)}>{points(latest.spread)}<small> 个百分点</small></strong><p>{latest.spread > 0 ? `${selection.a.short_name}近40日相对领先` : latest.spread < 0 ? `${selection.b.short_name}近40日相对领先` : "两者近40日表现持平"}</p></div>
        <div><span>{selection.a.name}（A）</span><strong className={trend(latest.dividend_return)}>{percent(latest.dividend_return)}</strong><p>{selection.a.code} · 近40日</p></div>
        <div><span>{selection.b.name}（B）</span><strong className={trend(latest.a500_return)}>{percent(latest.a500_return)}</strong><p>{selection.b.code} · 近40日</p></div>
      </div>
      <p className={styles.asof}>截至 {latest.date} 收盘 · 计算基日 {latest.start_date}{data.stale ? " · 上次成功数据" : ""}</p>
      <div className={styles.chartPanel} aria-busy={loading}>
        <div className={styles.chartHeading}><h3>历史走势</h3><div role="group" aria-label="图表时间范围" className={styles.segment}>{ranges.map(range => <button key={range.years} aria-pressed={years === range.years} onClick={() => setYears(range.years)}>{range.label}</button>)}</div></div>
        <div role="group" aria-label="图表指标" className={styles.tabs}><button aria-pressed={!returns} onClick={() => setReturns(false)}>40日收益差</button><button aria-pressed={returns} onClick={() => setReturns(true)}>指数40日涨跌幅</button></div>
        <MarketChart key={`${years}:${returns}:${data.fetched_at}`} series={visible} returns={returns} selection={selection} />
      </div>
      {data.relative && <RelativeBollChart data={data.relative} selection={selection} />}
      {data.regression && <ValueRegressionChart data={data.regression} selection={selection} />}
    </>}
    <div className={styles.method}><h3>指标怎么看</h3><p>收益差 = A近40个交易日涨跌幅 − B同期涨跌幅。大于0表示A相对领先，小于0表示A相对落后。相对领先也可能发生在两者都下跌时。</p><p>40日涨跌幅 =（当日全收益指数收盘值 ÷ 40个交易日前收盘值 − 1）× 100%。两条指数涨跌幅相减，收益差以“百分点”展示。需要41个有效收盘值，两个指数使用相同起止日期；不按自然日计算。</p><p>全收益指数包含现金分红再投资。采用已完成交易日数据，盘中不更新当日收盘值。历史不足所选范围时展示已有数据；缺失值不会按0补齐。</p><p>数据来源：<a href="https://www.csindex.com.cn" target="_blank" rel="noreferrer">中证指数有限公司</a> · <a href="https://mp.weixin.qq.com/s/ZI1KEZ_02F5YpN1Kgl1pMg" target="_blank" rel="noreferrer">参考文章</a>{data && <><br />最近成功获取：{new Date(data.fetched_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</>}</p></div>
  </section>;
}
