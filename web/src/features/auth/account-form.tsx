"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, RefreshCw, ShieldCheck, Sprout } from "lucide-react";
import { api } from "@/features/dividends/api";
import { LinuxdoNotice } from "./linuxdo";
import { Turnstile } from "./turnstile";
import type { Account, AuthConfig } from "./types";
import styles from "./auth.module.css";

export type AuthScreen = "login" | "register" | "reset" | "setup";

function PasswordField({ label, value, onChange, confirm = false, creating = false, disabled }: {
  label: string; value: string; onChange: (value: string) => void; confirm?: boolean; creating?: boolean; disabled: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return <label className={styles.label}>{label}<span className={styles.inputWrap}><LockKeyhole size={18} />
    <input type={visible ? "text" : "password"} aria-label={label} autoComplete={creating ? "new-password" : "current-password"}
      placeholder={creating ? confirm ? "再次输入密码" : "至少 7 个字符" : "输入登录密码"} value={value} required disabled={disabled}
      onChange={event => onChange(event.target.value)} />
    <button type="button" className={styles.visibility} aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
  </span></label>;
}

export function AccountForm({ screen, config, initialEmail = "", onSignedIn, onSignOut }: {
  screen: AuthScreen; config: AuthConfig; initialEmail?: string; onSignedIn: (user: Account) => void; onSignOut?: () => Promise<void>;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [widgetVersion, setWidgetVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remaining, setRemaining] = useState(0);
  const login = screen === "login", registering = screen === "register", settingUp = screen === "setup";
  const purpose = registering ? "register" : "reset_password";
  const title = login ? "登录息望" : registering ? "创建你的息望账号" : settingUp ? "设置你的登录密码" : "重置登录密码";
  const subtitle = login ? "用邮箱和密码，继续你的股息观察。" : registering ? "创建密码并验证邮箱，开启你的股息观察。" : settingUp ? "你的账号已通过邮箱验证。请再次验证邮箱并设置密码，原有数据会继续保留。" : "验证邮箱后设置新密码，其他设备的登录会同时退出。";
  useEffect(() => {
    if (!remaining) return;
    const timer = setTimeout(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  function validNewPassword() {
    if ([...password].length <= 6) {
      setError("密码需要大于 6 个字符"); return false;
    }
    if (password !== confirmation) { setError("两次输入的密码不一致"); return false; }
    return true;
  }
  function resetChallenge() { setToken(""); setWidgetVersion(value => value + 1); }
  async function sendCode() {
    if (busy || remaining || !validNewPassword()) return;
    const mailbox = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox)) { setError("请先填写有效邮箱"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ challengeId: string; retryAfter: number; message: string }>("/auth/send-code", {
        method: "POST", body: JSON.stringify({ email: mailbox, purpose, turnstileToken: token }),
      });
      setChallengeId(result.challengeId); setCode(""); setRemaining(result.retryAfter); setNotice(result.message);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "发送失败，请重试"); }
    finally { setBusy(false); resetChallenge(); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!login && !validNewPassword()) return;
    if (!login && !challengeId) { setError("请先获取邮箱验证码"); return; }
    setBusy(true); setError("");
    try {
      const endpoint = login ? "/auth/login" : registering ? "/auth/register" : "/auth/reset-password";
      const result = await api<{ user: Account }>(endpoint, { method: "POST", body: JSON.stringify({ email, password,
        ...(login ? { turnstileToken: token } : { code, challengeId }),
      }) });
      setPassword(""); setConfirmation(""); onSignedIn(result.user);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试"); }
    finally { setBusy(false); if (login) resetChallenge(); }
  }
  return <main className={styles.page}><div className={styles.decoration} aria-hidden="true"><Sprout /></div>
    <Link href="/login" className={styles.brand}><Sprout size={25} /><span>DiviWish · 息望</span></Link>
    <section className={styles.card} aria-label={title}>
      {(login || registering) && <nav className={styles.tabs} aria-label="账号入口"><Link href="/login" aria-current={login ? "page" : undefined}>登录</Link><Link href="/register" aria-current={registering ? "page" : undefined}>注册</Link></nav>}
      <span className={styles.eyebrow}>每一笔股息，都是未来的希望</span><h1>{title}</h1><p className={styles.subtitle}>{subtitle}</p>
      <LinuxdoNotice />
      <form onSubmit={submit} className={styles.form}>
        <label className={styles.label}>邮箱地址<span className={styles.inputWrap}><Mail size={18} /><input type="email" aria-label="邮箱地址" autoComplete="username" placeholder="你的邮箱地址" value={email} maxLength={254} required autoFocus={!settingUp} readOnly={settingUp} disabled={busy}
          onChange={event => { setEmail(event.target.value); setChallengeId(null); setCode(""); setNotice(""); setRemaining(0); }} /></span></label>
        <PasswordField label={login ? "登录密码" : "新密码"} value={password} onChange={setPassword} creating={!login} disabled={busy} />
        {!login && <><PasswordField label="确认密码" value={confirmation} onChange={setConfirmation} creating confirm disabled={busy} /><p className={styles.passwordHelp}>密码大于 6 个字符即可，不要求字符组合。</p></>}
        {config.turnstileSiteKey && (login || !remaining) && <div className={styles.challenge}><Turnstile key={widgetVersion} siteKey={config.turnstileSiteKey} action={login ? "password_login" : "send_otp"} onToken={setToken} onError={setError} /></div>}
        {!login && <label className={styles.label}>邮箱验证码<span className={styles.codeRow}><input aria-label="邮箱验证码" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" placeholder="6 位验证码" maxLength={6} required value={code} disabled={busy || !challengeId} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />
          <button type="button" disabled={busy || remaining > 0 || (Boolean(config.turnstileSiteKey) && !token)} onClick={sendCode}>{remaining ? `${remaining} 秒后重发` : challengeId ? "重新发送" : "获取验证码"}</button></span></label>}
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
        <button type="submit" className={styles.primary} disabled={busy || (login ? Boolean(config.turnstileSiteKey) && !token : !challengeId)}>{busy ? <><RefreshCw size={18} className={styles.spinning} />正在处理…</> : <>{login ? "登录" : registering ? "验证邮箱并注册" : "验证并设置密码"}<ArrowRight size={18} /></>}</button>
      </form>
      {(login || registering) && config.linuxdoEnabled && <div className={styles.socialLogin}><span>或</span><a href="/api/auth/linuxdo/start" aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}><span className={styles.linuxdoMark} aria-hidden="true" />使用 LinuxDO 登录</a><p>首次授权将创建账号；已有账号可登录后在“我的”绑定。</p></div>}
      <div className={styles.formLinks}>{login ? <><Link href="/reset-password">忘记密码</Link><Link href="/register">创建账号</Link></> : settingUp && onSignOut ? <button type="button" disabled={busy} onClick={async () => { try { await onSignOut(); } catch (failure) { setError(failure instanceof Error ? failure.message : "退出失败"); } }}>退出并切换账号</button> : <Link href="/login">已有账号？返回登录</Link>}</div>
      <div className={styles.assurance}><ShieldCheck size={17} /><span>数据保存在你的账号中，仅本人登录后可访问。</span></div>
      {config.emailMode === "console" && !login && <p className={styles.local}>本机测试模式：验证码显示在后端终端中。</p>}
    </section><p className={styles.footer}>慢慢积累，让时间带来回报。</p>
  </main>;
}
