import assert from "node:assert/strict";
import { test } from "node:test";
import { gridLevels, yieldGrid } from "../calculations.ts";
import { fixture, sampleStocks } from "./helpers.ts";

test("sell yields descend exactly from their own start and prices rise with the opposite trigger", () => {
  const [stock, hk] = sampleStocks();
  const settings = { grid_sell_start: 0.06, grid_sell_end: 0.04, grid_step: 0.005 };
  const rows = yieldGrid({ ...stock, ...settings }, 0.8, "sell");
  assert.deepEqual(rows.map(row => row.yield), [0.06, 0.055, 0.05, 0.045, 0.04]);
  assert.deepEqual(rows.map(row => row.reached), [true, true, true, false, false]);
  assert.ok(rows.every((row, index) => index === 0 || row.price! > rows[index - 1].price!));
  assert.deepEqual(gridLevels({ ...settings, grid_step: 0.006 }, "sell"), [0.06, 0.054, 0.048, 0.042]);
  assert.deepEqual(gridLevels({ ...settings, grid_sell_end: 0.06 }, "sell"), [0.06]);
  assert.equal(gridLevels({ grid_sell_start: 0.201, grid_sell_end: 0.001, grid_step: 0.001 }, "sell").length, 201);
  assert.deepEqual(gridLevels({ grid_sell_start: 5e-7, grid_sell_end: 1e-7, grid_step: 1e-7 }, "sell"), [5e-7, 4e-7, 3e-7, 2e-7, 1e-7]);
  const hkRows = yieldGrid({ ...hk, ...settings }, 0.8, "sell");
  assert.ok(Math.abs(hkRows[0].price! - 0.5 / 0.8 / 0.06) < 1e-12);
  assert.equal(yieldGrid({ ...hk, ...settings }, null, "sell")[0].reached, null);
  assert.equal(yieldGrid({ ...stock, ...settings, annual_dividend: null }, 0.8, "sell")[0].price, null);
  assert.equal(yieldGrid({ ...stock, ...settings, price: null }, 0.8, "sell")[0].reached, null);
  const custom = yieldGrid({ ...hk, ...settings, yield_basis: "custom", custom_dividend: 0.48 }, null, "sell");
  assert.equal(custom[0].price, hk.price); assert.equal(custom[0].reached, true);
  const rolling = yieldGrid({ ...stock, ...settings, yield_basis: "rolling" }, 0.8, "sell");
  assert.equal(rolling[0].price, 10); assert.equal(rolling[0].reached, true);
});

test("sell settings are saved per stock; invalid edits leave both grids unchanged", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  const before = await (await f.request("/api/stocks/1")).json();
  const settings = { grid_sell_start: 0.06, grid_sell_end: 0.04 };
  assert.equal((await f.request("/api/stocks/1", "PATCH", settings)).status, 200);
  const detail = await (await f.request("/api/stocks/1")).json();
  assert.deepEqual(detail.yield_grid, before.yield_grid);
  assert.deepEqual(detail.sell_yield_grid.map((row: { yield: number }) => row.yield), [0.06, 0.055, 0.05, 0.045, 0.04]);
  assert.equal(detail.grid_sell_start, settings.grid_sell_start);
  assert.equal(detail.grid_sell_end, settings.grid_sell_end);
  assert.equal((await (await f.request("/api/stocks/2")).json()).grid_sell_start, 0.04);
  for (const invalid of [
    { grid_sell_start: 0 }, { grid_sell_end: -0.01 }, { grid_sell_start: 1.1 },
    { grid_sell_start: true }, { grid_sell_end: "0.03" }, { grid_sell_start: null },
    { grid_sell_start: 0.03 }, { grid_sell_end: 0.07 },
    { grid_sell_start: 1, grid_sell_end: 0.001, grid_step: 0.001, grid_start: 0.03, grid_end: 0.03 },
  ]) {
    assert.equal((await f.request("/api/stocks/1", "PATCH", invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.deepEqual(await (await f.request("/api/stocks/1")).json(), detail);
});


test("legacy stock documents gain sell defaults without changing saved buy settings", async t => {
  const f = fixture(); t.after(() => f.db.sqlite.close());
  f.db.sqlite.prepare("UPDATE stocks SET document=json_remove(json_set(document, '$.grid_start', 0.04, '$.grid_end', 0.06), '$.grid_sell_start', '$.grid_sell_end') WHERE id=1").run();
  const detail = await (await f.request("/api/stocks/1")).json();
  assert.equal(detail.grid_start, 0.04); assert.equal(detail.grid_end, 0.06);
  assert.equal(detail.grid_sell_start, 0.04); assert.equal(detail.grid_sell_end, 0.02);
  assert.deepEqual(detail.sell_yield_grid.map((row: { yield: number }) => row.yield), [0.04, 0.035, 0.03, 0.025, 0.02]);
  assert.equal((await f.request("/api/stocks/1", "PATCH", { watched: true })).status, 200);
});
