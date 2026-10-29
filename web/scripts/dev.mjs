import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exitCode = code;
}
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  children.push(child);
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code || 0); });
}
start([path.join(root, "scripts/backend.mjs")]);
start([path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", process.env.WEB_PORT || "3000"]);
process.on("SIGINT", () => stop()); process.on("SIGTERM", () => stop());
console.log(`\nDiviWish: http://localhost:${process.env.WEB_PORT || "3000"}/discovery\n仅本地运行；不会部署到 Cloudflare。\n`);
