"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sprout } from "lucide-react";
import { api, AUTH_EXPIRED_EVENT } from "@/features/dividends/api";
import { Dashboard } from "@/features/dividends/components/dashboard";
import { AccountForm, type AuthScreen } from "./account-form";
import type { Account, AuthConfig } from "./types";
import styles from "./auth.module.css";

export function AuthGate({ screen = "app" }: { screen?: "app" | Exclude<AuthScreen, "setup"> }) {
  const router = useRouter();
  const [user, setUser] = useState<Account | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api<{ user: Account | null }>("/auth/session", { signal: controller.signal }), api<AuthConfig>("/auth/config", { signal: controller.signal })])
      .then(([session, options]) => { if (!controller.signal.aborted) { setUser(session.user); setConfig(options); setError(""); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法连接服务"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, []);
  useEffect(() => {
    if (loading || error || !config) return;
    if (!user && screen === "app") router.replace("/login");
    else if (user && (screen === "login" || screen === "register")) router.replace("/discovery");
  }, [loading, error, config, user, screen, router]);
  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST", body: "{}" });
    setUser(null); router.replace("/login");
  }, [router]);
  function signedIn(account: Account) { setUser(account); router.replace("/discovery"); }
  if (loading || (!user && screen === "app" && !error) || (user && (screen === "login" || screen === "register"))) return <main className={styles.page}><div className={styles.loading} role="status"><Sprout size={30} /><p>正在连接你的息望…</p></div></main>;
  if (error || !config) return <main className={styles.page}><section className={styles.card}><h1>暂时无法连接息望</h1><p role="alert">{error || "请检查本地服务是否已启动"}</p><button className={styles.primary} onClick={() => { setLoading(true); setRetry(value => value + 1); }}>重新连接</button></section></main>;
  if (screen === "reset") return <AccountForm key={`reset-${user?.id || "guest"}`} screen="reset" config={config} initialEmail={user?.email ?? undefined} onSignedIn={signedIn} />;
  if (user && !user.hasPassword && !user.linuxdoUsername) return <AccountForm key={user.id} screen="setup" config={config} initialEmail={user.email ?? undefined} onSignedIn={signedIn} onSignOut={signOut} />;
  return user ? <Dashboard key={user.id} user={user} linuxdoEnabled={config.linuxdoEnabled} onSignOut={signOut} /> : <AccountForm key={screen} screen={screen === "register" ? "register" : "login"} config={config} onSignedIn={signedIn} />;
}
