import assert from "node:assert/strict";
import { test } from "node:test";
import { derive, gridLevels, number, yieldGrid, yieldStatus } from "../calculations.ts";
import { sampleStocks } from "./helpers.ts";

const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("annual, rolling, HK FX, saved coefficients, A/H premium and empirical inverse quantiles match Flask", () => {
  const [a, hk] = sampleStocks();
  const result = derive(a, 0.8);
  near(result.dividend_yield, 0.05); near(result.rolling_yield, 0.06); near(result.percentile, 0.75);
  near(result.quantile_60_yield as number, 0.05); near(result.quantile_90_price as number, 0.5 / 0.06);
  const h = derive(hk, 0.8, { "600001": 10 });
  near(h.dividend_yield, 0.5 / (8 * 0.8)); near(h.target_price, 12.5);
  near(h.ah_premium, 10 / (8 * 0.8) - 1); near(h.connect_yield, 0.5 / (8 * 0.8) * 0.72);
  near(h.hk_net_yield, 0.5 / (8 * 0.8) * 0.9);
  assert.equal(derive({ ...hk, connect_factor: null }, 0.8).connect_yield, null);
  assert.equal(derive(hk, null).dividend_yield, null);
  assert.equal(derive({ ...a, annual_dividend: null }, 0.8).dividend_yield, null);
  const short = derive({ ...a, history: a.history.slice(0, 59) }, 0.8);
  assert.equal(short.percentile_count, 59); assert.equal(short.percentile, null); assert.equal(short.quantile_60_yield, null);
  assert.deepEqual([null, 0, -0.0025, -0.003, -0.0031].map(yieldStatus), ["neutral", "green", "blue", "orange", "neutral"]);
});

test("grid endpoints use decimal arithmetic, custom cash uses trading currency and missing rolling stays unavailable", () => {
  const [a, hk] = sampleStocks();
  assert.deepEqual(gridLevels({ grid_start: 0.03, grid_end: 0.05, grid_step: 0.006 }), [0.03, 0.036, 0.042, 0.048]);
  assert.deepEqual(gridLevels({ grid_start: 1e-7, grid_end: 5e-7, grid_step: 1e-7 }), [1e-7, 2e-7, 3e-7, 4e-7, 5e-7]);
  const missing = { ...a, yield_basis: "rolling" as const, rolling_dividend: null };
  assert.equal(derive(missing, 0.8).selected_yield, null); assert.equal(yieldGrid(missing, 0.8)[0].price, null);
  near(derive({ ...hk, yield_basis: "rolling" }, 0.8).selected_yield, 0.6 / 8 / 0.8);
  const custom = { ...hk, yield_basis: "custom" as const, custom_yield: 0.1 };
  near(derive(custom, null).target_price, 16); near(yieldGrid(custom, null)[0].price, 0.8 / 0.03);
  assert.equal(derive({ ...custom, price: null }, null).target_price, null);
  assert.equal(number(true), null); assert.equal(number("5"), null); assert.equal(number(NaN), null);
});
