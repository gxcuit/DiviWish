import { calculateForecast, forecastYear } from "../../forecast.ts";
import { forecastResponse } from "../../forecast-service.ts";
import { validate } from "../../validation.ts";
import type { Env } from "../../types.ts";
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function nativeForecastTest(request: Request, env: Env) {
  try {
    const stock = validate({ code: "601665", market: "A", name: "Native manual forecast", sector: "银行", price: 10,
      forecast_manual: { year: forecastYear(), kind: "yield", value: .05, currency: "CNY", note: "private-native-manual" } });
    check(calculateForecast(stock, 1).dividend === .5, "Native manual percentage failed");
    stock.price = 20;
    check(calculateForecast(stock, 1).yield === .025, "Native manual quote anchoring failed");
    const hk = validate({ code: "00941", market: "HK", name: "Native HK", sector: "电信", price: 10,
      forecast_manual: { year: forecastYear(), kind: "per_share", value: 2, currency: "CNY", note: "" } });
    check(calculateForecast(hk, .8).dividend === 2.5, "Native manual FX failed");
    try { await forecastResponse(request, stock, { stocks: async () => [], meta: async () => ({}) }); throw new Error("Automatic refresh still enabled"); }
    catch (error) { check(error instanceof Error && "status" in error && error.status === 410, "Automatic refresh must return 410"); }
    const row = await env.DB.prepare("SELECT count(*) n FROM public_forecast_cache").first<{ n: number }>();
    check(row?.n === 0, "Manual forecast wrote public data");
    return Response.json({ manualForecast: true, currency: true, automaticDisabled: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Native manual forecast failed" }, { status: 500 }); }
}
