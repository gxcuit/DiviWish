"use client";

import { useEffect, useRef, useState } from "react";
import type { Stock } from "../types";
import { bollLabels } from "../boll-labels";
import { useBoll } from "./boll-provider";
import styles from "./stock-boll-tags.module.css";

const periods = [{ key: "day", short: "日", text: "日线" }, { key: "week", short: "周", text: "周线" }, { key: "month", short: "月", text: "月线" }] as const;

export function StockBollTags({ stock, id }: { stock: Stock; id: string }) {
  const reference = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const { data, loading, error } = useBoll(stock, visible);
  useEffect(() => {
    const element = reference.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "120px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const labels = periods.map(period => {
    const band = data?.bands.find(band => band.period === period.key);
    const label = bollLabels[band?.available ? band.position : "unknown"];
    const reason = band?.available ? label.text : error || (band ? band.error : !data ? loading ? "正在加载" : "等待加载" : label.text);
    const quote = data?.price == null ? "" : `；参考价 ${stock.market === "HK" ? "HK$" : "¥"}${data.price.toFixed(2)}（${data.quote_date || "日期待核实"}）`;
    const description = `${period.text}：${reason}${band?.available ? `；K 线截至 ${band.last_date}${quote}` : ""}${error && data ? `；更新失败，显示上次结果：${error}` : ""}`;
    return { ...period, label, description };
  });
  return <span ref={reference} id={id} className={styles.tags} role="img" aria-label={`BOLL 位置，${labels.map(label => label.description).join("；")}`}>
    {labels.map(({ key, short, label, description }) => <span key={key} title={description} className={`${styles.tag} ${styles[label.tone]} ${error && data ? styles.stale : ""}`}>{short}{label.short}</span>)}
  </span>;
}

export function BollLegend() {
  return <details className={styles.legend}><summary>BOLL 标签说明</summary><p>日、周、月各显示一个两字标签：上为上轨附近或以上，中为中轨附近，下为下轨附近或以下；高、低分别表示中轨与上轨、下轨与中轨之间。上轨红色，中轨蓝色，下轨绿色，高位橙色，低位青色。</p><p>附近范围为通道总宽度的 5%。上下轨浅色虚线表示接近，深色实线表示触及或越过；灰色“平”为三轨重合，“—”为数据不足或未加载。悬停可查看完整位置与行情日期，点击股票可查看详情。</p></details>;
}
