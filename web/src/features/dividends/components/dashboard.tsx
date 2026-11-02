"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CalendarDays, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, Circle, CirclePlus, Database, Menu, RefreshCw, Search, Settings2, Sprout, Star, UserRound, X } from "lucide-react";
import type { GridSettings, Stock, StockDetail, StockPreview, StocksResponse, YieldBasisSettings } from "../types";
import styles from "./dashboard.module.css";
import { StockAutocomplete, type StockSuggestion } from "./stock-autocomplete";
import { SectorPicker } from "./sector-picker";
import { api } from "../api";
import { calendarEvents } from "../calendar";
import { StockYieldGrid } from "./stock-yield-grid";
import { YieldBasisPicker, yieldLabels } from "./yield-basis-picker";
import { SectorManager } from "./sector-manager";
import { StockBoll } from "./stock-boll";
import { BollProvider } from "./boll-provider";
import { inferSecurityCode, resolveSecurityQuery, type SecurityIdentity } from "../security-identity";
import { EtfDividendDetails } from "./etf-dividend-details";
import { BollLegend, StockBollTags } from "./stock-boll-tags";
import { LinuxdoAccount, LinuxdoNotice } from "@/features/auth/linuxdo";
import type { Account } from "@/features/auth/types";

type View = "discovery" | "watchlist" | "income" | "calendar" | "settings";
const navigation = [
  { key: "discovery", label: "发现", icon: Circle },
  { key: "watchlist", label: "自选", icon: Star },
  { key: "income", label: "收益", icon: ChartNoAxesCombined },
  { key: "calendar", label: "日历", icon: CalendarDays },
  { key: "settings", label: "我的", icon: UserRound },
] as const;
const percent = (value: number | null, signed = false) => value === null ? "—" : `${signed && value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
const number = (value: number | null, digits = 2) => value === null ? "—" : value.toFixed(digits);
const currency = (stock: Stock) => stock.market === "HK" ? "HK$" : "¥";

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const reference = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = reference.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={reference} aria-label={title} className={styles.modal} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.modalHeader}><h2>{title}</h2><button aria-label="关闭弹窗" onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

function StockRow({ stock, onOpen, onWatch }: { stock: Stock; onOpen: (stock: Stock) => void; onWatch: (stock: Stock) => void }) {
  const bollDescriptionId = useId();
  return <div className={styles.stockRow}>
    <button className={styles.stockContent} onClick={() => onOpen(stock)} aria-label={`查看${stock.name}详情`} aria-describedby={bollDescriptionId}>
      <span className={styles.stockIdentity}><span className={styles.stockName}>{stock.name}{stock.instrument_type === "etf" && <span className={styles.marketBadge}>ETF</span>}{stock.yield_basis && stock.yield_basis !== "annual" && <span className={styles.basisBadge}>{stock.yield_basis === "rolling" ? "滚动" : "自定义"}</span>}{stock.confirmed && <span className={styles.confirmed}>确认</span>}{stock.market === "HK" && <span className={styles.marketBadge}>港</span>}</span>
        <span className={styles.stockSubtitle}><span>{stock.code}</span><span>{stock.instrument_type === "etf" ? `每份滚动分红 ¥${number(stock.rolling_dividend, 4)}` : `年度红利 ¥${number(stock.annual_dividend, 3)}`}</span><span className={stock.change_pct !== null && stock.change_pct > 0 ? styles.up : styles.down}>{percent(stock.change_pct, true)}</span></span>
        <StockBollTags key={`${stock.id}:${stock.market}:${stock.code}`} stock={stock} id={bollDescriptionId} />
      </span>
      <span className={styles.stockQuote}><strong>{currency(stock)}{number(stock.price)}</strong><span title={yieldLabels[stock.yield_basis || "annual"]} className={`${styles.yieldBadge} ${styles[stock.status]}`}>{percent(stock.selected_yield)}</span></span>
    </button>
    <button className={`${styles.starButton} ${stock.watched ? styles.watched : ""}`} onClick={() => onWatch(stock)} aria-label={`${stock.watched ? "取消自选" : "加入自选"}${stock.name}`} aria-pressed={stock.watched}><Star size={17} fill={stock.watched ? "currentColor" : "none"} /></button>
  </div>;
}

function HistoryChart({ detail }: { detail: StockDetail }) {
  const samples = detail.percentile_history.filter(sample => Number.isFinite(sample.yield));
  if (samples.length < 2) return <p className={styles.muted}>暂无可核实的历史数据</p>;
  const low = Math.min(...samples.map(sample => sample.yield));
  const high = Math.max(...samples.map(sample => sample.yield));
  const points = samples.map((sample, index) => `${8 + index / (samples.length - 1) * 464},${136 - (sample.yield - low) / (high - low || 1) * 120}`).join(" ");
  return <div className={styles.chart}>
    <div className={styles.chartLabels}><span>{percent(high)}</span><span>{detail.yield_basis === "custom" ? "当前估算每股股息 / 历史收盘价" : detail.yield_basis === "rolling" ? "当时已披露滚动年度股息 / 历史收盘价" : "当时已披露完整年度股息 / 历史收盘价"}</span></div>
    <svg viewBox="0 0 480 150" role="img" aria-label={`${detail.name}历史股息率曲线`}><path d="M 8 136 H 472 M 8 76 H 472 M 8 16 H 472" stroke="#edf0f2" fill="none" /><polyline points={points} fill="none" stroke="#e03025" strokeWidth="2" strokeLinejoin="round" /></svg>
    <div className={styles.chartLabels}><span>{samples[0].date}</span><span>{samples[samples.length - 1].date}</span></div>
  </div>;
}

function StockForm({ stock, sectors, onSave, onClose }: { stock: Stock | null; sectors: string[]; onSave: (values: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [previewNotice, setPreviewNotice] = useState("");
  const previewRequest = useRef<AbortController | null>(null);
  const [name, setName] = useState(stock?.name || "");
  const [code, setCode] = useState(stock?.code || "");
  const selectedName = useRef(stock?.name || "");
  const [market, setMarket] = useState<"A" | "HK">(stock?.market || "A");
  const [instrumentType, setInstrumentType] = useState(stock?.instrument_type || "stock");
  const [exchange, setExchange] = useState(stock?.exchange || inferSecurityCode(stock?.code || "")?.exchange || "sh");
  const [sector, setSector] = useState(stock?.sector || sectors[0] || "其他");
  const formReference = useRef<HTMLFormElement>(null);
  useEffect(() => () => previewRequest.current?.abort(), []);

  async function fetchStockData() {
    if (fetching || saving) return;
    const controller = new AbortController();
    previewRequest.current = controller;
    setFetching(true); setError(""); setPreviewNotice("");
    try {
      const identity = await identify(controller.signal);
      const result = await api<StockPreview>(`/stocks/preview?${new URLSearchParams({ market: identity.market, code: identity.code, instrument_type: identity.instrument_type || "stock", ...(identity.instrument_type === "etf" ? { exchange: identity.exchange! } : {}) })}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const fill = (field: string, value: number | string | null) => {
        const input = formReference.current?.elements.namedItem(field);
        if (input instanceof HTMLInputElement) input.value = value === null ? "" : String(value);
      };
      const notices: string[] = [];
      if (result.quote) {
        fill("price", result.quote.price);
        notices.push(`价格已填入（行情日期 ${result.quote.quote_date || "待核实"}）`);
      }
      if (result.dividends) {
        fill("annual_dividend", result.dividends.annual_dividend);
        fill("ex_dividend_date", result.dividends.ex_dividend_date);
        if (identity.instrument_type === "etf") fill("rolling_dividend", result.dividends.rolling_dividend ?? null);
        const confirmed = formReference.current?.elements.namedItem("confirmed");
        if (confirmed instanceof HTMLInputElement) confirmed.checked = result.dividends.confirmed;
        notices.push(`${result.dividends.annual_year} 年度${identity.instrument_type === "etf" ? "每份分红及滚动分红" : "每股股息"}已填入（人民币）${result.dividends.dividend_note ? "；" + result.dividends.dividend_note : ""}`);
      }
      setPreviewNotice([...notices, ...result.errors, "核对后点击保存标的，可继续手动修改。"].join("；"));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "获取失败，原值未修改");
    } finally { if (!controller.signal.aborted) setFetching(false); }
  }

  function selectStock(suggestion: SecurityIdentity) {
    selectedName.current = suggestion.name;
    if (code && (code !== suggestion.code || market !== suggestion.market || instrumentType !== (suggestion.instrument_type || "stock"))) {
      for (const field of ["price", "annual_dividend", "rolling_dividend", "target_yield", "ex_dividend_date"]) {
        const input = formReference.current?.elements.namedItem(field);
        if (input instanceof HTMLInputElement) input.value = "";
      }
      const confirmed = formReference.current?.elements.namedItem("confirmed");
      if (confirmed instanceof HTMLInputElement) confirmed.checked = false;
    }
    setName(suggestion.name);
    setCode(suggestion.code);
    setMarket(suggestion.market);
    setInstrumentType(suggestion.instrument_type || "stock");
    setExchange(suggestion.exchange || inferSecurityCode(suggestion.code)?.exchange || "sh");
    if (suggestion.sector) {
      setSector(suggestion.sector);
    }
  }
  function changeQuery(value: string) {
    if (code && value.trim() !== selectedName.current) {
      for (const field of ["price", "annual_dividend", "rolling_dividend", "ex_dividend_date"]) {
        const input = formReference.current?.elements.namedItem(field);
        if (input instanceof HTMLInputElement) input.value = "";
      }
      const confirmed = formReference.current?.elements.namedItem("confirmed");
      if (confirmed instanceof HTMLInputElement) confirmed.checked = false;
    }
    setName(value); selectedName.current = ""; setPreviewNotice(""); setError("");
    const identity = inferSecurityCode(value);
    // Clear prices and distributions only after a new identity can be identified.
    if (identity) {
      selectStock({ ...identity, name: value });
      selectedName.current = ""; // Still resolve the official name on fetch/save.
    } else { setCode(""); }
  }

  async function identify(signal?: AbortSignal): Promise<SecurityIdentity> {
    if (code && selectedName.current === name.trim()) return { name: selectedName.current, code, market, instrument_type: instrumentType, exchange };
    const query = name.trim();
    if (!query) throw new Error("请输入名称或代码");
    let suggestions: StockSuggestion[] = [];
    try { suggestions = (await api<{ suggestions: StockSuggestion[] }>(`/stocks/search?q=${encodeURIComponent(query)}`, { signal })).suggestions; }
    catch (failure) { if (signal?.aborted) throw failure; }
    const identity = resolveSecurityQuery(query, suggestions);
    if (!identity) throw new Error("请从搜索结果中选择具体标的，或输入完整的 6 位境内代码／5 位港股代码");
    selectStock(identity);
    return identity;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || fetching) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      const identity = await identify();
      await onSave({ instrument_type: identity.instrument_type || "stock", exchange: identity.instrument_type === "etf" ? identity.exchange : null, ...(identity.instrument_type === "etf" ? { rolling_dividend: !form.get("rolling_dividend") ? null : Number(form.get("rolling_dividend")) } : {}), name: identity.name, code: identity.code, market: identity.market, sector: form.get("sector"), price: form.get("price") === "" ? null : Number(form.get("price")), annual_dividend: form.get("annual_dividend") === "" ? null : Number(form.get("annual_dividend")), target_yield: form.get("target_yield") === "" ? null : Number(form.get("target_yield")) / 100, confirmed: form.get("confirmed") === "on", ex_dividend_date: form.get("ex_dividend_date") || null });
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setSaving(false); }
  }
  return <Modal title={stock ? "编辑标的" : "添加标的"} onClose={onClose}>
    <form ref={formReference} className={styles.form} onSubmit={submit}>
      <fieldset className={styles.formFields} disabled={fetching || saving}>
      <StockAutocomplete value={name} onChange={changeQuery} onSelect={suggestion => { setPreviewNotice(""); setError(""); selectStock(suggestion); }} />
      <p className={styles.muted} role="status">{code ? `已识别：${instrumentType === "etf" ? "ETF" : market === "HK" ? "港股" : "A股"} · ${code} · ${exchange === "sz" ? "深圳证券交易所" : exchange === "bj" ? "北京证券交易所" : market === "HK" ? "香港交易所" : "上海证券交易所"}` : "输入名称或代码，自动识别市场、证券类型和交易所。"}</p>
      <SectorPicker value={sector} options={sectors} onChange={setSector} />
      <button type="button" className={styles.fetchButton} onClick={fetchStockData}><RefreshCw size={16} className={fetching ? styles.spinning : undefined} />{fetching ? "正在获取价格与股息…" : "获取当前价格与股息"}</button>
      {previewNotice && <p className={styles.previewNotice} role="status">{previewNotice}</p>}
      <div className={styles.formColumns}><label>当前价格（对应市场币种）<input name="price" type="number" min="0.0001" step="any" defaultValue={stock?.price ?? ""} /></label><label>{instrumentType === "etf" ? "上一自然年每份分红（人民币）" : "年度每股股息（人民币）"}<input name="annual_dividend" type="number" min="0" step="any" defaultValue={stock?.annual_dividend ?? ""} /></label></div>
      {instrumentType === "etf" && <label>最近12个月每份分红（人民币）<input name="rolling_dividend" type="number" min="0" step="any" defaultValue={stock?.rolling_dividend ?? ""} /></label>}
      <div className={styles.formColumns}><label>目标股息率（%）<input name="target_yield" type="number" min="0.01" max="100" step="any" defaultValue={stock?.target_yield ? Number((stock.target_yield * 100).toFixed(4)) : ""} /></label><label>除息日<input name="ex_dividend_date" type="date" defaultValue={stock?.ex_dividend_date || ""} /></label></div>
      <label className={styles.checkbox}><input name="confirmed" type="checkbox" defaultChecked={stock?.confirmed} />分红已实施确认</label>
      <p className={styles.muted}>{instrumentType === "etf" ? "ETF 默认使用滚动派息率；上一自然年及最近12个月均按除息日统计。新 ETF 保存后自动获取分红明细，手工维护请在保存后编辑。" : "填写最新完整年度的每股现金股息；港股按已知汇率换算。手工输入会标记为人工维护。"}</p>
      </fieldset>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      <button className={styles.primaryButton} disabled={saving || fetching}>{saving ? "正在保存…" : "保存标的"}</button>
    </form>
  </Modal>;
}

