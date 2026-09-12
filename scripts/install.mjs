// Build outputs are copied, never linked to the source checkout or its credentials.
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readlink, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = resolve(process.env.ZEN_HOME || join(homedir(), ".zen"));
const bin = resolve(process.env.ZEN_BIN_DIR || join(homedir(), ".local/bin"));
const current = join(profile, "runtime");
const target = join(current, "marimo-test/agent/cli.mjs");
const launcher = join(bin, "zen");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Zen requires Node.js 24 or newer.");
  for (const [path, expected] of [[launcher, target], [current, null]]) {
    const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isSymbolicLink() || (expected ? await readlink(path) !== expected : !(await readlink(path)).startsWith(join(profile, "installs") + "/zen-")))) {
      throw new Error(`Refusing to replace an unrelated path: ${path}`);
    }
  }
  await mkdir(join(profile, "installs"), { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  await mkdir(bin, { recursive: true });
  const installed = await mkdtemp(join(profile, "installs/zen-"));
  for (const name of ["marimo-test", "pi-acp"]) {
    const destination = join(installed, name);
    await mkdir(destination);
    for (const file of ["package.json", "package-lock.json"]) await copyFile(join(root, name, file), join(destination, file));
    if (name === "pi-acp") {
      await cp(join(root, name, "dist"), join(destination, "dist"), { recursive: true });
      await copyFile(join(root, name, "LICENSE"), join(destination, "LICENSE"));
    } else {
      await mkdir(join(destination, "agent"));
      for (const file of await readdir(join(root, name, "agent"))) {
        if (file.endsWith(".test.mjs") || file.endsWith("browser-smoke.mjs")) continue;
        await copyFile(join(root, name, "agent", file), join(destination, "agent", file));
      }
      await chmod(join(destination, "agent/cli.mjs"), 0o755);
      await chmod(join(destination, "agent/runner.mjs"), 0o755);
    }
    run("npm", ["ci", "--omit=dev"], destination);
  }
  run("uv", ["build", "--wheel", "--out-dir", join(installed, "wheels"), join(root, "marimo")]);
  const wheels = (await readdir(join(installed, "wheels"))).filter((name) => name.endsWith(".whl"));
  if (wheels.length !== 1) throw new Error("Expected one marimo wheel.");
  const python = join(installed, "marimo/.venv/bin/python");
  run("uv", ["venv", join(installed, "marimo/.venv"), "--python", "3.13"]);
  run("uv", ["pip", "install", "--python", python, join(installed, "wheels", wheels[0])]);
  run(python, ["-c", "import marimo; from pathlib import Path; assert marimo.__version__ == '0.24.2'; assert (Path(marimo.__file__).parent / '_static/index.html').is_file()"]);
  run(process.execPath, [join(installed, "marimo-test/agent/cli.mjs"), "--help"], installed);
  try { await copyFile(join(root, "marimo-test/agent/config.json"), join(profile, "config.json"), 1); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const next = join(profile, `runtime-${Date.now()}`);
  await symlink(installed, next);
  await rename(next, current);
  try { await symlink(target, launcher); } catch (error) { if (error.code !== "EEXIST") throw error; }
  console.log(`\nInstalled ${launcher}\nRun: zen auth, then zen /path/to/notebook.py\nIf zen is not found, add ${bin} to PATH.\nOlder installations are retained; credentials and sessions are unchanged.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
