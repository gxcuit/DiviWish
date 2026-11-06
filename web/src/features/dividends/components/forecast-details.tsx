"use client";

import { useState, type FormEvent } from "react";
import type { ForecastManual, ForecastCommitment } from "../../../../worker/forecast-types";
import type { StockDetail } from "../types";
import styles from "./stock-tools.module.css";

export function ForecastDetails({ stock, state, onRefresh, onSave }: {
  stock: StockDetail;
  state?: { loading: boolean; error: string };
  onRefresh: (force?: boolean) => void;
  onSave: (settings: { forecast_manual: ForecastManual | null }) => Promise<void>;
}) {
  const forecast = stock.forecast;
  const year = forecast?.year ?? Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const manual = stock.forecast_manual, commitment = manual?.commitment;
  const [kind, setKind] = useState<ForecastCommitment["kind"] | "none">(commitment?.kind ?? "none");
  const [value, setValue] = useState(commitment ? String(commitment.value * (commitment.kind === "ratio" ? 100 : 1)) : "");
  const [currency, setCurrency] = useState(commitment?.currency ?? (stock.market === "HK" ? "HKD" : "CNY"));
  const [start, setStart] = useState(String(commitment?.start_year ?? year));
  const [end, setEnd] = useState(String(commitment?.end_year ?? year));
  const [conditions, setConditions] = useState(commitment?.conditions ?? "");
  const [url, setUrl] = useState(commitment?.evidence.url ?? "");
  const [shares, setShares] = useState(commitment?.shares ? String(commitment.shares) : "");
  const [lower, setLower] = useState(commitment?.lower_bound ?? true);
  const [profit, setProfit] = useState<"parent" | "ordinary">(commitment?.profit_basis ?? "parent");
  const [payout, setPayout] = useState(manual?.payout_ratio == null ? "" : String(manual.payout_ratio * 100));
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const percent = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(2)}%`;
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      const c: ForecastCommitment | null = kind === "none" ? null : { kind, value: Number(value) / (kind === "ratio" ? 100 : 1), currency,
        start_year: Number(start), end_year: Number(end), lower_bound: lower, conditions, approved: true,
        ...(kind === "ratio" ? { profit_basis: profit } : {}), ...(kind === "total" ? { shares: Number(shares) } : {}),
        evidence: { url, title: "人工补充公告", date: "" } };
      await onSave({ forecast_manual: { year, commitment: c, payout_ratio: payout === "" ? null : Number(payout) / 100 } });
      setMessage("人工参数已保存，仅用于当前用户／本机。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setSaving(false); }
  }
  async function clear() {
    setSaving(true); setError("");
    try { await onSave({ forecast_manual: null }); setMessage("已恢复自动计算"); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setSaving(false); }
  }
  const searchLabels = { not_found: "本次检索未发现可用承诺", review: "公告待人工核实", found: "已识别可用条款", failed: "公告检索失败，不代表没有承诺", partial: "正在分批核实公告" };
  return <section className={styles.basisSection} aria-label="预估年度股息率">
    <h3>{year} 财年预估股息率</h3>
    <strong>{forecast?.status === "lower_bound" ? "条件性下限 " : ""}{percent(forecast?.yield)}</strong>
    <p className={styles.hint}>全年每股预估股息 {forecast?.currency ?? currency} {forecast?.dividend == null ? "—" : forecast.dividend.toFixed(4)}。{forecast?.reason}</p>
    <p className={styles.hint}>包含同财年中期分红，不代表今天买入后未来十二个月可领取金额。</p>
    {forecast?.formula && <p className={styles.hint}>{forecast.formula}</p>}
    <p className={styles.hint}>盈利依据：{forecast?.earnings_basis === "consensus" ? "机构盈利预测" : forecast?.earnings_basis === "ttm" ? "利润 TTM" : forecast?.earnings_basis === "actual" ? "全年实际盈利" : "无需盈利或资料不足"} · 截至报告期 {forecast?.earnings_period ?? "—"}<br />
      每股收益 {forecast?.earnings_currency} {forecast?.eps == null ? "—" : forecast.eps.toFixed(4)} · 支付率 {percent(forecast?.payout_ratio)}{forecast?.payout_years.length ? `（参考 ${forecast.payout_years.join("、")} 年）` : ""}<br />
      获取时间 {forecast?.updated_at ?? "尚未获取"}{forecast?.stale && forecast.updated_at ? " · 旧快照／待刷新" : ""}</p>
    {forecast?.profit_per_share != null && forecast.basis !== "plan" && <p className={styles.hint}>归母利润每股金额 {forecast.earnings_currency} {forecast.profit_per_share.toFixed(4)}{forecast.conversion_rate != null && forecast.conversion_rate !== 1 ? ` · 原币转换至 ${forecast.currency} 的汇率 ${forecast.conversion_rate.toFixed(6)}` : ""}</p>}
    {forecast?.commitment && <p className={styles.hint}>承诺参数：{forecast.commitment.kind === "ratio" ? `${(forecast.commitment.value * 100).toFixed(2)}%（${forecast.commitment.profit_basis === "parent" ? "归母" : "普通股股东"}利润）` : `${forecast.commitment.currency} ${forecast.commitment.value}${forecast.commitment.kind === "total" ? ` ÷ ${forecast.commitment.shares ?? "待核实"} 股` : "／股"}`} · {forecast.commitment.start_year} 至 {forecast.commitment.end_year} 财年</p>}
    <button type="button" className={styles.primary} disabled={state?.loading} onClick={() => onRefresh(false)}>{state?.loading ? "正在获取预估资料…" : forecast?.search.remaining ? `继续核实公告（剩余 ${forecast.search.remaining} 项）` : "获取／重试预估"}</button>{" "}
    <button type="button" disabled={state?.loading} onClick={() => onRefresh(true)}>重新检索来源</button>
    {state?.error && <p className={styles.error} role="alert">{state.error}</p>}
    {forecast && <details><summary>计算来源与公告核验</summary>
      <p className={styles.hint}>{searchLabels[forecast.search.status]} · 检索 {forecast.search.from} 至 {forecast.search.to}</p>
      {forecast.sources.map((source, i) => <p className={styles.hint} key={`source-${i}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || "公开数据来源"}</a> · {source.date}{source.page ? ` · 第${source.page}页` : ""}{source.excerpt && <><br />{source.excerpt}</>}</p>)}
      {forecast.search.reviewed.map((source, i) => <p className={styles.hint} key={`review-${i}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> · {source.date}{source.page ? ` · 第${source.page}页` : ""}<br />{source.excerpt}</p>)}
      {[...new Set(forecast.notes)].map((note, i) => <p className={styles.hint} key={i}>{note}</p>)}
    </details>}
    <details><summary>人工补充分红承诺／参考支付率{manual ? "（已设置）" : ""}</summary>
      {manual && manual.year !== year && <p className={styles.error}>旧参数属于 {manual.year} 财年，已停止使用；保存将更新为 {year} 财年。</p>}
      <form onSubmit={save}>
        <div className={styles.basisInputs}>
          <label>承诺类型<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="none">不补充承诺</option><option value="per_share">全年每股现金股息</option><option value="total">全年现金分红总额</option><option value="ratio">利润分配比例</option></select></label>
          <label>参考支付率（%，无承诺时使用）<input type="number" min="0" max="100" step="any" value={payout} onChange={e => setPayout(e.target.value)} placeholder="留空使用历史中位数" /></label>
          {kind !== "none" && <>
            <label>{kind === "ratio" ? "承诺支付率（%）" : kind === "total" ? "全年现金分红总额（元）" : "全年每股现金股息（元）"}<input type="number" required min="0" max={kind === "ratio" ? "100" : undefined} step="any" value={value} onChange={e => setValue(e.target.value)} /></label>
            <label>币种<select value={currency} onChange={e => setCurrency(e.target.value as typeof currency)}><option value="CNY">人民币 CNY</option><option value="HKD">港币 HKD</option><option value="USD">美元 USD</option></select></label>
            <label>起始财年<input type="number" min="2000" max="2200" required value={start} onChange={e => setStart(e.target.value)} /></label>
            <label>结束财年<input type="number" min="2000" max="2200" required value={end} onChange={e => setEnd(e.target.value)} /></label>
            <label>承诺含义<select value={lower ? "lower" : "exact"} onChange={e => setLower(e.target.value === "lower")}><option value="lower">不低于／条件性下限</option><option value="exact">明确金额／比例</option></select></label>
            {kind === "ratio" && <label>比例的利润分母<select value={profit} onChange={e => setProfit(e.target.value as typeof profit)}><option value="parent">归母净利润</option><option value="ordinary">普通股股东利润</option></select></label>}
            {kind === "total" && <label>公告适用参与分红股数（股）<input type="number" required min="1" step="1" value={shares} onChange={e => setShares(e.target.value)} /></label>}
            <label>公告链接<input type="url" required maxLength={2000} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label>
            <label>适用条件<textarea value={conditions} maxLength={2000} onChange={e => setConditions(e.target.value)} /></label>
          </>}
        </div>
        <p className={styles.hint}>当前计算财年为 {year}。请核实条款已生效、利润分母及参与分红股数；人工参数不会进入公共缓存。</p>
        <button className={styles.primary} disabled={saving}>保存人工参数</button>{" "}<button type="button" disabled={saving || !manual} onClick={clear}>清除并恢复自动</button>
        {message && <p className={styles.success} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </details>
  </section>;
}
