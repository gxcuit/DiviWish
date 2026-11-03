import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = path.join(root, ".local/launcher");
const lockFile = path.join(stateDir, "running.json");
const installFile = path.join(root, "node_modules/.diviwish-install.json");
const buildFile = path.join(stateDir, "build.json");
const platform = `${process.platform}-${process.arch}-${process.versions.modules}`;
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const remove = file => { try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } };
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}
function fingerprint(names, context) {
  const hash = createHash("sha256").update(context);
  for (const name of names) {
    const file = path.join(root, name);
    const inputs = existsSync(file) ? statSync(file).isDirectory() ? files(file) : [file] : [];
    hash.update(JSON.stringify([name, inputs.length]));
    for (const input of inputs) hash.update(JSON.stringify(path.relative(root, input))).update(readFileSync(input));
  }
  return hash.digest("hex");
}
function npmPath() {
  const bin = path.dirname(process.execPath);
  const candidates = [process.env.npm_execpath, path.join(bin, "node_modules/npm/bin/npm-cli.js"), path.resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    try { candidates.push(realpathSync(path.join(directory, "npm"))); } catch { /* Try the next PATH entry. */ }
  }
  const cli = candidates.find(file => file?.endsWith("npm-cli.js") && existsSync(file));
  if (!cli) throw new Error("未找到 npm，请安装包含 npm 的 Node.js 24+，并重新打开终端。");
  return cli;
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(result.signal ? "操作已中止，未继续启动。" : `上一步失败（退出码 ${result.status}），未继续启动。`);
    error.exitCode = result.status || 1;
    throw error;
  }
}
function lock() {
  mkdirSync(stateDir, { recursive: true });
  if (existsSync(lockFile)) {
    const previous = readJson(lockFile);
    if (!previous || previous.platform !== process.platform || !Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error("此工作目录已有启动锁；请确认另一终端或系统的启动器已退出，再删除 .local/launcher/running.json 重试。");
    try { process.kill(previous.pid, 0); throw new Error("此工作目录已在安装、构建或运行，请使用原终端，避免重复启动。"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    remove(lockFile);
  }
  const descriptor = openSync(lockFile, "wx");
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, platform: process.platform })); }
  finally { closeSync(descriptor); }
  process.on("exit", () => { if (readJson(lockFile)?.pid === process.pid) remove(lockFile); });
}
async function checkPort() {
  const { parseEnv } = await import("node:util");
  const local = path.join(root, ".env.local");
  const env = existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {};
  const port = Number((process.env.WEB_PORT ?? env.WEB_PORT) || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("WEB_PORT 须为 0 至 65535 的整数。");
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", error => reject(new Error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请使用已有服务，或修改 WEB_PORT 后重试。` : `无法使用端口 ${port}：${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve()));
  });
}
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24 或更新版本，请安装后重新运行。");
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !["--prepare", "--rebuild", "--reinstall", "--help"].includes(flag))) throw new Error("未知参数。可用：--prepare、--rebuild、--reinstall、--help。");
  if (flags.has("--help")) {
    console.log("DiviWish 一键启动：自动安装依赖、webpack 构建并启动。\n--prepare 仅安装和构建\n--rebuild 强制重新构建\n--reinstall 重新安装依赖并构建");
    return;
  }
  const npm = npmPath();
  lock();
  if (!flags.has("--prepare")) await checkPort();
  const installKey = fingerprint(["package.json", "package-lock.json", ".npmrc"], platform);
  const probe = existsSync(installFile) && spawnSync(process.execPath, ["-e", "require('next/package.json');require('lightningcss');require('@tailwindcss/oxide')"], { cwd: root, stdio: "ignore" }).status === 0;
  const install = flags.has("--reinstall") || readJson(installFile)?.key !== installKey || !probe;
  if (install) {
    console.log("正在安装当前系统所需的依赖（npm ci）…");
    remove(installFile); remove(buildFile);
    run([npm, "ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"]);
    writeFileSync(installFile, JSON.stringify({ key: installKey }));
  } else console.log("依赖未变化，复用当前系统的已安装依赖。");
  const publicEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("NEXT_PUBLIC_")).sort(([a], [b]) => a.localeCompare(b)));
  const buildKey = fingerprint(["src", "public", "next.config.ts", "next.config.js", "next.config.mjs", "postcss.config.mjs", "tsconfig.json", "package.json", "package-lock.json", "scripts/build.mjs", ".env", ".env.local", ".env.production", ".env.production.local"], JSON.stringify({ installKey, node: process.versions.node, publicEnv, nodeEnv: process.env.NODE_ENV }));
  const saved = readJson(buildFile);
  const complete = saved?.key === buildKey && Array.isArray(saved.files) && saved.files.includes("discovery.html") && saved.files.every(file => existsSync(path.join(root, "out", file)));
  if (install || flags.has("--rebuild") || !complete) {
    console.log("正在构建静态页面（webpack）…");
    remove(buildFile);
    run([npm, "run", "build"]);
    const output = files(path.join(root, "out")).map(file => path.relative(path.join(root, "out"), file));
    if (!output.includes("discovery.html")) throw new Error("构建未生成发现页，未继续启动。");
    writeFileSync(buildFile, JSON.stringify({ key: buildKey, files: output }));
  } else console.log("源码与构建配置未变化，复用已有静态页面。");
  if (flags.has("--prepare")) { console.log("安装与构建已完成，可以运行 run.cmd / run.sh 启动。"); return; }
  console.log("正在启动 DiviWish；按 Ctrl+C 停止。");
  const local = path.join(root, ".env.local");
  if (existsSync(local)) process.loadEnvFile(local);
  process.chdir(root);
  await import("./preview.mjs");
}
main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = error.exitCode || 1; });
