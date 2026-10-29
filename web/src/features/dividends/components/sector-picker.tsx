"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./sector-picker.module.css";

export function SectorPicker({ value, options, onChange }: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const identity = useId();
  const inputId = `${identity}-sector`;
  const listId = `${identity}-sectors`;
  const inputReference = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const visible = filter === null ? options : options.filter(option => option.includes(filter.trim()));
  const activeOption = visible[activeIndex];

  useEffect(() => {
    if (open && activeOption) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeOption, activeIndex, listId]);

  function showAll() {
    setFilter(null);
    setActiveIndex(options.indexOf(value));
    setOpen(true);
  }

  function choose(option: string) {
    onChange(option);
    setOpen(false);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) showAll();
      else if (visible.length) setActiveIndex(index => event.key === "ArrowDown" ? (index + 1) % visible.length : index <= 0 ? visible.length - 1 : index - 1);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (activeOption) choose(activeOption);
      else setOpen(false);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return <div className={styles.root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <label htmlFor={inputId}>所属板块</label>
    <div className={styles.control}>
      <input ref={inputReference} id={inputId} name="sector" required maxLength={30} autoComplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open && activeOption ? `${listId}-${activeIndex}` : undefined}
        value={value} onFocus={showAll} onClick={showAll} onKeyDown={handleKey}
        onChange={event => { onChange(event.target.value); setFilter(event.target.value); setActiveIndex(-1); setOpen(true); }} />
      <button type="button" aria-label="显示已有板块" aria-expanded={open} aria-controls={listId}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          if (open) setOpen(false);
          else { inputReference.current?.focus(); showAll(); }
        }}><ChevronDown size={17} /></button>
    </div>
    {open && <div className={styles.dropdown}>
      <div id={listId} role="listbox" aria-label="已有板块" className={styles.list}>
        {visible.map((option, index) => <button id={`${listId}-${index}`} key={option} type="button" role="option"
          aria-selected={option === value} tabIndex={-1} className={`${styles.option} ${index === activeIndex ? styles.active : ""}`}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(option)}>
          <span>{option}</span>{option === value && <Check size={15} />}
        </button>)}
      </div>
      <p className={styles.hint}>{visible.length ? "选择已有类别，也可输入新类别" : "暂无匹配类别，可直接使用输入的新类别"}</p>
    </div>}
  </div>;
}
