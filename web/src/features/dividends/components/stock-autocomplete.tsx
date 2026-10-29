"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import styles from "./stock-autocomplete.module.css";

export interface StockSuggestion {
  name: string;
  code: string;
  market: "A" | "HK";
  sector: string | null;
  existing: boolean;
}

interface SearchResult {
  query: string;
  suggestions: StockSuggestion[];
  message: string | null;
  loading: boolean;
}

export function StockAutocomplete({ value, onChange, onSelect }: {
  value: string;
  onChange: (name: string) => void;
  onSelect: (suggestion: StockSuggestion) => void;
}) {
  const identity = useId();
  const inputId = `${identity}-name`;
  const listId = `${identity}-suggestions`;
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [result, setResult] = useState<SearchResult>({ query: "", suggestions: [], message: null, loading: false });
  const query = value.trim();
  const open = focused && query.length > 0;
  const suggestions = result.query === query ? result.suggestions : [];
  const loading = composing || result.query !== query || result.loading;
  const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined;

  useEffect(() => {
    if (!focused || !query || composing) return;
    const controller = new AbortController();
    let current = true;
    const timer = window.setTimeout(async () => {
      setResult({ query, suggestions: [], message: null, loading: true });
      try {
        const response = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "搜索暂不可用");
        if (current) setResult({ query, suggestions: data.suggestions, message: data.message, loading: false });
      } catch {
        if (current) setResult({ query, suggestions: [], message: "股票搜索暂不可用，可继续手动填写。", loading: false });
      }
    }, 300);
    return () => { current = false; window.clearTimeout(timer); controller.abort(); };
  }, [query, focused, composing]);

  useEffect(() => {
    if (open && activeSuggestion) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeSuggestion, activeIndex, listId]);

  function choose(suggestion: StockSuggestion) {
    onSelect(suggestion);
    setFocused(false);
    setActiveIndex(-1);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setFocused(true);
      if (suggestions.length) setActiveIndex(index => event.key === "ArrowDown" ? (index + 1) % suggestions.length : index <= 0 ? suggestions.length - 1 : index - 1);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (activeSuggestion) choose(activeSuggestion);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setFocused(false);
    }
  }

  return <div className={styles.root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }}>
    <label htmlFor={inputId}>股票名称</label>
    <input id={inputId} name="name" role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={listId} aria-activedescendant={open && activeSuggestion ? `${listId}-${activeIndex}` : undefined}
      required maxLength={40} autoComplete="off" value={value} placeholder="输入名称或代码，如：中国神华"
      onFocus={() => setFocused(true)} onClick={() => { setFocused(true); setActiveIndex(-1); }}
      onChange={event => { onChange(event.target.value); setFocused(true); setActiveIndex(-1); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={handleKey} />
    {open && <div className={styles.dropdown}>
      <div id={listId} role="listbox" aria-label="匹配股票" aria-busy={loading} className={styles.list}>
        {suggestions.map((suggestion, index) => <button key={`${suggestion.market}-${suggestion.code}`}
          id={`${listId}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === activeIndex}
          className={`${styles.option} ${index === activeIndex ? styles.active : ""}`}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(suggestion)}>
          <span><strong>{suggestion.name}</strong>{suggestion.existing && <small>已在列表</small>}</span>
          <span className={styles.identity}><b>{suggestion.code}</b><small>{suggestion.market === "HK" ? "港股" : "A股"}</small></span>
        </button>)}
      </div>
      <p role="status" className={styles.hint}>{loading ? "正在搜索…" : result.message || (suggestions.length ? "选择股票自动填写 · ↑↓ 选择，Enter 确认" : "未找到匹配股票，可继续手动填写。")}</p>
    </div>}
  </div>;
}
