import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historyEnd } from "../history.ts";
import { providers } from "../providers.ts";
import { validate } from "../validation.ts";

test("ETF history fetches unadjusted daily prices, retains primary on secondary failure and rejects adjusted data", async t => {
  const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8"));
  const stock = validate({ code: "510880", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF" });
  const end = historyEnd();
  const dates = Array.from({ length: 90 }, (_, i) => new Date(Date.parse(end) - (89 - i) * 86400_000).toISOString().slice(0, 10));
  const urls: URL[] = [];
  let adjusted = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)); urls.push(url);
    if (url.hostname.includes("eastmoney")) return new Response(samples["510880"].html);
    if (url.hostname.includes("sina")) return new Response("offline", { status: 503 });
    const param = url.searchParams.get("param")!.split(",");
    assert.equal(param[0], "sh510880"); assert.equal(param[1], "day"); assert.equal(param.at(-1), "");
    const rows = dates.filter(day => day >= param[2] && day <= param[3]).map(day => [day, "2", "2"]);
    return new Response(JSON.stringify({ code: 0, data: { sh510880: { [adjusted ? "qfqday" : "day"]: rows } } }));
  });
  const result = await providers.fetchHistory!(stock);
  assert.equal(result.history_version, 4);
  assert.equal(result.history_status, "ready");
  assert.equal(result.history.length, 90);
  assert.match(result.history_note, /核验暂不可用/);
  assert.ok(urls.some(url => url.searchParams.get("param")?.endsWith(",640,")));
  adjusted = true;
  await assert.rejects(providers.fetchHistory!(stock), /不复权/);
});

test("a confirmed non-distributing ETF is not applicable even when the price service is unavailable", async t => {
  const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8"));
  const stock = validate({ code: "512890", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("eastmoney")) return new Response(samples["512890"].html);
    if (url.includes("sina")) return new Response(samples["512890"].sina);
    assert.fail("zero cash distributions must not require price history");
  });
  const result = await providers.fetchHistory!(stock);
  assert.equal(result.history_status, "not_applicable");
  assert.equal(result.history.length, 0);
  assert.match(result.history_note, /暂无已除息现金分红/);
});

test("ETF dividend fragments must match the fund and missing completed cash triggers one bounded fresh request", async t => {
  const { fetchEtfDividends, parseEtfPage } = await import("../etf.ts");
  const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8"));
  const sample = samples["510880"], stock = validate({ code: "510880", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF" });
  const wrongIdentity = `<label>2026年度 <a href='http://fund.eastmoney.com/000001.html'>其他基金</a> 累计分红0元/份。</label>`;
  assert.throws(() => parseEtfPage(sample.html + wrongIdentity, "510880"), /片段证券身份/);
  let primaryCalls = 0;
  const empty = samples["159915"].html.replaceAll("159915", "510880");
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("sina")) return new Response(sample.sina);
    primaryCalls++;
    if (primaryCalls === 1) return new Response(empty);
    assert.ok(new URL(url).searchParams.has("verification"));
    return new Response(sample.html);
  });
  const recovered = await fetchEtfDividends(stock);
  assert.equal(primaryCalls, 2);
  assert.ok(recovered.dividends.length > 1);
  assert.equal(recovered.dividend_verification, "matched");
  mock.mock.restore();
  primaryCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("sina")) return new Response(sample.sina);
    primaryCalls++; return new Response(empty);
  });
  await assert.rejects(fetchEtfDividends(stock), /分红记录不完整/);
  assert.equal(primaryCalls, 2);
});

test("ETF invalid fragment retry also works when the secondary source is unavailable; rate limits never retry", async t => {
  const { fetchEtfDividends } = await import("../etf.ts");
  const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8"));
  const stock = validate({ code: "510880", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF" });
  let primaryCalls = 0;
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("sina")) return new Response("offline", { status: 503 });
    primaryCalls++;
    return new Response(primaryCalls === 1 ? "invalid page" : samples["510880"].html);
  });
  const recovered = await fetchEtfDividends(stock);
  assert.equal(primaryCalls, 2); assert.equal(recovered.dividend_verification, "unavailable");
  assert.ok(recovered.dividends.length > 1);
  mock.mock.restore(); primaryCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("sina")) return new Response("offline", { status: 503 });
    primaryCalls++; return new Response("limited", { status: 429 });
  });
  await assert.rejects(fetchEtfDividends(stock), /HTTP 429/);
  assert.equal(primaryCalls, 1);
});
