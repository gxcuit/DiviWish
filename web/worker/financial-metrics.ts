import type { Kline, Quote, StockRecord } from "./types.ts";

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/** A current-adjustment baseline must belong to the quote's calendar year. */
export function yearBaseline(data: Kline, quote: Quote) {
  const year = Number(quote.quote_date?.slice(0, 4));
  if (!year || data.quote?.quote_date !== quote.quote_date) throw new Error("年初基准与报价日期不一致");
  const baseline = data.bars.filter(bar => bar.date < `${year}-01-01` && bar.date >= `${year - 1}-12-01` && bar.close > 0).at(-1);
  if (!baseline) throw new Error("缺少上年末交易日收盘价（新上市或停牌股票可能无基准）");
  return { year_start_price: baseline.close, year_start_date: baseline.date, year_start_year: year,
    year_start_adjustment: data.adjustment };
}

export function payoutMetrics(stock: StockRecord) {
  const eps = number(stock.annual_eps), year = number(stock.annual_eps_year);
  const currency = stock.annual_eps_currency;
  const cash = stock.market === "A" ? number(stock.annual_dividend) : number(stock.payout_dividend);
  const matched = year !== null && year === stock.annual_year && (stock.market === "A" ? currency === "CNY" : (currency === stock.payout_currency || cash === 0 && ["CNY", "HKD", "USD"].includes(String(currency))));
  const ratio = matched && eps !== null && eps > 0 && cash !== null && cash >= 0 ? cash / eps : null;
  const note = !matched || eps === null || cash === null ? "缺少同财年、同币种的每股收益或股息，请刷新行情与股息。"
    : eps <= 0 ? `${year} 年度基本每股收益非正，支付率不适用。`
      : `${year} 年度；全年每股现金股息 ÷ 基本每股收益（${currency}）。每股口径估算，可能与公告的现金分红总额口径略有差异。`;
  return { payout_ratio: ratio, payout_note: note };
}
