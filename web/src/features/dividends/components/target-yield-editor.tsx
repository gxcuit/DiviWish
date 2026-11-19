import { useId, useState, type FormEvent } from "react";
import type { Stock } from "../types";
import styles from "./dashboard.module.css";

export function TargetYieldEditor({ stock, onSave }: {
  stock: Pick<Stock, "instrument_type" | "target_yield">;
  onSave: (settings: Pick<Stock, "target_yield">) => Promise<void>;
}) {
  const id = useId();
  const label = stock.instrument_type === "etf" ? "目标派息率" : "目标股息率";
  const savedValue = stock.target_yield === null ? "" : String(Number((stock.target_yield * 100).toPrecision(15)));
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const value = draft ?? savedValue;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || value === savedValue) return;

    const targetYield = value === "" ? null : Number(value) / 100;
    if (targetYield !== null && !(targetYield > 0 && targetYield <= 1)) {
      setError("请输入大于 0 且不超过 100 的百分比，或留空以清除目标。");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSave({ target_yield: targetYield });
      setDraft(null);
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <form className={styles.targetYieldForm} onSubmit={save}>
    <label htmlFor={id}>{label}（%）</label>
    <div className={styles.targetYieldControls}>
      <input id={id} type="number" inputMode="decimal" min="0" max="100" step="any" placeholder="未设置"
        value={value} disabled={saving} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setDraft(event.target.value); setSaved(false); setError(""); }} />
      <button type="submit" aria-label={`保存${label}`} disabled={saving || value === savedValue}>{saving ? "保存中…" : "保存"}</button>
    </div>
    {saved && <small role="status">{stock.target_yield === null ? "已清除" : "已保存"}</small>}
    {error && <p id={`${id}-error`} className={styles.formError} role="alert">{error}</p>}
  </form>;
}
