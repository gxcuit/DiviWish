import type { BollResponse, Stock } from "./types.ts";

type Identity = Pick<Stock, "id" | "market" | "code" | "price" | "quote_date">;
export type BollSnapshot = { data: BollResponse | null; loading: boolean; error: string };
export const EMPTY_BOLL: BollSnapshot = { data: null, loading: false, error: "" };
type Loader = (stock: Identity, signal: AbortSignal, force: boolean) => Promise<BollResponse>;
type Task = { key: string; stock: Identity; controller: AbortController; force: boolean; done: () => void; promise: Promise<void> };

export const bollKey = (stock: Identity) => `${stock.id}:${stock.market}:${stock.code}:${stock.price}:${stock.quote_date}`;

// One store per mounted dashboard: no portfolio data survives an account switch.
export class BollStore {
  private records = new Map<string, { snapshot: BollSnapshot; time: number }>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<string, Task>();
  private queue: Task[] = [];
  private running = 0;
  private load: Loader;

  constructor(load: Loader) { this.load = load; }

  get(key: string): BollSnapshot { return this.records.get(key)?.snapshot ?? EMPTY_BOLL; }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
      this.trim();
    };
  }

  private trim() {
    for (const key of this.records.keys()) {
      if (this.records.size <= 128) break;
      if (!this.listeners.has(key) && !this.pending.has(key)) this.records.delete(key);
    }
  }

  private update(key: string, snapshot: BollSnapshot, time = 0) {
    this.records.set(key, { snapshot, time });
    this.listeners.get(key)?.forEach(listener => listener());
    this.trim();
  }

  fetch(stock: Identity, force = false): Promise<void> {
    const key = bollKey(stock), existing = this.pending.get(key), record = this.records.get(key);
    if (existing) return existing.promise;
    if (!force && record?.snapshot.data && Date.now() - record.time < 300_000) return Promise.resolve();
    let done = () => {};
    const promise = new Promise<void>(resolve => { done = resolve; });
    const task: Task = { key, stock, force, controller: new AbortController(), done, promise };
    this.pending.set(key, task);
    this.update(key, { ...this.get(key), loading: true, error: "" });
    this.queue.push(task); this.pump();
    return promise;
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const task = this.queue.shift()!;
      this.running++;
      void this.load(task.stock, task.controller.signal, task.force).then(data => {
        if (!task.controller.signal.aborted && this.pending.get(task.key) === task) {
          this.update(task.key, { data, loading: false, error: "" }, data.bands.every(band => band.available) ? Date.now() : 0);
        }
      }).catch(failure => {
        if (!task.controller.signal.aborted && this.pending.get(task.key) === task) {
          this.update(task.key, { ...this.get(task.key), loading: false, error: failure instanceof Error ? failure.message : "BOLL 数据获取失败" });
        }
      }).finally(() => {
        this.running--;
        if (this.pending.get(task.key) === task) this.pending.delete(task.key);
        task.done(); this.pump();
      });
    }
  }

  reset() {
    for (const task of this.pending.values()) { task.controller.abort(); task.done(); }
    this.pending.clear(); this.queue = []; this.records.clear();
    this.listeners.forEach(listeners => listeners.forEach(listener => listener()));
  }
}
