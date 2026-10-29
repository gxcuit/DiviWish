import { fileURLToPath } from "node:url";
import path from "node:path";
import { LocalD1 } from "./local-d1.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new LocalD1(path.join(root, ".local/accounts/diviwish.sqlite3"), path.join(root, "migrations"));
db.close();
console.log("本地账号数据库迁移完成；原个人数据库保持不变。");
