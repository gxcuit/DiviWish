import { resolveMarketSelection } from "../../market-indices.ts";
import { MarketService, parseIndexHistory } from "../../market.ts";
import { describeSourceFailure, SourceHttpError } from "../../source-failure.ts";

export async function nativeMarketTest() {
  try {
    if (describeSourceFailure(new DOMException("runtime timeout", "TimeoutError")).kind !== "timeout" ||
      describeSourceFailure(new SourceHttpError(503)).status !== 503) throw new Error("Native source failure classification failed");
    let now = Date.parse("2026-11-17T08:30:00Z"), fail = false, calls = 0;
    const service = new MarketService(async code => {
      calls++;
      if (fail) throw new Error("simulated upstream outage");
      const data = Array.from({ length: 350 }, (_, i) => ({ indexCode: code,
        tradeDate: new Date(Date.parse("2025-01-01") + i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""), close: 100 + i }));
      return parseIndexHistory({ code: "200", data }, code, "2025-01-01", "2026-11-17");
    }, () => now);
    const first = await service.get();
    if (first.series.length !== 310 || first.latest.spread !== 0 || calls !== 2) throw new Error("Native market calculation failed");
    if (first.relative.window !== 242 || first.relative.latest.middle !== 1 || first.regression?.count !== 350) throw new Error("Native ratio BOLL or regression failed");
    const cached = await service.get(true);
    if (!cached.cached || calls !== 2) throw new Error("Native public cache failed");
    const selected = await service.get(false, resolveMarketSelection("H20269"));
    if (selected.selection.a.code !== "H20269" || Number(calls) !== 3 || selected.relative.window !== 242) throw new Error("Native combination selection/cache failed");
    now += 31 * 60_000; fail = true;
    const stale = await service.get();
    if (!stale.stale || stale.latest.date !== first.latest.date) throw new Error("Native stale result retention failed");
    return Response.json({ market: true, window: 40, publicCache: true, staleRetention: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Native market failed" }, { status: 500 }); }
}
