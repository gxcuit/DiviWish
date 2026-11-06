import { dailyForecast } from "../../forecast-cache.ts";
import { calculateForecast, forecastToday, forecastYear } from "../../forecast.ts";
import { parseForecastHkConsensus } from "../../forecast-providers.ts";
import { providers } from "../../providers.ts";
import { validate } from "../../validation.ts";
import type { Env, Providers } from "../../types.ts";
import type { ForecastCommitment } from "../../forecast-types.ts";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

// Actual workerd execution, with only an uploaded synthetic fixture and fresh D1.
export async function nativeForecastTest(request: Request, env: Env) {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await request.arrayBuffer()), { useSystemFonts: false });
    try {
      const page = await pdf.getPage(1), content = await page.getTextContent();
      check(content.items.some(item => "str" in item && item.str.includes("Forecast parser runtime")), "PDF text parser failed inside workerd");
    } finally { await pdf.loadingTask.destroy(); }
    const today = forecastToday(), year = forecastYear();
    const [y, m, d] = today.split("-");
    const html = `<table class="figureTable"><tr><td>财政年度</td><td>纯利/(亏损)(百万元人民币)</td><td>每股盈利*/(亏损)(分)</td><td>每股派息</td><td>证券商</td><td>更新日期</td></tr><tr><td>${year}</td><td>300</td><td>200</td><td>60</td><td>测试机构</td><td>${d}/${m}/${y}</td></tr></table>`;
    check(parseForecastHkConsensus(html, year, today, "https://example.test")?.eps === 2, "HTML forecast parser failed inside workerd");
    let calls = 0;
    const cash: ForecastCommitment = { kind: "per_share", value: 2, currency: "CNY", start_year: year, end_year: year, lower_bound: false, conditions: "", approved: true,
      evidence: { url: "https://static.cninfo.com.cn/native.pdf", title: "Native fixture", date: today } };
    const source: Providers = { ...providers, fetchForecast: async (identity, requestedYear, _previous, cache) => {
      calls++; check(!identity.forecast_manual, "Manual parameters entered the public provider");
      await cache!.write("native-forecast-document", ["Public synthetic document"]);
      check((await cache!.read("native-forecast-document"))?.[0] === "Public synthetic document", "Native document cache failed");
      return { year: requestedYear, fetched_at: today, fiscal_end: "12-31", financials: [], consensus: null, dividends: [], commitments: [cash], fx: {}, errors: [],
        search: { status: "found", from: `${year - 5}-01-01`, to: today, pending: [], reviewed: [], notes: [] } };
    } };
    const stock = validate({ code: "600036", market: "A", name: "Native forecast", sector: "银行", price: 10 });
    const first = await dailyForecast(env.DB, stock, source), second = await dailyForecast(env.DB, stock, source);
    check(!first.cached && second.cached && calls === 1, "Native forecast daily cache failed");
    stock.forecast_snapshot = second.snapshot;
    check(calculateForecast(stock, 1).dividend === 2, "Native forecast computation failed");
    stock.forecast_manual = { year, payout_ratio: null, commitment: { ...cash, value: 3, conditions: "private-native-note" } };
    check(calculateForecast(stock, 1).dividend === 3, "Native manual override failed");
    stock.forecast_snapshot!.dividends = [{ period: `${year}-06-30`, amount: .3, status: "implemented", currency: "CNY", special: false, ambiguous: false, complete: false, evidence: cash.evidence }];
    stock.forecast_snapshot!.financials = [{ period: `${year - 1}-12-31`, start: `${year - 1}-01-01`, currency: "CNY", eps: 2, profit: 200,
      shares: 100, equity_status: "present", notice_date: today, source: cash.evidence.url }];
    stock.forecast_snapshot!.consensus = { year, eps: 3, currency: "CNY", analysts: 3, updated_at: today, source: cash.evidence.url };
    stock.forecast_manual = { year, commitment: null, payout_ratio: .4, reconciliation: { currency: "CNY", parent_profit: 330,
      equity_deduction: 30, weighted_shares: 90, participating_shares: 100, source_url: cash.evidence.url, conditions: "private-native-equity" } };
    stock.forecast_snapshot!.commitments = [];
    const reconciled = calculateForecast(stock, 1);
    check(reconciled.reconciliation.ordinary_profit === 300 && reconciled.dividend === 1.2, "Native ordinary profit/share reconciliation failed");
    check(reconciled.distribution.implemented === .3 && reconciled.distribution.remaining === .9, "Native distribution status/remainder failed");
    const row = await env.DB.prepare("SELECT snapshot FROM public_forecast_cache LIMIT 1").first<{ snapshot: string }>();
    check(row && !row.snapshot.includes("private-native-note"), "Manual parameters leaked to the native public cache");
    return Response.json({ pdf: true, html: true, forecastCache: true, documentCache: true, manualIsolation: true, reconciliation: true, distribution: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Native forecast runtime failed" }, { status: 500 }); }
}
