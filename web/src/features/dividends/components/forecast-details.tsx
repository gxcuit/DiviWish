"use client";

import { useState, type FormEvent } from "react";
import type { ForecastCurrency, ForecastManualInput } from "../../../../worker/forecast-types";
import type { StockDetail } from "../types";
import styles from "./stock-tools.module.css";

export function ForecastDetails({ stock, onSave }: {
  stock: StockDetail;
  onSave: (settings: { forecast_manual: ForecastManualInput | null }) => Promise<void>;
}) {
  const forecast = stock.forecast, manual = stock.forecast_manual;
  const valid = manual && (manual.kind === "yield" || manual.kind === "per_share") && Number.isFinite(manual.dividend) && Number.isFinite(manual.value);
  const currentYear = forecast?.year ?? Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const [kind, setKind] = useState<ForecastManualInput["kind"]>(valid ? manual.kind : "yield");
  const [value, setValue] = useState(valid ? String(manual.value * (manual.kind === "yield" ? 100 : 1)) : "");
  const [year, setYear] = useState(String(valid ? manual.year : currentYear));
  const tradingCurrency = stock.market === "HK" ? "HKD" : "CNY";
  const [currency, setCurrency] = useState<ForecastCurrency>(valid ? manual.currency : tradingCurrency);
  const [note, setNote] = useState(valid ? manual.note : "");
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      if (value.trim() === "") throw new Error("请填写预估值，明确不分红可填0");
      await onSave({ forecast_manual: { year: Number(year), kind, value: Number(value) / (kind === "yield" ? 100 : 1),
        currency: kind === "yield" ? tradingCurrency : currency, note } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); } finally { setSaving(false); }
  }
  async function clear() {
    setSaving(true); setError("");
    try { await onSave({ forecast_manual: null }); setValue(""); setNote(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "清除失败"); } finally { setSaving(false); }
  }
  return <section className={styles.basisSection} aria-label="手动预估年度股息率">
    <h3>{currentYear} 财年预估股息率（手动）</h3>
    <strong>{forecast?.yield == null ? "—" : `${(forecast.yield * 100).toFixed(2)}%`}</strong>
    <p className={styles.hint}>全年每股预估股息 {forecast?.currency ?? tradingCurrency} {forecast?.dividend == null ? "—" : forecast.dividend.toFixed(4)}。{forecast?.reason}</p>
    <p className={styles.hint}>全年金额包含同财年中期分红，不要重复叠加；不代表今天买入后未来十二个月可领取金额。选用预估口径后联动列表、排行、目标价格及买卖网格，不计算历史分位。</p>
    {valid && <p className={styles.hint}>已保存 {manual.year} 财年 · {manual.kind === "yield" ? `输入 ${(manual.value * 100).toFixed(2)}%，按保存时股价 ${manual.reference_price ?? "—"} ${manual.currency} 折算` : "按年度每股股息录入"} · 原币每股股息 {manual.currency} {manual.dividend.toFixed(4)}<br />保存时间 {manual.updated_at ? new Date(manual.updated_at).toLocaleString("zh-CN") : "—"}{manual.note && <><br />备注：{manual.note}</>}</p>}
    <form onSubmit={save}>
      <div className={styles.basisInputs}>
        <label>适用财年<input type="number" min="2000" max="2200" required value={year} onChange={event => setYear(event.target.value)} /></label>
        <label>填写方式<select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setValue(""); }}><option value="yield">预估股息率（%）</option><option value="per_share">年度每股股息</option></select></label>
        <label>{kind === "yield" ? "预估股息率（%）" : "预估年度每股股息"}<input type="number" min="0" max={kind === "yield" ? "100" : "1000000000"} step="any" required value={value} onChange={event => setValue(event.target.value)} /></label>
        {kind === "per_share" && <label>股息币种<select value={currency} onChange={event => setCurrency(event.target.value as ForecastCurrency)}><option value="CNY">人民币 CNY</option><option value="HKD">港币 HKD</option></select></label>}
        <label>预估备注（可选）<textarea maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="填写你的判断依据" /></label>
      </div>
      <p className={styles.hint}>{kind === "yield" ? "百分比按保存时股价折算为年度每股股息并保存，之后股息率随报价更新；没有有效股价时请改填每股股息。" : "股息率＝手动年度每股股息÷当前股价，港股币种不同时使用已保存汇率换算。"}仅使用当前财年输入，跨财年请重新填写。数据仅保存在当前用户／本机。</p>
      <button className={styles.primary} disabled={saving}>{saving ? "正在保存…" : "保存手动预估"}</button>{" "}
      <button type="button" disabled={saving || !manual} onClick={clear}>清除手动预估</button>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </section>;
}
