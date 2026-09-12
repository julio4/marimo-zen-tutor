#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const agentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(agentDir, "../..");
const profile = resolve(process.env.ZEN_HOME || join(homedir(), ".zen"));
const env = { ...process.env, TUTOR_PROFILE: profile };

async function launchNotebook(command, args) {
  const notebook = await realpath(command);
  if (!notebook.endsWith(".py")) throw new Error("Choose a marimo .py notebook.");
  const { values } = parseArgs({ args, options: { port: { type: "string" }, "agent-port": { type: "string" }, headless: { type: "boolean" } } });
  if (!process.env.TUTOR_API_KEY) {
    const credentials = JSON.parse(await readFile(join(profile, "auth.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }));
    if (!Object.keys(credentials).length) throw new Error("Authenticate first with zen auth (or zen auth --from /path/to/auth.json).");
  }
  const flags = Object.entries(values).flatMap(([key, value]) => value === true ? [`--${key}`] : value === undefined ? [] : [`--${key}`, value]);
  return run(process.execPath, [join(agentDir, "serve.mjs"), "--notebook", notebook, ...flags]);
}

function run(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("exit", (code, signal) => { cleanup(); done(code ?? (signal ? 1 : 0)); });
  });
}

async function auth(args) {
  const { values } = parseArgs({ args, options: {
    from: { type: "string" }, provider: { type: "string", default: process.env.TUTOR_PROVIDER || "openai-codex" },
    "api-key": { type: "boolean" },
  } });
  if (values.from && values["api-key"]) throw new Error("Choose --from or --api-key, not both.");
  if (values.from) return run(process.execPath, [join(agentDir, "import-auth.mjs"), "--from", resolve(values.from), "--provider", values.provider]);
  if (!process.stdin.isTTY) throw new Error("Run zen auth in an interactive terminal, or use zen auth --from /path/to/auth.json.");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath: join(profile, "auth.json"), modelsPath: join(profile, "models.json"),
    modelsStorePath: join(profile, "models-store.json"), allowModelNetwork: false,
    signal: AbortSignal.timeout(15_000),
  });
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  input.on("SIGINT", () => controller.abort());
  input.on("close", () => controller.abort());
  const terminate = () => controller.abort();
  process.on("SIGTERM", terminate);
  try {
    await runtime.login(values.provider, values["api-key"] ? "api_key" : "oauth", {
      signal: controller.signal,
      async prompt(prompt) {
        console.log(prompt.message);
        if (prompt.type === "select") prompt.options.forEach((option, index) => console.log(`${index + 1}. ${option.label}`));
        muted = prompt.type === "secret" || prompt.type === "manual_code";
        try {
          const answer = await input.question("> ", { signal: prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal });
          if (prompt.type !== "select") return answer.trim();
          const choice = prompt.options[Number(answer) - 1] ?? prompt.options.find((option) => option.id === answer);
          if (!choice) throw new Error("Invalid login option.");
          return choice.id;
        } finally { if (muted) console.log(); muted = false; }
      },
      notify(event) {
        if (event.type === "auth_url") {
          console.log(`Open this login URL (do not share):\n${event.url}`);
          if (event.instructions) console.log(event.instructions);
          spawn(process.platform === "darwin" ? "open" : "xdg-open", [event.url], { stdio: "ignore" }).on("error", () => {});
        } else if (event.type === "device_code") {
          console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
        } else console.log(event.message);
      },
    });
    await chmod(join(profile, "auth.json"), 0o600);
    console.log(`Authenticated ${values.provider}. Credentials saved privately in ${profile}.`);
    return 0;
  } finally { input.close(); process.off("SIGTERM", terminate); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(`Zen Tutor\n\n  zen auth [--provider NAME] [--api-key | --from FILE]\n  zen notebook.py [--port 2722] [--agent-port 3027] [--headless]\n  zen init [notebook.py] [--port 2722] [--agent-port 3027] [--headless]\n  zen pip install PACKAGE...\n\nProfile: ${profile}\nModel settings: ${join(profile, "config.json")} or TUTOR_PROVIDER / TUTOR_MODEL / TUTOR_THINKING.\nSet EXA_API_KEY before launch for teaching-source search.\nPython libraries are shared by notebooks in this Zen installation.`);
  } else if (command === "auth") {
    process.exitCode = await auth(args);
  } else if (command === "pip") {
    if (args[0] !== "install" || args.length < 2) throw new Error("Usage: zen pip install PACKAGE...");
    process.exitCode = await run("uv", ["pip", "install", "--python", join(root, "marimo/.venv/bin/python"), ...args.slice(1)]);
  } else if (command === "init") {
    const filename = args[0] && !args[0].startsWith("--") ? args.shift() : "learning.py";
    const { initNotebook } = await import("./learning.mjs");
    const notebook = await initNotebook(filename, profile);
    console.log(`Created ${notebook}. Describe your goal in the setup chat, then approve the proposed plan.`);
    process.exitCode = await launchNotebook(notebook, args);
  } else {
    process.exitCode = await launchNotebook(command, args);
  }
} catch (error) {
  console.error(error.name === "AbortError" ? "Cancelled." : error.message);
  process.exitCode = 1;
}
