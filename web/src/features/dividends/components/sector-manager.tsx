"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import styles from "./stock-tools.module.css";

interface SectorRecord { id: number; name: string; stock_count: number; protected: boolean; }

export function SectorManager({ onChange }: { onChange: () => Promise<void> }) {
  const [sectors, setSectors] = useState<SectorRecord[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SectorRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await api<{ sectors: SectorRecord[] }>("/sectors");
    setSectors(response.sectors);
  }, []);

  useEffect(() => {
    let current = true;
    api<{ sectors: SectorRecord[] }>("/sectors").then(response => { if (current) setSectors(response.sectors); }).catch(failure => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, []);

  async function change(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try { await action(); await load(); await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change(async () => { await api("/sectors", { method: "POST", body: JSON.stringify({ name }) }); setName(""); setMessage("板块已新增"); });
  }

  return <div className={styles.manager}>
    <p className={styles.hint}>管理现有板块，删除板块会将股票移到“未分类”，不会删除股票、自选或个股网格设置。</p>
    <form className={styles.addSector} onSubmit={add}><label>新增板块<input required maxLength={30} placeholder="输入板块名称" value={name} onChange={event => setName(event.target.value)} /></label><button className={styles.primary} disabled={busy}>新增</button></form>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {message && <p className={styles.success} role="status">{message}</p>}
    <ul className={styles.sectorList}>{sectors.map(sector => <li key={sector.id}>
      {editing?.id === sector.id ? <form className={styles.renameSector} onSubmit={event => {
        event.preventDefault();
        void change(async () => { await api(`/sectors/${sector.id}`, { method: "PATCH", body: JSON.stringify({ name: editing.name }) }); setEditing(null); setMessage("板块已重命名"); });
      }}><label>板块新名称<input required maxLength={30} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label><div className={styles.rowActions}><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className={styles.primary} disabled={busy}>保存</button></div></form>
        : <><span><strong>{sector.name}</strong><small>{sector.stock_count} 支股票{sector.protected ? " · 默认归类" : ""}</small></span>{!sector.protected && <div className={styles.rowActions}><button aria-label={`重命名${sector.name}板块`} disabled={busy} onClick={() => { setEditing({ id: sector.id, name: sector.name }); setDeleting(null); }}>编辑</button><button className={styles.danger} aria-label={`删除${sector.name}板块`} disabled={busy} onClick={() => { setDeleting(sector); setEditing(null); }}>删除</button></div>}</>}
    </li>)}</ul>
    {deleting && <section className={styles.confirmDelete} aria-label="确认删除板块"><p>删除“{deleting.name}”板块？其中 {deleting.stock_count} 支股票将保留在“未分类”。</p><div className={styles.rowActions}><button disabled={busy} onClick={() => setDeleting(null)}>取消删除</button><button className={styles.danger} disabled={busy} onClick={() => void change(async () => { const response = await api<{ message: string }>(`/sectors/${deleting.id}`, { method: "DELETE" }); setDeleting(null); setMessage(response.message); })}>确认删除板块</button></div></section>}
  </div>;
}
