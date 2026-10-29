"use client";

import { useState, type FormEvent } from "react";
import type { StockDetail, YieldBasis, YieldBasisSettings } from "../types";
import styles from "./stock-tools.module.css";

export const yieldLabels = { annual: "年度股息率", rolling: "滚动年度股息率", custom: "自定义股息率" };

export function YieldBasisPicker({ stock, onSave }: {
  stock: StockDetail;
  onSave: (settings: YieldBasisSettings) => Promise<void>;
}) {
  const [basis, setBasis] = useState<YieldBasis>(stock.yield_basis || "annual");
  const [custom, setCustom] = useState(stock.custom_yield == null ? "" : String(Number((stock.custom_yield * 100).toFixed(6))));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await onSave({ yield_basis: basis, custom_yield: custom === "" ? null : Number((Number(custom) / 100).toFixed(8)) });
      setMessage("已保存股息率选择，目标价格和网格已更新");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <section className={styles.basisSection} aria-label="股息率口径选择">
    <form onSubmit={save} onChange={() => { setMessage(""); setError(""); }}>
      <div className={styles.basisInputs}>
        <label>选用股息率<select value={basis} onChange={event => setBasis(event.target.value as YieldBasis)}>
          <option value="annual">年度股息率</option><option value="rolling">滚动年度股息率</option><option value="custom">自定义股息率</option>
        </select></label>
        {basis === "custom" && <label>自定义股息率（%）<input type="number" min="0" max="100" step="any" required value={custom} placeholder="如：6" onChange={event => setCustom(event.target.value)} /></label>}
      </div>
      <p className={styles.hint}>{basis === "custom" ? "直接输入估算百分比。对应价格 = 当前价格 × 自定义股息率 ÷ 目标股息率；报价变化后会重新折算。" : "保存后用于列表股息率、目标价格和个股网格。年度和滚动年度的原始指标仍分别保留。"}</p>
      <div className={styles.saveRow}><small>当前使用：{yieldLabels[stock.yield_basis || "annual"]} · {stock.selected_yield == null ? "—" : `${(stock.selected_yield * 100).toFixed(2)}%`}</small><button className={styles.primary} disabled={saving}>{saving ? "保存中…" : "保存股息率选择"}</button></div>
      {stock.selected_yield === null && <p className={styles.hint}>所选口径数据暂不可用，不使用其他口径代替。</p>}
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </section>;
}
