"use client";

import { useState, type FormEvent } from "react";
import { Grid3X3 } from "lucide-react";
import type { GridSettings, StockDetail } from "../types";
import styles from "./stock-tools.module.css";
import { yieldLabels } from "./yield-basis-picker";

const percentage = (value: number) => Number((value * 100).toFixed(6)).toString();

export function StockYieldGrid({ stock, onSave }: {
  stock: StockDetail;
  onSave: (settings: GridSettings) => Promise<void>;
}) {
  const [start, setStart] = useState(percentage(stock.grid_start ?? 0.03));
  const [end, setEnd] = useState(percentage(stock.grid_end ?? 0.08));
  const [step, setStep] = useState(percentage(stock.grid_step ?? 0.005));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await onSave({ grid_start: Number((Number(start) / 100).toFixed(8)), grid_end: Number((Number(end) / 100).toFixed(8)), grid_step: Number((Number(step) / 100).toFixed(8)) });
      setMessage("已保存该股票的网格设置");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <section className={styles.gridSection} aria-label={`${stock.name}股息率网格`}>
    <h3 className={styles.heading}><Grid3X3 size={17} />股息率网格</h3>
    <form onSubmit={save} onChange={() => { setMessage(""); setError(""); }}>
      <div className={styles.gridInputs}>
        <label>起始股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>结束股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={end} onChange={event => setEnd(event.target.value)} /></label>
        <label>每格步长（百分点）<input type="number" min="0.1" max="100" step="0.1" required value={step} onChange={event => setStep(event.target.value)} /></label>
      </div>
      <div className={styles.saveRow}><small>例如步长 0.5：3% → 3.5% → 4%。</small><button className={styles.primary} disabled={saving}>{saving ? "保存中…" : "保存网格设置"}</button></div>
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
    <div className={styles.gridTableWrap}>
      <table aria-label={`${stock.name}股息率对应价格`}><thead><tr><th>股息率</th><th>对应价格（{stock.market === "HK" ? "HKD" : "CNY"}）</th><th>当前状态</th></tr></thead>
        <tbody>{(stock.yield_grid || []).map(row => <tr key={row.yield} className={row.reached ? styles.reached : ""}><td>{percentage(row.yield)}%</td><td>{row.price === null ? "—" : `${stock.market === "HK" ? "HK$" : "¥"}${row.price.toFixed(2)}`}</td><td>{row.reached === null ? "待核实" : row.reached ? "已达到" : "未达到"}</td></tr>)}</tbody>
      </table>
    </div>
    <p className={styles.hint}>当前采用{yieldLabels[stock.yield_basis || "annual"]}。{stock.yield_basis === "custom" ? "对应价格 = 当前价格 × 自定义股息率 ÷ 网格股息率。" : `对应价格 = ${stock.yield_basis === "rolling" ? "滚动年度" : "年度"}每股股息 ÷ 网格股息率；港股按汇率换算。`}按已保存设置展示，上限未对齐时止于最后一格。</p>
  </section>;
}
