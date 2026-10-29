import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKline, parseQuotes, parseSearch, quoteDate, symbolFor } from "../providers.ts";
import { sampleStocks } from "./helpers.ts";

test("Tencent search filters unsupported securities, decodes JSON escapes and keeps leading code zeros", () => {
  const content = "sh~601088~中国神华~zgsh~GP-A^hk~01088~中国神华~zgsh~GP^us~csuay~中国神华~zgsh~GP^sh~601088~中国神华~zgsh~GP-A^sh~510300~基金~jj~ETF^sz~200002~万科B~wkb~GP-B";
  assert.deepEqual(parseSearch("v_hint=" + JSON.stringify(content)), [
    { name: "中国神华", code: "601088", market: "A" }, { name: "中国神华", code: "01088", market: "HK" },
  ]);
  assert.deepEqual(parseSearch('v_hint="N"'), []); assert.throws(() => parseSearch("unexpected"));
});

test("quotes require valid provider trade dates and prices; timestamps and symbols retain market identity", () => {
  assert.equal(quoteDate("20261020153000"), "2026-10-20"); assert.equal(quoteDate("2026/10/20 16:00:00"), "2026-10-20");
  assert.equal(quoteDate("20260230000000"), null); assert.equal(quoteDate("missing"), null);
  assert.equal(symbolFor({ market: "HK", code: "00728" }), "hk00728"); assert.equal(symbolFor({ market: "A", code: "920001" }), "bj920001");
  const fields = Array(33).fill(""); fields[3] = "9"; fields[30] = "20261021153000"; fields[32] = "-1";
  const result = parseQuotes(`v_sh600001="${fields.join("~")}"`, sampleStocks());
  assert.deepEqual(result.quotes.get(1), { price: 9, change_pct: -0.01, quote_date: "2026-10-21" }); assert.equal(result.errors.length, 1);
  fields[30] = "bad"; assert.equal(parseQuotes(`v_sh600001="${fields.join("~")}"`, sampleStocks()).quotes.size, 0);
});

test("K-lines preserve native timeframe and adjustment labels, sort dates, reject conflicting duplicates and invalid closes", () => {
  const [a, hk] = sampleStocks();
  const result = parseKline({ code: 0, data: { hk00001: {
    qfqmonth: [["2026-10-23", "51", "52"], ["2026-09-30", "50", "51.5"]],
    qt: { hk00001: ["", "", "", "52", ...Array(26).fill(""), "2026/10/23 16:08:14"] },
  } } }, hk, "month");
  assert.equal(result.adjustment, "qfq"); assert.equal(result.bars[1].close, 52); assert.equal(result.quote?.quote_date, "2026-10-23");
  assert.equal(parseKline({ data: { sh600001: { day: [["2026-10-23", "40", "42"]] } } }, a, "day").adjustment, "none");
  for (const rows of [[["2026-10-23", "40", "NaN"]], [["2026-10-23", "40", "42"], ["2026-10-23", "40", "43"]], [["2026-02-30", "40", "42"]]]) {
    assert.throws(() => parseKline({ data: { sh600001: { day: rows } } }, a, "day"));
  }
});
