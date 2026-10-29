import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalDatabase } from "../../scripts/local-database.mjs";

const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));

test("local SQLite migrates and persists one portfolio; failed batches roll back", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "diviwish-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "single.sqlite3");
  let db = new LocalDatabase(filename, migrations);
  try {
    await db.prepare("INSERT INTO sectors(name) VALUES(?)").bind("银行").run();
    await assert.rejects(db.batch([
      db.prepare("INSERT INTO sectors(name) VALUES(?)").bind("应回滚"),
      db.prepare("INSERT INTO sectors(name) VALUES(?)").bind("银行"),
    ]));
    assert.equal(await db.prepare("SELECT * FROM sectors WHERE name='应回滚'").first(), null);
    db.close(); db = new LocalDatabase(filename, migrations);
    assert.ok(await db.prepare("SELECT * FROM sectors WHERE name='银行'").first());
    assert.equal((await db.prepare("SELECT count(*) AS n FROM local_migrations").first())!.n, 1);
    assert.equal(await db.prepare("SELECT * FROM sqlite_master WHERE name='users'").first(), null);
  } finally { db.close(); }
});

test("pointing at an account database is rejected without changing its bytes", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "diviwish-account-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "accounts.sqlite3");
  const original = new DatabaseSync(filename);
  original.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('keep-me');"); original.close();
  const before = readFileSync(filename);
  assert.throws(() => new LocalDatabase(filename, migrations), /检测到账号数据库/);
  assert.deepEqual(readFileSync(filename), before);
});
