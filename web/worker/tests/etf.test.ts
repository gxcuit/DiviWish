import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { etfSnapshot, fetchEtfDividends, parseEtfPage, parseSinaDividends } from "../etf.ts";
import { parseSearch, symbolFor } from "../providers.ts";
import { validate } from "../validation.ts";
import { fixture } from "./helpers.ts";

const { samples } = JSON.parse(readFileSync(new URL("./fixtures/etf/public-samples.json", import.meta.url), "utf8")) as {
  samples: Record<string, { html: string; sina: string }>;
};
const etf = (code = "510880") => validate({ code, market: "A", instrument_type: "etf", exchange: code.startsWith("5") ? "sh" : "sz", name: "ETF 测试", sector: "ETF" });
const snapshot = (code: string) => etfSnapshot(parseEtfPage(samples[code].html, code), parseSinaDividends(samples[code].sina, symbolFor(etf(code))), "2026-11-02");

test("seven public ETF samples match all 73 completed distributions and distinguish the upcoming event", () => {
  const expected: Record<string, [number, number]> = { "510050": [18, 0.08], "510880": [19, 0.143], "515180": [7, 0.061], "512890": [0, 0], "159915": [0, 0], "159220": [3, 0.0167], "159331": [26, 0.0425] };
  for (const [code, [count, ttm]] of Object.entries(expected)) {
    const result = snapshot(code);
    assert.equal(result.dividend_verification, "matched", code);
    assert.equal(result.dividends.filter(row => row.date! <= "2026-11-02").length, count, code);
    assert.equal(result.rolling_dividend, ttm, code);
    assert.equal(result.annual_year, 2025);
  }
  const monthly = snapshot("159331");
  assert.equal(monthly.next_ex_dividend_date, "2026-11-04");
  assert.equal(monthly.dividends[0].status, "待除息");
  assert.equal(monthly.dividends[0].dps, 0.0031);
  assert.ok(monthly.dividend_calendar_dates?.includes("2026-11-04"));
  assert.equal(snapshot("510050").annual_dividend, 0.08);
});

test("ETF calendar windows, leap years, splitting and invalid split metadata do not fabricate income", () => {
  const page = parseEtfPage(samples["159220"].html, "159220");
  page.dividends = [
    { period: "2025-11-02", date: "2025-11-02", record_date: "2025-11-01", pay_date: "2025-11-05", dps: 0.2, status: "" },
    { period: "2026-01-01", date: "2026-01-01", record_date: "2025-12-31", pay_date: "2026-01-05", dps: 0.03, status: "" },
  ];
  assert.equal(etfSnapshot(page, null, "2026-11-02").annual_dividend, 0.1);
  assert.equal(etfSnapshot(page, null, "2026-11-02").rolling_dividend, 0.03);
  page.split_warning = true;
  assert.equal(etfSnapshot(page, null, "2026-11-02").rolling_dividend, null);
  assert.equal(etfSnapshot(page, null, "2026-11-02").annual_dividend, null);
  assert.equal(etfSnapshot({ dividends: [], splits: [], split_warning: false }, null, "2024-02-29").dividend_rolling_start, "2023-02-28");
});

test("identity, duplicate dates, empty pages, malformed units and scripts are rejected", () => {
  const sample = samples["510050"];
  assert.throws(() => parseEtfPage(sample.html, "510880"), /身份/);
  assert.throws(() => parseEtfPage(sample.html.replace("每10份派现金0.8000元", "每10份送股票"), "510050"), /金额/);
  assert.throws(() => parseEtfPage(sample.html.replace("2024-12-02", "2025-12-17"), "510050"));
  assert.throws(() => parseEtfPage("<title>ETF(510050)基金分红送配</title>", "510050"), /格式/);
  assert.throws(() => parseSinaDividends(sample.sina, "sh510880"), /身份/);
  assert.throws(() => parseSinaDividends('var sh510050hfq={"total":0,"data":[]}', "sh510050"), /不完整/);
  assert.throws(() => parseSinaDividends('var sh510050hfq=(()=>{throw Error("remote code")})()', "sh510050"));
});

test("secondary outage and mismatch preserve the primary amounts and explicit verification status", async t => {
  const mock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => new Response(String(url).includes("sina") ? "unavailable" : samples["510880"].html, { status: String(url).includes("sina") ? 503 : 200 }));
  const result = await fetchEtfDividends(etf());
  assert.equal(result.dividend_verification, "unavailable");
  assert.ok(result.dividends.length > 0);
  mock.mock.restore();
  const page = parseEtfPage(samples["510880"].html, "510880");
  const mismatch = etfSnapshot(page, new Map([["2026-01-21", 99]]), "2026-11-02");
  assert.equal(mismatch.dividend_verification, "mismatch");
  assert.equal(mismatch.rolling_dividend, 0.143);
  t.mock.method(globalThis, "fetch", async () => new Response("denied", { status: 403 }));
  await assert.rejects(fetchEtfDividends(etf()), /HTTP 403/);
});