export function Dashboard({ user, onSignOut, linuxdoEnabled }: { user: Account; linuxdoEnabled: boolean; onSignOut: () => Promise<void> }) {
  const [data, setData] = useState<StocksResponse | null>(null);
  const [view, setView] = useState<View>("discovery");
  const [sector, setSector] = useState("全部");
  const [market, setMarket] = useState("all");
  const [search, setSearch] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<StockDetail | null>(null);
  const [detailNotice, setDetailNotice] = useState("");
  const [detailRefreshError, setDetailRefreshError] = useState("");
  const [historyStates, setHistoryStates] = useState<Record<number, { loading: boolean; error: string }>>({});
  const attemptedHistories = useRef(new Set<string>());
  const forcedHistories = useRef(new Set<number>());
  const historyController = useRef<AbortController | null>(null);
  const [form, setForm] = useState<{ stock: Stock | null } | null>(null);
  const [deleting, setDeleting] = useState<Stock | null>(null);
  const [managingSectors, setManagingSectors] = useState(false);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [sort, setSort] = useState("yield");

  const load = useCallback(async () => {
    const response = await api<StocksResponse>("/stocks");
    setData(response);
    return response;
  }, []);

  useEffect(() => {
    const controller = new AbortController(); historyController.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = historyController.current;
    if (!data || !controller || controller.signal.aborted) return;
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const queue = data.stocks.filter(stock => {
      if (!forcedHistories.current.has(stock.id) && stock.history_version === (stock.instrument_type === "etf" ? 4 : 2) && stock.history_updated_at?.startsWith(today)) return false;
      const key = `${stock.id}:${stock.market}:${stock.code}:${stock.annual_dividend}:${stock.quote_date}`;
      if (attemptedHistories.current.has(key)) return false;
      attemptedHistories.current.add(key);
      return true;
    });
    async function consumeQueue() {
      while (queue.length && !controller!.signal.aborted) {
        const stock = queue.shift()!;
        setHistoryStates(current => ({ ...current, [stock.id]: { loading: true, error: "" } }));
        try {
          const force = forcedHistories.current.delete(stock.id);
          const updated = await api<StockDetail>(`/stocks/${stock.id}/history${force ? "?refresh=1" : ""}`, { method: "POST", body: "{}", signal: controller!.signal });
          if (controller!.signal.aborted) return;
          const light: Partial<StockDetail> = { ...updated }; delete light.history; delete light.percentile_history; delete light.dividends;
          setData(current => current ? { ...current, stocks: current.stocks.map(row => row.id === stock.id && row.code === stock.code && row.market === stock.market ? { ...row, ...light } : row) } : current);
          setDetail(current => current?.id === stock.id && current.code === stock.code && current.market === stock.market ? updated : current);
          attemptedHistories.current.delete(`${stock.id}:${stock.market}:${stock.code}:${stock.annual_dividend}:${stock.quote_date}`);
          setHistoryStates(current => ({ ...current, [stock.id]: { loading: false, error: "" } }));
        } catch (failure) {
          if (!controller!.signal.aborted) setHistoryStates(current => ({ ...current, [stock.id]: { loading: false, error: failure instanceof Error ? failure.message : "历史数据获取失败" } }));
        }
      }
    }
    // Two stocks at a time; successful histories remain in the account database.
    void Promise.all([consumeQueue(), consumeQueue()]);
  }, [data]);

  function retryHistory(stock: Stock) {
    forcedHistories.current.add(stock.id);
    for (const key of attemptedHistories.current) if (key.startsWith(`${stock.id}:`)) attemptedHistories.current.delete(key);
    setData(current => current ? { ...current } : current);
  }

  useEffect(() => {
    let active = true;
    api<StocksResponse>("/stocks").then(response => { if (active) setData(response); }).catch(failure => { if (active) setError(failure.message); });
    const updateView = () => {
      const selected = new URLSearchParams(window.location.search).get("view");
      setView(["watchlist", "income", "calendar", "settings"].includes(selected || "") ? selected as View : "discovery");
    };
    updateView();
    window.addEventListener("popstate", updateView);
    return () => { active = false; window.removeEventListener("popstate", updateView); };
  }, []);

  function navigate(next: View) {
    setView(next);
    setDetail(null);
    window.history.pushState(null, "", next === "discovery" ? "/discovery" : `/discovery?view=${next}`);
    window.scrollTo({ top: 0 });
  }

  async function perform(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
  }

  async function refresh(stock?: Stock) {
    if (busy) return;
    setBusy(true); setNotice(""); setError(""); setDetailNotice(""); setDetailRefreshError("");
    try {
      const result = await api<{ message: string; errors?: string[] }>(stock ? `/stocks/${stock.id}/refresh` : "/refresh", { method: "POST", body: "{}" });
      await load();
      const message = [result.message, ...(result.errors || [])].join("；");
      if (stock) {
        const updated = await api<StockDetail>(`/stocks/${stock.id}`);
        setDetail(current => current?.id === stock.id ? updated : current);
        setDetailNotice(message);
      }
      setNotice(message);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "刷新失败，原值保持不变";
      if (stock) setDetailRefreshError(message);
      else setError(message);
    } finally { setBusy(false); }
  }

  async function watch(stock: Stock) {
    await perform(async () => {
      await api(`/stocks/${stock.id}`, { method: "PATCH", body: JSON.stringify({ watched: !stock.watched }) });
      await load();
      if (detail?.id === stock.id) setDetail({ ...detail, watched: !stock.watched });
    });
  }

  async function openStock(stock: Stock) {
    setDetailNotice(""); setDetailRefreshError("");
    await perform(async () => setDetail(await api<StockDetail>(`/stocks/${stock.id}`)));
  }

  async function saveDetailSettings(settings: GridSettings | YieldBasisSettings) {
    if (!detail) return;
    const stockId = detail.id;
    await api(`/stocks/${stockId}`, { method: "PATCH", body: JSON.stringify(settings) });
    const next = await api<StockDetail>(`/stocks/${stockId}`);
    await load();
    setDetail(current => current?.id === stockId ? next : current);
  }

  const stocks = data?.stocks || [];
  const sectors = data?.sectors || [];
  const filtered = stocks.filter(stock => (market === "all" || stock.market === market) && (sector === "全部" || stock.sector === sector) && (!search || `${stock.name}${stock.code}`.includes(search.trim())) && (view !== "watchlist" || stock.watched));
  const allFiltered = stocks.filter(stock => market === "all" || stock.market === market);
  const ranked = [...allFiltered].sort((first, second) => (sort === "percentile" ? second.percentile ?? -1 : second.selected_yield ?? -1) - (sort === "percentile" ? first.percentile ?? -1 : first.selected_yield ?? -1));
  const available = allFiltered.filter(stock => stock.selected_yield !== null);
  const average = available.length ? available.reduce((total, stock) => total + (stock.selected_yield || 0), 0) / available.length : null;
  const monthPrefix = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  const events = calendarEvents(stocks, monthPrefix);
  const title = navigation.find(item => item.key === view)?.label || "发现";
  const matchingCount = filtered.length;
  const marketControls = <div className={styles.marketControls} role="group" aria-label="市场筛选">{[["all", "全部市场"], ["A", "A 股 / ETF"], ["HK", "港股"]].map(([key, label]) => <button key={key} aria-pressed={market === key} className={market === key ? styles.marketActive : ""} onClick={() => setMarket(key)}>{label}</button>)}</div>;

  return <BollProvider><main className={styles.shell}>
    <div className={styles.brand}><span className={styles.brandIcon}><Sprout size={22} aria-hidden="true" /></span><strong>DiviWish <span>息望</span></strong><small>每一笔股息都是未来的希望</small></div>
    <header className={styles.header}><div className={styles.headerActions}>
      <button aria-label="刷新行情与股息" title="刷新行情与股息" onClick={() => refresh()} disabled={busy}><RefreshCw size={18} className={busy ? styles.spinning : ""} /></button>
      <button aria-label="筛选与搜索" aria-expanded={showTools} onClick={() => setShowTools(!showTools)}><Menu size={19} /></button>
      <button className={styles.addButton} aria-label="添加标的" onClick={() => setForm({ stock: null })}><CirclePlus size={18} /></button>
    </div><h1>{title}</h1></header>

    <div className={styles.content}><LinuxdoNotice />
      {error && <div className={styles.error} role="alert"><span>{error}{!data && " 请在 web 目录运行 run.cmd 启动前后端。"}</span><button aria-label="关闭错误提示" onClick={() => setError("")}><X size={16} /></button></div>}
      {notice && <div className={styles.notice} role="status"><Check size={16} /><span>{notice}</span><button aria-label="关闭通知" onClick={() => setNotice("")}><X size={16} /></button></div>}

      {showTools && <section className={styles.tools} aria-label="筛选工具"><label className={styles.search}><Search size={17} /><input aria-label="搜索股票" placeholder="搜索股票名称或代码" value={search} onChange={event => { setSearch(event.target.value); setSector("全部"); }} /></label>{marketControls}<div className={styles.toolLinks}><button onClick={() => navigate("settings")}><Settings2 size={15} />数据与设置</button></div><p className={styles.muted}>行情日期 {data?.meta.quote_date || "待获取"} · {stocks.length} 支标的 · 手动刷新后仍以行情日期为准</p></section>}

      {(view === "discovery" || view === "watchlist") && <>
        <div className={styles.sectorBar}><div className={styles.sectors} role="group" aria-label="行业分类">{[...sectors, "全部"].map(item => <button key={item} aria-pressed={sector === item} className={sector === item ? styles.activeSector : ""} onClick={() => setSector(item)}>{item}</button>)}</div><button className={styles.sectorManageButton} aria-label="板块管理" onClick={() => setManagingSectors(true)}><Settings2 size={15} />管理</button></div>
        {!data && !error ? <div className={styles.empty}><RefreshCw className={styles.spinning} size={22} /><p>正在读取股息数据…</p></div> : matchingCount > 0 ? <><section className={styles.stockList} aria-label="股票列表">{filtered.map(stock => <StockRow key={stock.id} stock={stock} onOpen={openStock} onWatch={watch} />)}</section><BollLegend /></> : <div className={styles.empty}><Star size={30} /><h2>{view === "watchlist" ? "这里还没有自选股票" : "没有符合条件的股票"}</h2><p>{view === "watchlist" ? "在发现页点击星标，把关注的股息收入留在这里。" : "换一个板块或清除筛选试试。"}</p><button className={styles.primaryButton} onClick={() => { setSector("全部"); setSearch(""); setMarket("all"); if (view === "watchlist") navigate("discovery"); }}>查看全部股票</button></div>}
      </>}


      {view === "income" && <>{marketControls}<div className={styles.summaryCards}><div><span>平均选用股息率</span><strong>{percent(average)}</strong><small>{available.length} 支有有效数据的标的</small></div><div><span>达到目标</span><strong>{allFiltered.filter(stock => stock.status === "green").length}<small> 支</small></strong><small>按你设定的目标股息率</small></div><div><span>自选标的</span><strong>{stocks.filter(stock => stock.watched).length}<small> 支</small></strong><small>保存在当前账号</small></div></div><div className={styles.sectionHeading}><h2>股息率排行</h2><select aria-label="排行排序" value={sort} onChange={event => setSort(event.target.value)}><option value="yield">按选用股息率</option><option value="percentile">按历史分位</option></select></div><section className={styles.panel}>{ranked.map((stock, index) => <button className={styles.rankRow} key={stock.id} onClick={() => openStock(stock)}><span className={styles.rankNumber}>{index + 1}</span><span className={styles.rankIdentity}><strong>{stock.name}</strong><small>{stock.instrument_type === "etf" ? "ETF" : stock.market === "HK" ? "港股" : "A股"} · {stock.sector}</small></span><span><strong>{percent(stock.selected_yield)}</strong><small>{stock.instrument_type === "etf" ? `${stock.yield_basis === "annual" ? "年度" : stock.yield_basis === "custom" ? "自定义估算" : "滚动"}派息率历史分位 ${percent(stock.percentile)}` : `${yieldLabels[stock.yield_basis || "annual"]}历史分位 ${percent(stock.percentile)}`}</small></span><ChevronRight size={15} /></button>)}</section><h2 className={styles.subheading}>A/H 股息对比</h2><div className={styles.tableWrap}><table className={styles.gridTable}><thead><tr><th>港股标的</th><th>税前股息率</th><th>港户口径</th><th>港股通口径</th><th>A/H 溢价</th></tr></thead><tbody>{stocks.filter(stock => stock.market === "HK").map(stock => <tr key={stock.id}><th>{stock.name}</th><td>{percent(stock.dividend_yield)}</td><td>{percent(stock.hk_net_yield)}</td><td>{percent(stock.connect_yield)}</td><td>{percent(stock.ah_premium)}</td></tr>)}</tbody></table></div><p className={styles.muted}>A/H 对比固定使用年度股息率，沿用表格中的税后折算系数和汇率，不代表个人实际税负；本页不估算未录入的持仓收益。</p></>}

      {view === "calendar" && <><div className={styles.calendarHeading}><button aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={20} /></button><h2>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h2><button aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={20} /></button></div><section className={styles.calendar}><div className={styles.calendarWeek}>{["日", "一", "二", "三", "四", "五", "六"].map(day => <span key={day}>{day}</span>)}</div><div className={styles.calendarDays}>{Array.from({ length: month.getDay() }, (_, index) => <span key={`pad-${index}`} />)}{Array.from({ length: new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate() }, (_, index) => { const day = index + 1; const dayEvents = events.filter(stock => Number(stock.ex_dividend_date?.slice(8)) === day); return <div className={`${styles.calendarDay} ${dayEvents.length ? styles.eventDay : ""}`} key={day}><span>{day}</span>{dayEvents.length > 0 && <button aria-label={`${day}日${dayEvents.length}笔除息`} onClick={() => openStock(dayEvents[0])}>{dayEvents.length} 笔除息</button>}</div>; })}</div></section><div className={styles.sectionHeading}><h2>本月除息</h2><span>{events.length} 笔</span></div><section className={styles.panel}>{events.length ? events.map(stock => <button className={styles.eventRow} key={`${stock.id}:${stock.ex_dividend_date}`} onClick={() => openStock(stock)}><span className={styles.eventDate}>{stock.ex_dividend_date?.slice(5)}</span><span><strong>{stock.name}</strong><small>{stock.code} · {stock.instrument_type === "etf" ? "ETF" : stock.market === "HK" ? "港股" : "A股"}</small></span><span className={styles.eventYield}>{percent(stock.selected_yield)}<ChevronRight size={15} /></span></button>) : <div className={styles.empty}><CalendarDays size={28} /><p>本月暂无已记录的除息日</p><small>仅展示已导入或已核实的日期，不推测未来排期。</small></div>}</section><button className={styles.textButton} onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>回到本月</button></>}

      {view === "settings" && <><section className={styles.profile}><div><UserRound size={27} /></div><h2>我的股息观察</h2><p>慢慢积累，让时间带来回报</p><span>{user.email || `LinuxDO · ${user.linuxdoUsername}`}</span>{user.email && <a className={styles.textButton} href="/reset-password">修改登录密码</a>}<LinuxdoAccount user={user} enabled={linuxdoEnabled} /><button className={styles.textButton} onClick={() => perform(onSignOut)}>退出登录</button></section><section className={styles.panel}><div className={styles.settingsRow}><Database size={20} /><span><strong>股票数据库</strong></span><span>{stocks.filter(stock => stock.watched).length} 支自选</span></div><button className={styles.settingsRow} disabled={busy} onClick={() => refresh()}><RefreshCw size={20} /><span><strong>刷新行情、股息与汇率</strong><small>{busy ? "正在更新，请稍候…" : `行情日期 ${data?.meta.quote_date || "待获取"}`}</small></span><ChevronRight size={17} /></button></section><section className={styles.explanation}><h3>数据与计算口径</h3><p>境内 ETF 默认采用滚动12个月已除息分红 ÷ 当前场内价格；年度采用上一自然年。待除息分红仅列入明细和日历。ETF 历史分位及对应价格跟随所选口径，至少60个有效样本；年度采用各历史日上一完整自然年派息。滚动窗口可能受年度派息日期变化影响，出现重叠或空档。</p><p>年度股息率 = 最新已披露完整年度每股现金股息 ÷ 当前价格。滚动年度沿用最近报告期向前一年的分红合计。</p><p>历史分位跟随各股票已保存的股息率口径，为近五年有效日该口径股息率 ≤ 当前选用股息率的比例；年度与滚动年度按当时已披露分红计算，公告后下一交易日生效。自定义以当前价格 × 自定义股息率估算每股股息，再除以历史收盘价，不代表历史实际分红。</p><p>🟢 达到目标；🔵 差目标不超过 0.25 个百分点；🟠 差目标不超过 0.30 个百分点；其余为普通观察。</p><p>导入时间：{data?.meta.imported_at || "—"}<br />最近行情刷新：{data?.meta.last_refresh || "尚未刷新"}<br />HKD → CNY：{number(data?.meta.fx_rate ?? null, 4)}</p><p>刷新获取价格、汇率及已披露完整年度和滚动股息。单项失败保留原值并提示；也可在个股编辑中人工维护。</p></section></>}

      <footer className={styles.disclaimer}>数据基于历史公开信息，不构成投资建议。<br />请在充分了解风险的基础上进行投资决策。{data?.meta.quote_date && <span>行情日期 {data.meta.quote_date} · 来源：已保存的个人数据</span>}</footer>
    </div>

    <nav className={styles.navigation} aria-label="主要导航">{navigation.map(item => <button key={item.key} className={view === item.key ? styles.activeNav : ""} onClick={() => navigate(item.key)} aria-current={view === item.key ? "page" : undefined}><item.icon size={21} fill={item.key === "discovery" ? "currentColor" : "none"} strokeWidth={item.key === "discovery" ? 0 : 1.7} /><span>{item.label}</span></button>)}</nav>

    {detail && !form && <Modal title={detail.name} onClose={() => setDetail(null)}><div className={styles.detailBody}><div className={styles.detailCode}>{detail.code} · {detail.market === "HK" ? "港股 / HKD" : detail.instrument_type === "etf" ? "ETF / CNY" : "A股 / CNY"} · {detail.sector}<button onClick={() => watch(detail)}><Star size={17} fill={detail.watched ? "currentColor" : "none"} />{detail.watched ? "已自选" : "加入自选"}</button></div><div className={styles.detailPrice}><strong>{currency(detail)}{number(detail.price)}</strong><span className={detail.change_pct !== null && detail.change_pct > 0 ? styles.up : styles.down}>{percent(detail.change_pct, true)}</span><small>行情日期 {detail.quote_date || "待核实"}</small></div><button className={styles.fetchButton} disabled={busy} onClick={() => refresh(detail)}><RefreshCw size={16} className={busy ? styles.spinning : undefined} />{busy ? "正在刷新行情与股息…" : "刷新行情与股息"}</button>{detail.annual_dividend === null && !detailRefreshError && <p className={styles.muted}>这支股票尚未保存股息数据，点击上方按钮获取并保存。</p>}{detailNotice && <p className={styles.previewNotice} role="status">{detailNotice}</p>}{detailRefreshError && <p className={styles.formError} role="alert">{detailRefreshError}</p>}<StockBoll key={`boll-${detail.id}-${detail.market}-${detail.code}`} stock={detail} /><YieldBasisPicker key={`basis-${detail.id}`} stock={detail} onSave={saveDetailSettings} /><StockYieldGrid key={detail.id} stock={detail} onSave={saveDetailSettings} />{detail.instrument_type === "etf" ? <EtfDividendDetails stock={detail} historyState={historyStates[detail.id]} onRetry={() => retryHistory(detail)} /> : <><div className={styles.detailMetrics}><div><span>年度股息率</span><strong>{percent(detail.dividend_yield)}</strong><small className={styles.metricNote}>最新已披露完整财年各期每股现金股息合计 ÷ 当前股价。</small></div><div><span>滚动年度股息率</span><strong>{percent(detail.rolling_yield)}</strong><small className={styles.metricNote}>以最近报告期为终点，向前一年内各期已公告或已实施每股现金分红合计 ÷ 当前股价；按报告期统计，不按支付日期。</small></div><div><span>目标股息率</span><strong>{percent(detail.target_yield)}</strong></div><div><span>目标价格（选用口径）</span><strong>{currency(detail)}{number(detail.target_price)}</strong></div><div><span>年度每股股息（RMB）</span><strong>¥{number(detail.annual_dividend, 3)}</strong></div><div><span>年内涨跌</span><strong className={detail.year_change !== null && detail.year_change > 0 ? styles.up : detail.year_change !== null && detail.year_change < 0 ? styles.down : undefined}>{percent(detail.year_change, true)}</strong><small className={styles.metricNote}>{detail.year_change === null ? "缺少上年末价格基准，请刷新行情与股息；新上市或停牌股票可能无基准。" : detail.year_start_date ? `相对 ${detail.year_start_date} 收盘价（${detail.year_start_adjustment === "qfq" ? "前复权" : "不复权"}），不含现金分红再投资。` : "按已保存的年初价格计算。"}</small></div><div><span>股息支付率（年度）</span><strong>{percent(detail.payout_ratio ?? null)}</strong><small className={styles.metricNote}>{detail.payout_note || "缺少同财年每股收益，请刷新行情与股息。"}</small></div></div><p className={styles.muted}>两种股息合计相同时，股息率也会相同。港股两者均先按汇率换算股息与股价的币种。</p><div className={styles.detailNote}>{detail.confirmed ? "分红已实施确认" : "分红实施尚待确认"} · 股息所属年度 {detail.annual_year || "待核实"}<br />最近除息日 {detail.ex_dividend_date || "暂无已核实日期"}</div>{detail.verification_note && <p className={styles.formError}>{detail.verification_note}</p>}<h3>近五年{yieldLabels[detail.yield_basis || "annual"]}分位 <strong className={styles.red}>{percent(detail.percentile)}</strong></h3>{historyStates[detail.id]?.loading && <p className={styles.muted} role="status">正在自动获取历史数据并计算分位…</p>}{historyStates[detail.id]?.error && <p className={styles.formError} role="alert">{historyStates[detail.id].error}<button className={styles.historyRetry} onClick={() => retryHistory(detail)}>重试</button></p>}{(!historyStates[detail.id]?.loading || detail.history.length > 0) && <HistoryChart detail={detail} />}<p className={styles.muted}>有效样本 {detail.percentile_count} 日 · 截至 {detail.percentile_end || "—"}<br />历史分位、曲线与对应价格采用已保存的{yieldLabels[detail.yield_basis || "annual"]}。{detail.yield_basis === "custom" ? "以当前价格 × 自定义股息率估算每股股息，再除以历史收盘价；属于估算回溯，不代表历史实际分红，报价变化后会重新计算。" : detail.yield_basis === "rolling" ? "历史各日以当时最新已披露报告期为终点，向前一年内的分红合计除以当日收盘价；缺少滚动历史时不使用年度数据代替。" : "历史各日使用当时已披露的完整年度股息除以当日收盘价。"}</p>{detail.history_note && <p className={styles.muted}>{detail.history_note}</p>}<div className={styles.detailMetrics}><div><span>60 分位{yieldLabels[detail.yield_basis || "annual"]} / 对应价格</span><strong>{percent(detail.quantile_60_yield)} / {detail.quantile_60_price === null ? "—" : `${currency(detail)}${number(detail.quantile_60_price)}`}</strong></div><div><span>90 分位{yieldLabels[detail.yield_basis || "annual"]} / 对应价格</span><strong>{percent(detail.quantile_90_yield)} / {detail.quantile_90_price === null ? "—" : `${currency(detail)}${number(detail.quantile_90_price)}`}</strong></div></div><h3>年度分红明细</h3>{detail.dividends.length > 0 ? <div className={styles.dividendParts}>{detail.dividends.map((part, index) => <div key={`${part.period}-${index}`}><span>{part.period}<small>{part.status}</small></span><strong>¥{number(part.dps, 3)}</strong></div>)}</div> : <p className={styles.muted}>暂无可核实的分笔明细</p>}<p className={styles.muted}>数据来源：{detail.source}</p></>}<div className={styles.detailButtons}><button onClick={() => setForm({ stock: detail })}>编辑标的</button><button className={styles.dangerButton} onClick={() => { setDeleting(detail); setDetail(null); }}>删除标的</button></div></div></Modal>}

    {managingSectors && <Modal title="板块管理" onClose={() => setManagingSectors(false)}><SectorManager onChange={async () => { const next = await load(); setSector(current => current === "全部" || next.sectors.includes(current) ? current : "全部"); }} /></Modal>}
    {form && <StockForm stock={form.stock} sectors={sectors} onClose={() => setForm(null)} onSave={async values => { const saved = await api<Stock>(form.stock ? `/stocks/${form.stock.id}` : "/stocks", { method: form.stock ? "PATCH" : "POST", body: JSON.stringify(values) });
      let message = "标的已保存";
      if (!form.stock && saved.instrument_type === "etf") {
        try {
          const result = await api<{ message: string; errors: string[] }>(`/stocks/${saved.id}/refresh`, { method: "POST", body: "{}" });
          message = [message, result.message, ...result.errors].join("；");
        } catch { message += "；ETF 自动刷新暂未完成，请打开详情重试"; }
      }
      await load(); setDetail(null); setNotice(message); }} />}
    {deleting && <Modal title="删除股票" onClose={() => setDeleting(null)}><div className={styles.detailBody}><p>确定从当前账号删除「{deleting.name}」？删除后无法恢复。</p><div className={styles.detailButtons}><button onClick={() => setDeleting(null)}>取消</button><button className={styles.dangerButton} onClick={() => perform(async () => { await api(`/stocks/${deleting.id}`, { method: "DELETE" }); await load(); setDeleting(null); setNotice("股票已删除"); })}>确认删除</button></div></div></Modal>}
  </main></BollProvider>;
}
