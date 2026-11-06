// Read-only source check; optional capture contains only public API fields, never portfolio data.
import { writeFile } from "node:fs/promises";
import { forecastReport } from "../worker/forecast-http.ts";
import { attachForecastBalance, parseForecastFinancials, parseForecastAConsensus, parseForecastDividends } from "../worker/forecast-providers.ts";
import { calculateForecast, forecastToday, forecastYear } from "../worker/forecast.ts";
import { validate } from "../worker/validation.ts";
const today = forecastToday(), year = forecastYear(), captured = [];
for (const [code, name, bank] of [["601665", "齐鲁银行", true], ["600036", "招商银行", true], ["601899", "紫金矿业", false], ["601857", "中国石油", false]]) {
  const stock = validate({ market: "A", code, name, sector: "公开样本", price: 10 });
  const filter = `(SECURITY_CODE="${code}")`;
  const [financial, balance, consensus, dividends] = await Promise.all([
    forecastReport("RPT_F10_FINANCE_MAINFINADATA", filter, "SECURITY_CODE,REPORT_DATE,NOTICE_DATE,CURRENCY,EPSJB,PARENTNETPROFIT,TOTAL_SHARE", "REPORT_DATE", 20),
    forecastReport(bank ? "RPT_F10_FINANCE_BBALANCE" : "RPT_F10_FINANCE_GBALANCE", filter, "SECURITY_CODE,REPORT_DATE,NOTICE_DATE,OTHER_EQUITY_TOOL,PREFERRED_SHARES,PERPETUAL_BOND,TREASURY_SHARES", "REPORT_DATE", 20),
    forecastReport("RPT_WEB_RESPREDICT", filter, "ALL", "", 1),
    forecastReport("RPT_SHAREBONUS_DET", filter, "SECURITY_CODE,REPORT_DATE,NOTICE_DATE,PLAN_NOTICE_DATE,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,PRETAX_BONUS_RMB,TOTAL_SHARES,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE", "REPORT_DATE", 30),
  ]);
  const sample = { code, name, financial, balance, consensus, dividends };
  captured.push(sample);
  stock.forecast_snapshot = { year, fetched_at: today, fiscal_end: "12-31", fx: {}, errors: [], commitments: [],
    financials: attachForecastBalance(parseForecastFinancials(financial.rows, stock, financial.url, today), balance.rows, stock, balance.url, today),
    consensus: parseForecastAConsensus(consensus.rows, stock, year, today, consensus.url),
    dividends: parseForecastDividends(dividends.rows, stock, dividends.url, today),
    search: { status: "not_found", from: today, to: today, pending: [], reviewed: [], notes: ["此核查仅检查财务和分红接口，未执行公告承诺检索"] } };
  const result = calculateForecast(stock, 1, today);
  console.log(JSON.stringify({ code, name, status: result.status, reason: result.reason, reconciliation: result.reconciliation,
    payout_years: result.payout_years, dividend: result.dividend, distribution: result.distribution }, null, 2));
}
if (process.argv.includes("--capture")) await writeFile(new URL("../worker/tests/fixtures/forecast-public-2026-11-06.json", import.meta.url), JSON.stringify({ today, year, samples: captured }, null, 2) + "\n");
