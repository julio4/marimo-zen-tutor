import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "forks/pins.json"), "utf8"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
for (const [name, pin] of Object.entries(pins)) {
  const checkout = join(root, name);
  if (!existsSync(checkout)) {
    git(root, "clone", "--no-checkout", pin.url, checkout);
    git(checkout, "checkout", "--detach", pin.commit);
  }
  if (git(checkout, "rev-parse", "HEAD") !== pin.commit) throw new Error(`${name}: unexpected base commit; refusing to change this checkout.`);
  const patch = join(root, "forks", `${name}.patch`);
  if (!existsSync(patch)) continue;
  try {
    git(checkout, "apply", "--reverse", "--check", patch);
    console.log(`${name}: Zen Tutor patch already applied`);
    continue;
  } catch { /* A fresh checkout needs the patch applied. */ }
  try { git(checkout, "apply", "--check", patch); }
  catch { throw new Error(`${name}: patch conflicts with local edits. Preserve your work and resolve manually; nothing was overwritten.`); }
  git(checkout, "apply", patch);
  console.log(`${name}: applied Zen Tutor patch`);
}
