import { fileURLToPath } from "node:url";
import path from "node:path";
import { LocalDatabase } from "./local-database.mjs";
import { databasePath } from "./runtime-config.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new LocalDatabase(databasePath(), path.join(root, "migrations"));
db.close();
console.log(`单机 SQLite 数据库已初始化：${databasePath()}`);
