// Generate reviewable patch artifacts; never stage a nested checkout or its secrets.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "forks/pins.json"), "utf8"));
const git = (cwd, args, allowed = [0]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (!allowed.includes(result.status)) throw new Error(result.stderr || "git failed");
  return result.stdout;
};
for (const name of Object.keys(pins)) {
  const checkout = join(root, name);
  if (git(checkout, ["rev-parse", "HEAD"]).trim() !== pins[name].commit) throw new Error(`${name}: update the pin deliberately before snapshotting a new base.`);
  const paths = name === "marimo" ? ["frontend/src"] : ["src", "test"];
  let patch = git(checkout, ["diff", "--binary", "HEAD", "--", ...paths]);
  const files = git(checkout, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0").filter(Boolean);
  for (const file of files) {
    patch += git(checkout, ["diff", "--no-index", "--binary", "--", "/dev/null", file], [0, 1]);
  }
  writeFileSync(join(root, "forks", `${name}.patch`), patch);
  console.log(`${name}: ${Buffer.byteLength(patch)} bytes of source/test changes`);
}
