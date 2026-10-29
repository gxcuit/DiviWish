"use client";

import { useState, useSyncExternalStore } from "react";
import { api } from "@/features/dividends/api";
import type { Account } from "./types";
import styles from "./auth.module.css";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const snapshot = () => window.location.search;
const serverSnapshot = () => "";

export function LinuxdoNotice() {
  const query = new URLSearchParams(useSyncExternalStore(subscribe, snapshot, serverSnapshot));
  const error = query.get("auth_error");
  if (error) return <p role="alert" className={styles.error}>{error.slice(0, 200)}</p>;
  return query.get("linuxdo") === "linked" ? <p role="status" className={styles.notice}>LinuxDO 绑定成功，下次可以直接使用 LinuxDO 登录。</p> : null;
}

export function LinuxdoAccount({ user, enabled }: { user: Account; enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function link() {
    setBusy(true); setError("");
    try {
      const result = await api<{ url: string }>("/auth/linuxdo/link", { method: "POST", body: "{}" });
      window.location.assign(result.url);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法绑定 LinuxDO"); setBusy(false); }
  }
  return <div className={styles.linuxdoAccount}>
    {user.linuxdoUsername ? <p>已绑定 LinuxDO：{user.linuxdoUsername}</p> : enabled && <><button type="button" className={styles.linuxdoLink} disabled={busy} onClick={link}><span className={styles.linuxdoMark} aria-hidden="true" />{busy ? "正在前往 LinuxDO…" : "绑定 LinuxDO"}</button><p>绑定后，两种登录方式共用当前账号的数据。</p></>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </div>;
}