test("ETF search and explicit exchanges route quotes correctly; old stock defaults remain compatible", () => {
  const entries = parseSearch('v_hint=' + JSON.stringify("sh~510880~红利ETF华泰柏瑞~hletf~ETF^sz~159220~港股通红利低波ETF华宝~etf~ETF^sh~000922~中证红利~zs~ZS"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].instrument_type, "etf");
  assert.equal(entries[1].exchange, "sz");
  assert.equal(symbolFor(etf()), "sh510880");
  assert.equal(symbolFor(etf("159220")), "sz159220");
  assert.equal(etf().yield_basis, "rolling");
  assert.equal(validate({ code: "600001", market: "A", name: "旧股票", sector: "其他" }).instrument_type, "stock");
  assert.throws(() => validate({ market: "HK" }, etf()), /沪深 ETF/);
  assert.throws(() => validate({ code: "510880", market: "A", name: "ETF", sector: "ETF", instrument_type: "etf", exchange: "sz" }), /沪深 ETF/);
});

test("ETF API persists calendar, default rolling basis and settings; refresh failure retains values; history requests preserve failures", async t => {
  let historyCalls = 0;
  const f = fixture({ fetchDividends: async () => snapshot("159331"), fetchHistory: async () => { historyCalls++; throw new Error("offline"); } });
  t.after(() => f.db.sqlite.close());
  const created = await f.request("/api/stocks", "POST", { code: "159331", market: "A", instrument_type: "etf", exchange: "sz", name: "测试ETF", sector: "ETF", price: 1, target_yield: 0.05 });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.equal(saved.yield_basis, "rolling");
  assert.equal((await f.request(`/api/stocks/${saved.id}/refresh`, "POST", {})).status, 200);
  const detail = await (await f.request(`/api/stocks/${saved.id}`)).json();
  assert.equal(detail.selected_yield, 0.0425);
  assert.equal(detail.target_price, 0.85);
  assert.equal(detail.payout_ratio, null);
  assert.equal(detail.percentile, null);
  assert.equal(detail.dividend_verification, "matched");
  assert.equal(detail.next_ex_dividend_date, "2026-11-04");
  assert.equal((await f.request(`/api/stocks/${saved.id}/history`, "POST", {})).status, 502);
  assert.equal(historyCalls, 1);
  const listing = await (await f.request("/api/stocks")).json();
  assert.ok(listing.stocks.find((row: { id: number }) => row.id === saved.id).dividend_calendar_dates.length > 1);
  assert.equal((await f.request(`/api/stocks/${saved.id}`, "PATCH", { watched: true, grid_start: 0.02, yield_basis: "annual" })).status, 200);
  const before = await (await f.request(`/api/stocks/${saved.id}`)).json();
  f.source.fetchDividends = async () => { throw new Error("offline"); };
  assert.equal((await f.request(`/api/stocks/${saved.id}/refresh?dividends=force`, "POST", {})).status, 502);
  assert.deepEqual(await (await f.request(`/api/stocks/${saved.id}`)).json(), before);
});

