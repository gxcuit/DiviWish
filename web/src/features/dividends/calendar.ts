import type { Stock } from "./types";

type CalendarStock = Pick<Stock, "instrument_type" | "ex_dividend_date" | "dividend_calendar_dates">;

export function calendarEvents<T extends CalendarStock>(stocks: T[], monthPrefix: string) {
  return stocks.flatMap(stock => {
    const dates = stock.instrument_type === "etf"
      ? [...(stock.dividend_calendar_dates || []), stock.ex_dividend_date]
      : [stock.ex_dividend_date];
    return [...new Set(dates)].flatMap(day => typeof day === "string" && day.startsWith(`${monthPrefix}-`)
      ? [{ ...stock, ex_dividend_date: day }] : []);
  }).sort((first, second) => first.ex_dividend_date.localeCompare(second.ex_dividend_date));
}
