"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../api";
import { BollStore, bollKey, EMPTY_BOLL } from "../boll-store";
import type { BollResponse, Stock } from "../types";

const Context = createContext<BollStore | null>(null);

export function BollProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new BollStore((stock, signal, force) =>
    api<BollResponse>(`/stocks/${stock.id}/boll${force ? "?refresh=1" : ""}`, { signal })));
  useEffect(() => () => store.reset(), [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useBoll(stock: Stock, enabled = true) {
  const store = useContext(Context);
  if (!store) throw new Error("BOLL 数据须在看板内读取");
  const key = bollKey(stock);
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key]);
  const snapshot = useCallback(() => store.get(key), [store, key]);
  const state = useSyncExternalStore(subscribe, snapshot, () => EMPTY_BOLL);
  useEffect(() => {
    if (!enabled) return;
    const load = () => { if (document.visibilityState === "visible") void store.fetch(stock); };
    load();
    const timer = setInterval(load, 300_000);
    document.addEventListener("visibilitychange", load);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [store, stock, enabled]);
  const refresh = useCallback(() => store.fetch(stock, true), [store, stock]);
  return { ...state, refresh };
}
