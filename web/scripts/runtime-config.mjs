import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function databasePath() {
  return path.resolve(root, process.env.DIVIDEND_DATABASE || ".local/standalone/diviwish.sqlite3");
}
