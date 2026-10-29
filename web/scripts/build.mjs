import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit", env: { ...process.env, DIVIWISH_STATIC_EXPORT: "1" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
