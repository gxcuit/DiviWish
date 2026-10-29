import { scrypt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { HttpError } from "./http.ts";

// OWASP's memory/CPU trade-off: N=2^14, r=8, p=5 (16 MiB memory).
// Each password has an independent 128-bit salt. This module is server-only.
const OPTIONS = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const PREFIX = "scrypt$16384$8$5";
const DUMMY = `${PREFIX}$${"00".repeat(16)}$${"00".repeat(32)}`;

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || [...value].length <= 6) {
    throw new HttpError(400, "密码需要大于 6 个字符");
  }
  return value; // Spaces and Unicode are preserved; no trimming or truncation.
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, OPTIONS, (error, key) => { if (error) reject(error); else resolve(key); });
  });
}

export async function hashPassword(password: unknown): Promise<string> {
  const validated = validatePassword(password);
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return `${PREFIX}$${salt.toString("hex")}$${(await derive(validated, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const encoded = stored ?? DUMMY;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts.slice(0, 4).join("$") !== PREFIX || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  const actual = await derive(password, Buffer.from(parts[4], "hex"));
  const valid = timingSafeEqual(actual, Buffer.from(parts[5], "hex"));
  return stored !== null && valid;
}
