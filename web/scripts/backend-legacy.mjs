import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.DIVIDEND_PYTHON || path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
if (!existsSync(python)) {
  console.error("Python environment missing. Run setup.cmd first.");
  process.exit(1);
}
const child = spawn(python, ["-m", "backend.app"], { cwd: root, stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code || 0; });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
