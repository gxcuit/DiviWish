import assert from "node:assert/strict";
import { test } from "node:test";
import { continueForecastSearch, parseForecastCommitments, searchForecastAnnouncements } from "../forecast-announcements.ts";
import { validate } from "../validation.ts";

test("HKEX search uses fromDate/toDate and recognizes multiple trading counters", async t => {
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input); requests.push(url);
    if (url.pathname.endsWith("prefix.do")) return new Response('callback({"stockInfo":[{"code":"00941","stockId":2247}]});');
    assert.equal(url.searchParams.get("fromDate"), "20211106"); assert.equal(url.searchParams.get("toDate"), "20261106");
    return Response.json({ result: JSON.stringify([{ STOCK_CODE: "00941<br/>80941", NEWS_ID: "one", TITLE: "股息政策", FILE_LINK: "/listedco/test.pdf", DATE_TIME: "06/11/2026 12:00" }]), recordCnt: 1 });
  });
  const result = await searchForecastAnnouncements(validate({ market: "HK", code: "00941", name: "中国移动", sector: "通信" }), 2026, "2026-11-06");
  assert.equal(result.pending.length, 1); assert.equal(result.pending[0].date, "2026-11-06"); assert.equal(result.status, "partial"); assert.equal(requests.length, 4);
});

test("announcement search distinguishes transport failure from an empty successful search", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const result = await searchForecastAnnouncements(validate({ market: "A", code: "600036", name: "招商银行", sector: "银行" }), 2026, "2026-11-06");
  assert.equal(result.status, "failed"); assert.match(result.notes.join(""), /不代表没有承诺/);
});

test("CNINFO search saves pagination and continues beyond the first bounded result page", async t => {
  const s = validate({ market: "A", code: "600036", name: "招商银行", sector: "银行" });
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    if (input.includes("topSearch")) return Response.json([{ code: s.code, orgId: "org" }]);
    const params = init!.body as URLSearchParams;
    const page = Number(params.get("pageNum"));
    return Response.json({ totalAnnouncement: 31, announcements: [{ secCode: s.code, announcementId: String(page), announcementTitle: "分红回报规划", adjunctUrl: `finalpage/${page}.pdf`, announcementTime: new Date("2026-01-01").getTime() }] });
  });
  const result = await searchForecastAnnouncements(s, 2026, "2026-11-06");
  assert.equal(result.continuations?.length, 3); assert.equal(result.pending.length, 1);
  await continueForecastSearch(result, s);
  assert.equal(result.continuations?.length, 2); assert.equal(result.pending.length, 2);
});

test("automatic fixed and total cash commitments retain units and participating shares", () => {
  const a = { id: "one", url: "https://static.cninfo.com.cn/one.pdf", title: "回报规划", date: "2026-01-01" };
  const prefix = "证券代码600036。2026年至2028年每年度股东分红回报规划已经股东大会审议通过。";
  const per = parseForecastCommitments([prefix + "每年度每10股派发人民币5元现金股息。"], a, { code: "600036", market: "A" }, 2026);
  assert.equal(per.commitments[0]?.kind, "per_share"); assert.equal(per.commitments[0]?.value, 0.5);
  const total = parseForecastCommitments([prefix + "每年度现金分红总额不低于人民币10亿元，以总股本100000000股为基数。"], a, { code: "600036", market: "A" }, 2026);
  assert.equal(total.commitments[0]?.kind, "total"); assert.equal(total.commitments[0]?.value, 1e9); assert.equal(total.commitments[0]?.shares, 1e8);
});
