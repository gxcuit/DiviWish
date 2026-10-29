"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

type TurnstileApi = {
  render(container: HTMLElement, options: { sitekey: string; action: string; theme: string; callback: (token: string) => void;
    "expired-callback": () => void; "error-callback": () => void }): string;
  remove(widgetId: string): void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

export function Turnstile({ siteKey, onToken, onError, action = "send_otp" }: { siteKey: string; action?: "send_otp" | "password_login"; onToken: (token: string) => void; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  useEffect(() => { callbacks.current = { onToken, onError }; }, [onToken, onError]);
  const [ready, setReady] = useState(false);
  const loaded = useCallback(() => setReady(true), []);
  useEffect(() => {
    if (!ready || !container.current || !window.turnstile) return;
    const api = window.turnstile;
    const id = api.render(container.current, { sitekey: siteKey, action, theme: "light",
      callback: token => callbacks.current.onToken(token),
      "expired-callback": () => callbacks.current.onToken(""),
      "error-callback": () => { callbacks.current.onToken(""); callbacks.current.onError("人机验证加载失败，请刷新后重试"); },
    });
    return () => api.remove(id);
  }, [ready, siteKey, action]);
  return <><Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onReady={loaded}
    onError={() => onError("人机验证加载失败，请检查网络后重试")} /><div ref={container} aria-label="人机验证" /></>;
}
