import { derive } from "../../calculations.ts";
import { validate } from "../../validation.ts";
import type { Env } from "../../types.ts";
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function nativeCustomDividendTest(env: Env) {
  try {
    const stock = validate({ code: "601665", market: "A", name: "Native custom dividend", sector: "银行", price: 10,
      yield_basis: "custom", custom_dividend: 1, custom_dividend_note: "private-note" });
    check(derive(stock, 1).selected_yield === .1, "Native dividend/price calculation failed");
    stock.price = 20;
    check(derive(stock, 1).selected_yield === .05 && stock.custom_dividend === 1, "Quote rewrote saved cash");
    const hk = validate({ code: "00941", market: "HK", name: "Native HK", sector: "电信", price: 10,
      yield_basis: "custom", custom_dividend: 2, custom_dividend_currency: "CNY" });
    check(derive(hk, .8).basis_dividend === 2.5 && derive(hk, .8).selected_yield === .25, "Native FX failed");
    const row = await env.DB.prepare("SELECT count(*) n FROM public_forecast_cache").first<{ n: number }>();
    check(row?.n === 0, "Custom dividends wrote public cache");
    return Response.json({ customDividend: true, currency: true, quoteIndependent: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Native custom dividend failed" }, { status: 500 }); }
}
