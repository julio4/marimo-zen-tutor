// Explicit one-time credential import. Never load the source profile at runtime.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { profileDir } from "./session.mjs";

const { values } = parseArgs({ options: { from: { type: "string" }, provider: { type: "string", default: "openai-codex" } } });
try {
  if (!values.from) throw new Error("Pass --from /path/to/auth.json explicitly.");
  const source = JSON.parse(await readFile(values.from, "utf8"));
  const credential = source[values.provider];
  if (!credential || !["oauth", "api_key"].includes(credential.type)) throw new Error("Provider credential not found.");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const target = join(profileDir, "auth.json");
  const existing = await readFile(target, "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; });
  if (Object.keys(JSON.parse(existing)).length) throw new Error("Tutor auth already contains credentials; refusing to overwrite it.");
  await writeFile(target, JSON.stringify({ [values.provider]: credential }, null, 2) + "\n", { mode: 0o600 });
  await chmod(target, 0o600);
  console.log(`Imported only ${values.provider} into the private tutor profile. Source unchanged.`);
} catch (error) {
  console.error(error.code === "EEXIST" ? "Tutor auth already exists; refusing to overwrite it." : error.message);
  process.exitCode = 1;
}
