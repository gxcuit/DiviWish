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
