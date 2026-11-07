"use client";

import { useState, type FormEvent } from "react";
import type { StockDetail, YieldBasis, YieldBasisSettings } from "../types";
import styles from "./stock-tools.module.css";

export const yieldLabels = { annual: "年度股息率", rolling: "滚动年度股息率", custom: "自定义每股股息" };
export function YieldBasisPicker({ stock, onSave }: { stock: StockDetail; onSave: (settings: YieldBasisSettings) => Promise<void> }) {
  const etf = stock.instrument_type === "etf";
  const [basis, setBasis] = useState<YieldBasis>(stock.yield_basis || "annual");
  const [custom, setCustom] = useState(stock.custom_dividend == null ? "" : String(stock.custom_dividend));
  const [currency, setCurrency] = useState<"CNY" | "HKD">(stock.custom_dividend_currency ?? (stock.market === "HK" ? "HKD" : "CNY"));
  const [note, setNote] = useState(stock.custom_dividend_note ?? "");
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage(""); setError("");
    try {
      if (basis === "custom" && custom.trim() === "") throw new Error("请填写每股股息，明确不分红可填0");
      await onSave({ yield_basis: basis, custom_dividend: custom.trim() === "" ? null : Number(custom), custom_dividend_currency: currency, custom_dividend_note: note });
      setMessage("已保存，股息率、目标价格与网格已更新");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); } finally { setSaving(false); }
  }
  return <section className={styles.basisSection} aria-label="股息率口径选择">
    <form onSubmit={save} onChange={() => { setMessage(""); setError(""); }}>
      <div className={styles.basisInputs}>
        <label>选用股息率<select aria-label="选用股息率" value={basis} onChange={event => setBasis(event.target.value as YieldBasis)}>
          <option value="annual">{etf ? "上一自然年派息率" : "年度股息率"}</option><option value="rolling">{etf ? "滚动12个月派息率" : "滚动年度股息率"}</option><option value="custom">{etf ? "自定义每份分红" : "自定义每股股息"}</option>
        </select></label>
        {basis === "custom" && <>
          <label>{etf ? "自定义每份分红" : "自定义每股股息"}<input type="number" min="0" max="1000000000" step="any" required value={custom} placeholder="如：1.20" onChange={event => setCustom(event.target.value)} /></label>
          <label>股息币种<select aria-label="股息币种" value={currency} onChange={event => setCurrency(event.target.value as typeof currency)}><option value="CNY">人民币 CNY</option><option value="HKD">港币 HKD</option></select></label>
          <label>自定义股息备注（可选）<textarea maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="如：年度股息估算及依据" /></label>
        </>}
      </div>
      <p className={styles.hint}>{basis === "custom" ? `${etf ? "每份分红" : "每股股息"}以填写金额保存，股息率＝股息金额÷当前股价；币种不同时先换算。报价更新只改变股息率，不改写已保存金额。目标价和网格价格＝该金额（换算至股价币种）÷目标股息率。历史分位为固定股息估算回溯，并非历史实际分红。` : etf ? "年度按上一完整自然年派息计算，滚动按此前12个月计算。保存后联动列表、目标价格、网格和历史分位。" : "保存后用于列表、排行、目标价格、个股网格和历史分位。年度和滚动年度的原始指标仍分别保留。"}</p>
      <div className={styles.saveRow}><small>当前使用：{etf && stock.yield_basis === "custom" ? "自定义每份分红" : yieldLabels[stock.yield_basis || "annual"]} · {stock.selected_yield == null ? "—" : `${(stock.selected_yield * 100).toFixed(2)}%`}</small><button className={styles.primary} disabled={saving}>{saving ? "保存中…" : "保存股息率选择"}</button></div>
      {stock.custom_dividend_note && stock.yield_basis === "custom" && <p className={styles.hint}>已保存备注：{stock.custom_dividend_note}</p>}
      {stock.selected_yield === null && <p className={styles.hint}>所选口径数据暂不可用，不使用其他口径代替。</p>}
      {message && <p className={styles.success} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </section>;
}
