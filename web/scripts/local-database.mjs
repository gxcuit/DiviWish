import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Local SQLite adapter with prepared statements and atomic synchronous batches.
export class LocalDatabase {
  constructor(filename, migrations) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    if (this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
      this.sqlite.close();
      throw new Error("检测到账号数据库。请为 DIVIDEND_DATABASE 选择独立的单机 SQLite 文件；不会修改账号数据。");
    }
    this.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)");
    for (const name of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
      if (this.sqlite.prepare("SELECT 1 FROM local_migrations WHERE name=?").get(name)) continue;
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.exec(readFileSync(path.join(migrations, name), "utf8"));
        this.sqlite.prepare("INSERT INTO local_migrations(name) VALUES(?)").run(name);
        this.sqlite.exec("COMMIT");
      } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    }
  }
  prepare(sql) {
    return new LocalStatement(this.sqlite, sql);
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

class LocalStatement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new LocalStatement(this.sqlite, this.sql, values); }
  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.values) ?? null;
    return column && row ? row[column] : row;
  }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values), success: true, meta: {} }; }
  execute() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : [];
    const info = statement.columns().length ? this.sqlite.prepare("SELECT changes() AS changes,last_insert_rowid() AS id").get() : statement.run(...this.values);
    return { success: true, results, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? info.id) } };
  }
  async run() { return this.execute(); }
}
