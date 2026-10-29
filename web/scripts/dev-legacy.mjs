import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const python = process.env.DIVIDEND_PYTHON || path.join(root, ".venv", windows ? "Scripts/python.exe" : "bin/python");
if (!existsSync(python)) {
  console.error("Python environment missing. Run setup.cmd first (see README.md for macOS/Linux).");
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (windows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}
function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, API_URL: process.env.FLASK_API_URL || "http://127.0.0.1:5000", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" } });
  children.push(child);
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code || 0); });
}
start(python, ["-m", "backend.app"]);
start(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3000"]);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log("\nDividend dashboard: http://localhost:3000/discovery\nPress Ctrl+C to stop both services.\n");
