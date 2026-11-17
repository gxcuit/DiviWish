import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSourceFailure, SourceHttpError } from "../source-failure.ts";
import { MarketService } from "../market.ts";
import { providers } from "../providers.ts";
import { sampleStocks } from "./helpers.ts";

test("source failures distinguish HTTP, timeout, DNS/TLS and invalid data without disclosing raw errors", () => {
  assert.deepEqual(describeSourceFailure(new SourceHttpError(429)), { kind: "http", status: 429, message: "数据源 HTTP 429" });
  assert.equal(describeSourceFailure(new DOMException("private request", "TimeoutError")).kind, "timeout");
  assert.equal(describeSourceFailure(new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })).kind, "timeout");
  for (const code of ["ENOTFOUND", "ECONNRESET", "CERT_HAS_EXPIRED"]) {
    assert.deepEqual(describeSourceFailure(new TypeError("fetch failed", { cause: { code, message: "private request" } })),
      { kind: "network", code, message: `数据源网络连接失败（${code}）` });
  }
  assert.equal(describeSourceFailure(new Error("Network connection lost.")).kind, "network");
  for (const error of [new SyntaxError("private response"), new Error("private request", { cause: { code: "private code" } }), "private error"]) {
    assert.deepEqual(describeSourceFailure(error), { kind: "data", message: "数据源返回内容或数据校验异常" });
  }
});

test("market failures retain the failing public index and reason, preserve cache and redact private context", async t => {
  const logs: string[] = []; t.mock.method(console, "warn", (line: string) => logs.push(line));
  let now = Date.parse("2026-11-17T07:00:00Z"), failure: Error | null = new SourceHttpError(503), calls = 0;
  const service = new MarketService(async code => {
    calls++;
    if (code === "H00922" && failure) throw failure;
    return Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.parse("2026-01-01") + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i }));
  }, () => now);
  await assert.rejects(service.get(), /H00922：数据源 HTTP 503/);
  assert.equal(calls, 2);
  const log = JSON.parse(logs[0]); assert.equal(log.event, "market_fetch_failed");
  assert.equal(log.failures[0].index, "H00922"); assert.equal(log.failures[0].status, 503); assert.equal(log.retained, false);
  await assert.rejects(service.get(true), /一分钟/); assert.equal(calls, 2);
  failure = null; now += 60_001; const verified = await service.get();
  failure = new DOMException("private URL and token", "TimeoutError"); now += 31 * 60_000;
  const stale = await service.get(); assert.equal(stale.stale, true); assert.match(stale.warning!, /H00922：数据源请求超时/);
  assert.deepEqual(stale.series, verified.series); assert.equal(JSON.parse(logs.at(-1)!).retained, true);
  assert.ok(!JSON.stringify({ logs, stale }).includes("private"));
});

test("quote transport failures remain bounded, retain old quotes and report a safe reason", async t => {
  let calls = 0; const logs: string[] = [];
  t.mock.method(console, "warn", (line: string) => logs.push(line));
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND", message: "private hostname and token" } }); });
  const result = await providers.fetchQuotes(sampleStocks());
  assert.equal(calls, 1); assert.equal(result.quotes.size, 0); assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(error => /ENOTFOUND.*保留旧报价/.test(error)));
  assert.equal(JSON.parse(logs[0]).event, "quote_fetch_failed");
  assert.ok(!JSON.stringify({ logs, result }).includes("private"));
});
