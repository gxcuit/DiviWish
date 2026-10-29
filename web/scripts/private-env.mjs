import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function readPrivateEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}
export function setPrivateValue(file, key, value) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(file, pattern.test(text) ? text.replace(pattern, () => line) : `${text.trimEnd()}\n${line}\n`, { mode: 0o600 });
}
