import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const result = spawnSync(process.execPath, [next, "build", "--webpack"], {
  cwd: root, stdio: "inherit", env: { ...process.env, DIVIWISH_STATIC_EXPORT: "1" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
