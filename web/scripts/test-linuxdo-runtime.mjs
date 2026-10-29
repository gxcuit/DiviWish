import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".local"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".local/linuxdo-workerd-"));
const config = path.join(temporary, "wrangler.json"), state = path.join(temporary, "state");
const cli = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const testVars = { APP_ORIGIN: "https://native.example.test", AUTH_EMAIL_MODE: "resend", AUTH_SECRET: "test-only-".repeat(8),
  TURNSTILE_SITE_KEY: "test-site", TURNSTILE_SECRET_KEY: "test-secret", LINUXDO_CLIENT_ID: "test-client", LINUXDO_CLIENT_SECRET: "test-secret" };
// The bundled native binary can lag the production compatibility date. Keep
// the application's date unchanged and state the local test date explicitly.
const appDate = JSON.parse(await readFile(path.join(root, "wrangler.jsonc"), "utf8")).compatibility_date;
const wranglerRequire = createRequire(cli);
const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
const version = JSON.parse(await readFile(miniflareRequire.resolve("workerd/package.json"), "utf8")).version;
const release = version.match(/^(?:0|1)\.(\d{4})(\d{2})(\d{2})\./);
assert.ok(release, "Cannot determine the installed workerd release date");
const nativeDate = `${release[1]}-${release[2]}-${release[3]}`;
const testDate = appDate < nativeDate ? appDate : nativeDate;
let child, logs = "";
try {
  await writeFile(config, JSON.stringify({ name: "diviwish-linuxdo-runtime-test", main: path.join(root, "worker/tests/runtime/linuxdo.ts"),
    compatibility_date: testDate, vars: testVars,
    d1_databases: [{ binding: "DB", database_name: "linuxdo-runtime-test", database_id: "00000000-0000-0000-0000-000000000099",
      remote: false, migrations_dir: path.join(root, "migrations") }] }));
  // Prevent loading any real application secrets during this isolated test.
  await writeFile(path.join(temporary, ".dev.vars"), Object.entries(testVars).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  const migration = spawnSync(process.execPath, [cli, "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", state], {
    cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  child = spawn(process.execPath, [cli, "dev", "--local", "--config", config, "--persist-to", state, "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  let response;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`workerd exited: ${logs.slice(-6000)}`);
    try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); } catch { /* Starting up. */ }
    if (response) break;
    await delay(500);
  }
  assert.ok(response, `workerd did not start: ${logs.slice(-6000)}`);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(result, { runtime: "workerd", callback: true, session: true, portfolio: true, replayRejected: true, providerRedirectsRejected: true });
  console.log(`Native workerd OAuth (${testDate}; production ${appDate}) passed: callback, session, D1 portfolio, replay and provider redirects. Only temporary data and simulated provider responses used.`);
} finally {
  if (child?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
