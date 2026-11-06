// Read-only public-source smoke check. Never opens a portfolio database.
import { fetchForecast } from "../worker/forecast-providers.ts";
import { calculateForecast, forecastYear } from "../worker/forecast.ts";
import { validate } from "../worker/validation.ts";
import { providers } from "../worker/providers.ts";

for (const [market, code, name] of [["A", "600036", "招商银行"], ["HK", "00388", "香港交易所"], ["HK", "00941", "中国移动"]]) {
  const started = Date.now(), stock = validate({ market, code, name, sector: "公开样本", price: 10 });
  try {
    let snapshot = await fetchForecast(stock, forecastYear());
    if (snapshot.search.pending.length) snapshot = await fetchForecast(stock, forecastYear(), snapshot);
    stock.forecast_snapshot = snapshot;
    const fx = market === "HK" ? await providers.fetchFx().catch(() => null) : 1;
    const result = calculateForecast(stock, fx);
    console.log(JSON.stringify({ market, code, elapsed_ms: Date.now() - started, financials: snapshot.financials.length,
      consensus: snapshot.consensus, historical_dividends: snapshot.dividends.length, commitments: snapshot.commitments.length,
      announcement_status: snapshot.search.status, remaining: snapshot.search.pending.length, reviewed: snapshot.search.reviewed,
      result: { status: result.status, dividend: result.dividend, currency: result.currency, basis: result.basis, earnings_basis: result.earnings_basis, payout_ratio: result.payout_ratio, reason: result.reason }, notes: snapshot.errors, search_notes: snapshot.search.notes }, null, 2));
  } catch (error) { console.error(JSON.stringify({ market, code, error: error.message })); process.exitCode = 1; }
}
