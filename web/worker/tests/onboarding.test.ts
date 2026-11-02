import assert from "node:assert/strict";
import { test } from "node:test";
import { document, initialize, rawStocks } from "../database.ts";
import { validate } from "../validation.ts";
import { TestDatabase } from "./helpers.ts";

test("fresh standalone portfolios start with CMB and a Shanghai ETF exactly once", async t => {
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  await initialize(db.binding);
  const first = await rawStocks(db.binding);
  assert.deepEqual(first.map(row => row.code), ["600036", "510880"]);
  assert.equal(first[0].sector, "银行"); assert.equal(first[1].sector, "ETF");
  assert.equal(first[1].instrument_type, "etf"); assert.equal(first[1].exchange, "sh"); assert.equal(first[1].yield_basis, "rolling");
  assert.ok(first.every(row => row.price === null && row.annual_dividend === null && !row.watched));
  await initialize(db.binding); assert.deepEqual(await rawStocks(db.binding), first);
  db.sqlite.exec("DELETE FROM stocks"); await initialize(db.binding);
  assert.deepEqual(await rawStocks(db.binding), []);
});

test("existing standalone stocks and previously emptied portfolios are never seeded or reclassified", async t => {
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  const stock = validate({ code: "600036", name: "自定义名称", market: "A", sector: "我的板块", price: 12.3, watched: true });
  db.sqlite.prepare("INSERT INTO stocks(code,market,name,sector,watched,document) VALUES(?,?,?,?,?,?)").run(stock.code, stock.market, stock.name, stock.sector, 1, document(stock));
  const before = db.sqlite.prepare("SELECT * FROM stocks").all();
  await initialize(db.binding); assert.deepEqual(db.sqlite.prepare("SELECT * FROM stocks").all(), before);
  assert.ok(db.sqlite.prepare("SELECT 1 FROM sectors WHERE name='ETF'").get());
  db.sqlite.exec("DELETE FROM stocks; DELETE FROM sectors WHERE name='ETF'");
  await initialize(db.binding); assert.equal((await rawStocks(db.binding)).length, 0);
  assert.equal(db.sqlite.prepare("SELECT 1 FROM sectors WHERE name='ETF'").get(), undefined);
});

test("starter insert failures roll back the entire initialization and can safely retry", async t => {
  const db = new TestDatabase(); t.after(() => db.sqlite.close());
  db.sqlite.exec("CREATE TRIGGER fail_etf BEFORE INSERT ON stocks WHEN NEW.code='510880' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(initialize(db.binding), /test failure/);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM stocks").get()!.n, 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM metadata").get()!.n, 0);
  db.sqlite.exec("DROP TRIGGER fail_etf"); await initialize(db.binding);
  assert.equal((await rawStocks(db.binding)).length, 2);
});
