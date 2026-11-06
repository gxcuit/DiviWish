import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Copy the installed, lockfile-resolved parser dependency closure, excluding Next.js. */
export async function packageRuntimeDependencies(root, destination) {
  const copied = new Map();
  async function copy(name, from) {
    const require = createRequire(path.join(from, "package.json"));
    let directory = path.dirname(require.resolve(name));
    let manifest;
    while (directory !== path.dirname(directory)) {
      const value = await readFile(path.join(directory, "package.json"), "utf8").catch(() => null);
      if (value) { const candidate = JSON.parse(value); if (candidate.name === name) { manifest = candidate; break; } }
      directory = path.dirname(directory);
    }
    if (!manifest) throw new Error(`Cannot locate runtime dependency ${name}`);
    // Preserve nested versions exactly as npm installed them; flattening the
    // closure can replace a dependency with another package's incompatible version.
    const relative = path.relative(path.join(root, "node_modules"), directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Runtime dependency outside this project's node_modules: ${name}`);
    if (copied.has(relative)) return;
    copied.set(relative, manifest.version);
    const target = path.join(destination, "node_modules", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(directory, target, { recursive: true, filter: source => path.basename(source) !== "node_modules" });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await copy(dependency, directory);
  }
  for (const name of ["unpdf", "linkedom"]) await copy(name, root);
  return Object.fromEntries(copied);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const destination = path.resolve(root, process.argv[2] ?? ".local/runtime-dependencies");
  const versions = await packageRuntimeDependencies(root, destination);
  console.log(`Packaged ${Object.keys(versions).length} forecast parser packages from the installed lockfile.`);
}
