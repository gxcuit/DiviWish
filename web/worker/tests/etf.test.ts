import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { etfSnapshot, fetchEtfDividends, parseEtfPage, parseSinaDividends } from "../etf.ts";
import { parseSearch, providers, symbolFor } from "../providers.ts";
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

test("ETF API persists calendar, default rolling basis and settings; refresh failure retains values; history never runs", async t => {
  let historyCalls = 0;
  const f = fixture({ fetchDividends: async () => snapshot("159331"), fetchHistory: async () => { historyCalls++; throw new Error("must not run"); } });
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
  assert.equal((await f.request(`/api/stocks/${saved.id}/history`, "POST", {})).status, 400);
  await assert.rejects(providers.fetchHistory!(etf()), /暂不支持/);
  assert.equal(historyCalls, 0);
  const listing = await (await f.request("/api/stocks")).json();
  assert.ok(listing.stocks.find((row: { id: number }) => row.id === saved.id).dividend_calendar_dates.length > 1);
  assert.equal((await f.request(`/api/stocks/${saved.id}`, "PATCH", { watched: true, grid_start: 0.02, yield_basis: "annual" })).status, 200);
  const before = await (await f.request(`/api/stocks/${saved.id}`)).json();
  f.source.fetchDividends = async () => { throw new Error("offline"); };
  assert.equal((await f.request(`/api/stocks/${saved.id}/refresh`, "POST", {})).status, 502);
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