test("ETF refresh skips changed identity while upstream requests are in flight", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const created = await (await f.request("/api/stocks", "POST", { code: "510880", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF" })).json();
  f.source.fetchDividends = async () => {
    await f.request(`/api/stocks/${created.id}`, "PATCH", { code: "159220", exchange: "sz" });
    return snapshot("510880");
  };
  assert.equal((await f.request(`/api/stocks/${created.id}/refresh`, "POST", {})).status, 502);
  assert.equal((await (await f.request(`/api/stocks/${created.id}`)).json()).annual_dividend, null);
});

test("ETF history caches success/not-applicable, supports forced retry, and rejects concurrent cash edits", async t => {
  let calls = 0;
  const f = fixture({ fetchHistory: async () => { calls++; return { history: [], history_version: 4, history_status: "not_applicable", percentile_start: "", percentile_end: "", history_updated_at: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) + "T10:00:00+08:00", history_source: "test", history_note: "查询成功，无分红" }; } });
  t.after(() => f.db.sqlite.close());
  const saved = await (await f.request("/api/stocks", "POST", { code: "512890", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF", price: 1, rolling_dividend: 0 })).json();
  const url = `/api/stocks/${saved.id}/history`;
  assert.equal((await f.request(url, "POST", {})).status, 200);
  const detail = await (await f.request(`/api/stocks/${saved.id}`)).json();
  assert.equal(detail.history_status, "not_applicable");
  assert.equal(detail.percentile, null);
  assert.equal((await f.request(url, "POST", {})).status, 200);
  assert.equal(calls, 1);
  assert.equal((await f.request(url + "?refresh=1", "POST", {})).status, 200);
  assert.equal(calls, 2);
  const original = f.source.fetchHistory!;
  f.source.fetchHistory = async stock => {
    await f.request(`/api/stocks/${stock.id}`, "PATCH", { rolling_dividend: 0.1 });
    return original(stock);
  };
  assert.equal((await f.request(url + "?refresh=1", "POST", {})).status, 409);
  assert.equal((await (await f.request(`/api/stocks/${saved.id}`)).json()).rolling_dividend, 0.1);
});

test("ETF ready histories survive outages, retain concurrent watch settings and invalidate when distributions change", async t => {
  const sample = snapshot("159331");
  const f = fixture({ fetchDividends: async () => sample });
  t.after(() => f.db.sqlite.close());
  const saved = await (await f.request("/api/stocks", "POST", { code: "159331", market: "A", instrument_type: "etf", exchange: "sz", name: "ETF", sector: "ETF", price: 1 })).json();
  await f.request(`/api/stocks/${saved.id}/refresh`, "POST", {});
  f.source.fetchHistory = async () => {
    await f.request(`/api/stocks/${saved.id}`, "PATCH", { watched: true });
    return { history: Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10), close: 1, yield: 0.02 + i / 1000, rolling_yield: 0.02 + i / 1000 })), history_version: 4, history_status: "ready", percentile_start: "2026-08-01", percentile_end: "2026-09-29", history_source: "test", history_updated_at: new Date().toISOString(), history_note: "test" };
  };
  assert.equal((await f.request(`/api/stocks/${saved.id}/history`, "POST", {})).status, 200);
  const before = await (await f.request(`/api/stocks/${saved.id}`)).json();
  assert.equal(before.watched, true);
  assert.equal(before.percentile_count, 60);
  assert.equal(before.quantile_90_price, before.rolling_dividend / before.quantile_90_yield);
  await f.request(`/api/stocks/${saved.id}`, "PATCH", { yield_basis: "custom", custom_dividend: 0.9 });
  const custom = await (await f.request(`/api/stocks/${saved.id}`)).json();
  assert.notEqual(custom.percentile, before.percentile);
  assert.equal(custom.percentile, 1);
  assert.notEqual(custom.quantile_60_price, before.quantile_60_price);
  assert.equal(custom.quantile_60_price, 1);
  f.source.fetchHistory = async () => { throw new Error("offline"); };
  assert.equal((await f.request(`/api/stocks/${saved.id}/history?refresh=1`, "POST", {})).status, 502);
  assert.deepEqual((await (await f.request(`/api/stocks/${saved.id}`)).json()).history, before.history);
  f.source.fetchDividends = async () => ({ ...sample, rolling_dividend: 0.05 });
  assert.equal((await f.request(`/api/stocks/${saved.id}/refresh?dividends=force`, "POST", {})).status, 200);
  const changed = await (await f.request(`/api/stocks/${saved.id}`)).json();
  assert.equal(changed.history.length, 0);
  assert.equal(changed.percentile, null);
  assert.notEqual(changed.history_version, 4);
});

test("ETF rolling-only same-day caches upgrade once, then annual and rolling selection reuse both series", async t => {
  let calls = 0;
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) + "T12:00:00+08:00";
  const f = fixture({ fetchHistory: async () => ({ history: Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10), close: 1, yield: 0.01 + i / 10000, annual: 0.01, year: 2025, rolling_yield: 0.03 + i / 10000 })), history_version: ++calls === 1 ? 3 : 4, history_status: "ready", percentile_start: "2026-07-01", percentile_end: "2026-09-28", history_updated_at: now, history_source: "test", history_note: "test" }) });
  t.after(() => f.db.sqlite.close());
  const saved = await (await f.request("/api/stocks", "POST", { code: "510880", market: "A", instrument_type: "etf", exchange: "sh", name: "ETF", sector: "ETF", price: 1, annual_dividend: 0.015, rolling_dividend: 0.035 })).json();
  const url = `/api/stocks/${saved.id}`;
  assert.equal((await f.request(url + "/history", "POST", {})).status, 200);
  await f.request(url, "PATCH", { yield_basis: "annual" });
  assert.equal((await (await f.request(url)).json()).percentile, null);
  const upgraded = await (await f.request(url + "/history", "POST", {})).json();
  assert.equal(upgraded.history_version, 4);
  assert.equal(upgraded.quantile_60_price, 0.015 / upgraded.quantile_60_yield);
  const history = upgraded.history;
  await f.request(url, "PATCH", { yield_basis: "rolling" });
  const rolling = await (await f.request(url + "/history", "POST", {})).json();
  assert.equal(calls, 2);
  assert.deepEqual(rolling.history, history);
  assert.notEqual(rolling.quantile_60_yield, upgraded.quantile_60_yield);
  assert.equal(rolling.quantile_60_price, 0.035 / rolling.quantile_60_yield);
});
