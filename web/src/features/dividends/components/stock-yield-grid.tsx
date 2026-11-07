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
  const [sellStart, setSellStart] = useState(percentage(stock.grid_sell_start ?? 0.04));
  const [sellEnd, setSellEnd] = useState(percentage(stock.grid_sell_end ?? 0.02));
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
      const rate = (value: string) => Number((Number(value) / 100).toFixed(8));
      if (Number(start) > Number(end)) throw new Error("买入起始股息率不能大于买入结束股息率");
      if (Number(sellStart) < Number(sellEnd)) throw new Error("卖出起始股息率不能小于卖出结束股息率");
      await onSave({ grid_start: rate(start), grid_end: rate(end), grid_sell_start: rate(sellStart), grid_sell_end: rate(sellEnd), grid_step: rate(step) });
      setMessage("已保存该股票的网格设置");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <section className={styles.gridSection} aria-label={`${stock.name}股息率网格`}>
    <h3 className={styles.heading}><Grid3X3 size={17} />股息率网格</h3>
    <form onSubmit={save} onChange={() => { setMessage(""); setError(""); }}>
      <div className={styles.gridInputs}>
        <label>买入起始股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>买入结束股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={end} onChange={event => setEnd(event.target.value)} /></label>
        <label>每格步长（百分点）<input type="number" min="0.1" max="100" step="0.1" required value={step} onChange={event => setStep(event.target.value)} /></label>
        <label>卖出起始股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={sellStart} onChange={event => setSellStart(event.target.value)} /></label>
        <label>卖出结束股息率（%）<input type="number" min="0.1" max="100" step="0.1" required value={sellEnd} onChange={event => setSellEnd(event.target.value)} /></label>
      </div>
      <div className={styles.saveRow}><small>共用步长，例如 0.5：买入 3% → 3.5% → 4%；卖出 4% → 3.5% → 3%。</small><button className={styles.primary} disabled={saving}>{saving ? "保存中…" : "保存网格设置"}</button></div>
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
    {([
      { title: "买入网格", rows: stock.yield_grid, hint: "股息率逐档升高，对应价格逐档降低；当前价格 ≤ 档位价格时已达到。" },
      { title: "卖出网格", rows: stock.sell_yield_grid, hint: "股息率逐档降低，对应价格逐档升高；当前价格 ≥ 档位价格时已达到。" },
    ]).map(({ title, rows, hint }) => <div key={title}>
      <h4 className={styles.gridTitle}>{title}</h4>
      <p className={styles.hint}>{hint}</p>
      <div className={styles.gridTableWrap}>
        <table aria-label={`${stock.name}${title}股息率对应价格`}><thead><tr><th>股息率</th><th>对应价格（{stock.market === "HK" ? "HKD" : "CNY"}）</th><th>当前状态</th></tr></thead>
          <tbody>{(rows || []).map(row => <tr key={row.yield} className={row.reached ? styles.reached : ""}><td>{percentage(row.yield)}%</td><td>{row.price === null ? "—" : `${stock.market === "HK" ? "HK$" : "¥"}${row.price.toFixed(2)}`}</td><td>{row.reached === null ? "待核实" : row.reached ? "已达到" : "未达到"}</td></tr>)}</tbody>
        </table>
      </div>
    </div>)}
    <p className={styles.hint}>当前采用{yieldLabels[stock.yield_basis || "annual"]}。{stock.yield_basis === "custom" ? "对应价格 = 已保存的自定义每股股息（换算至股价币种）÷ 网格股息率。" : `对应价格 = ${stock.yield_basis === "rolling" ? "滚动年度" : "年度"}${stock.instrument_type === "etf" ? "每份分红" : "每股股息"} ÷ 网格股息率；港股按汇率换算。`}按已保存设置展示，每个方向最多 201 档；结束值未对齐时止于范围内最后一格。</p>
  </section>;
}
