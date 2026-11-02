import assert from "node:assert/strict";
import { test } from "node:test";
import { inferSecurityCode, resolveSecurityQuery } from "../../src/features/dividends/security-identity.ts";

test("complete security codes infer ETF, equity, market and exchange without form selectors", () => {
  for (const code of ["510050", "510880", "515180", "512890", "588000"]) assert.deepEqual(inferSecurityCode(code), { code, instrument_type: "etf", market: "A", exchange: "sh" });
  for (const code of ["159220", "159331", "159915"]) assert.equal(inferSecurityCode(code)?.exchange, "sz");
  assert.deepEqual(inferSecurityCode(" 601088 "), { code: "601088", instrument_type: "stock", market: "A", exchange: "sh" });
  assert.equal(inferSecurityCode("000001")?.exchange, "sz");
  assert.equal(inferSecurityCode("920001")?.exchange, "bj");
  assert.deepEqual(inferSecurityCode("00700"), { code: "00700", instrument_type: "stock", market: "HK", exchange: "hk" });
  for (const value of ["", "51088x", "51088x;alert(1)", "基金", "508000", "900001", "1234567"]) assert.equal(inferSecurityCode(value), null);
});

test("name lookup resolves unique matches while duplicate A/H names require an explicit result", () => {
  const a = { code: "601088", market: "A" as const, name: "中国神华" }, hk = { code: "01088", market: "HK" as const, name: "中国神华" };
  assert.equal(resolveSecurityQuery("中国神华", [a, hk]), null);
  assert.deepEqual(resolveSecurityQuery("中国神华", [a]), a);
  assert.equal(resolveSecurityQuery("unknown", []), null);
  assert.deepEqual(resolveSecurityQuery("601088", [a, hk]), { ...a, instrument_type: "stock", exchange: "sh" });
  assert.deepEqual(resolveSecurityQuery("159331", []), { name: "159331", code: "159331", market: "A", instrument_type: "etf", exchange: "sz" });
  assert.equal(resolveSecurityQuery("159331", [{ code: "159331", name: "红利港股ETF国泰", market: "A" }])?.name, "红利港股ETF国泰");
});
