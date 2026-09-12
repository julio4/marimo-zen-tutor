import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import { profileDir, projectDir } from "./session.mjs";
import { MarimoNotebook } from "./marimo.mjs";
import { createTutorDebug } from "./debug.mjs";

export async function listTutorSessions(profile, notebook) {
  let files;
  try { files = await readdir(join(profile, "sessions")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const sessions = [];
  for (const file of files.filter((file) => file.endsWith(".jsonl"))) {
    const path = join(profile, "sessions", file);
    const info = await stat(path);
    if (info.size > 16 * 1024 * 1024) throw new Error("Session too large to inspect safely.");
    const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    if (!entries.some((e) => e.type === "custom" && e.customType === "zen-notebook" && e.data?.path === notebook)) continue;
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string") continue;
    sessions.push({ id: header.id, updatedAt: info.mtime.toISOString() });
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ponytail: one browser connection per launcher; add multi-client arbitration only if needed.
export async function startTutorServer({ notebook, url, port = 3027, profile = profileDir, token = randomBytes(32).toString("hex") }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("Use an explicit loopback marimo URL");
  notebook = await realpath(notebook);
  profile = resolve(profile);
  const origin = new URL(url).origin;
  const adapter = resolve(projectDir, "../pi-acp/dist/index.js");
  await stat(adapter);
  const mapDir = join(profile, "acp", createHash("sha256").update(notebook).digest("hex"));
  await mkdir(mapDir, { recursive: true, mode: 0o700 });
  let activeSocket;
  const debug = createTutorDebug([token, process.env.TUTOR_API_KEY, process.env.MARIMO_TOKEN]);
  const instructions = debug.redact((await Promise.all(["tutor.md", "marimo-guide.md"].map(
    (file) => readFile(new URL(file, import.meta.url), "utf8"),
  ))).join("\n\n"));
  const children = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.origin !== origin || !["/sessions", "/initialize", "/debug", "/debug/pause", "/debug/resume", "/debug/clear"].includes(req.url)) { res.writeHead(403).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.writeHead(204).end(); return;
    }
    if (req.method !== (["/sessions", "/debug"].includes(req.url) ? "GET" : "POST") || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    try {
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/debug")) {
        if (req.url === "/debug/pause") debug.pause(true);
        if (req.url === "/debug/resume") debug.pause(false);
        if (req.url === "/debug/clear") debug.clear();
        res.end(JSON.stringify({ notebook, connected: activeSocket?.readyState === 1, instructions, ...debug.snapshot() })); return;
      }
      if (req.url === "/initialize") {
        const result = await new MarimoNotebook({ url, notebook, token: process.env.MARIMO_TOKEN }).initialize();
        res.end(JSON.stringify(result)); return;
      }
      res.end(JSON.stringify({ notebook, sessions: await listTutorSessions(profile, notebook) }));
    } catch { res.writeHead(500).end(req.url === "/initialize" ? "Cannot initialize the notebook. Put import marimo as mo in its own enabled cell, or run it manually and reconnect." : "Cannot read saved sessions; no new session was created."); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost");
    if (req.headers.origin !== origin || path.pathname !== "/message" || path.searchParams.get("token") !== token || activeSocket) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket) => {
    activeSocket = socket;
    debug.record("lifecycle", { method: "connected" });
    const child = spawn(process.execPath, [adapter], {
      cwd: dirname(notebook), detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_ACP_ISOLATED: "true", PI_ACP_DIR: mapDir,
        PI_CODING_AGENT_DIR: profile, PI_ACP_PI_COMMAND: join(projectDir, "agent/runner.mjs"),
        TUTOR_PROFILE: profile, TUTOR_NOTEBOOK: notebook, TUTOR_URL: url },
    });
    children.add(child);
    const knownSessions = new Set();
    const pending = new Map();
    const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
    // Never mirror arbitrary adapter stderr (it can contain private provider errors).
    child.stderr.resume();
    child.stdin.on("error", () => socket.close(1011, "Tutor process stopped"));
    child.on("error", () => { debug.record("lifecycle", { method: "adapter-error" }); socket.close(1011, "Cannot start ACP adapter"); });
    child.on("exit", () => { children.delete(child); socket.close(); });
    socket.on("close", () => { debug.record("lifecycle", { method: "disconnected" }); activeSocket = undefined; stop(); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        debug.record("agent", message, pending.get(message.id) ?? message.method);
        if (pending.has(message.id)) {
          if (typeof message.result?.sessionId === "string") knownSessions.add(message.result.sessionId);
          pending.delete(message.id);
        }
        if (socket.readyState === 1) socket.send(line);
      } catch { socket.close(1011, "Invalid ACP response"); }
    });
    socket.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
        if (message && typeof message === "object") debug.record("request", message);
        if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error("Invalid request");
        const allowed = ["initialize", "session/new", "session/load", "session/prompt", "session/cancel", "session/set_model", "session/set_mode", "session/set_config_option"];
        if (!allowed.includes(message.method)) throw new Error("Method unavailable in tutor mode");
        const params = message.params;
        if (!params || typeof params !== "object") throw new Error("Missing parameters");
        if (["session/new", "session/load"].includes(message.method)) {
          if (await realpath(params.cwd) !== dirname(notebook)) throw new Error("Notebook directory mismatch");
          params.mcpServers = [];
        }
        if (message.method === "session/load") {
          if (!(await listTutorSessions(profile, notebook)).some((s) => s.id === params.sessionId)) throw new Error("Session does not belong to this notebook");
          knownSessions.add(params.sessionId);
        } else if (message.method.startsWith("session/") && message.method !== "session/new" && !knownSessions.has(params.sessionId)) {
          throw new Error("Unknown notebook session");
        }
        if (message.id !== undefined) pending.set(message.id, message.method);
        child.stdin.write(JSON.stringify(message) + "\n");
      } catch (error) {
        const response = { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32602, message: error.message } };
        debug.record("broker", response, message?.method);
        if (socket.readyState === 1) socket.send(JSON.stringify(response));
      }
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port, token,
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      for (const child of children) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
      await new Promise((done) => server.close(done));
      wss.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { notebook: { type: "string" }, port: { type: "string", default: "2722" }, "agent-port": { type: "string", default: "3027" }, headless: { type: "boolean" } } });
  if (!values.notebook) throw new Error("Pass --notebook path/to/lesson.py");
  const notebook = await realpath(values.notebook);
  const port = Number(values.port), agentPort = Number(values["agent-port"]);
  if (![port, agentPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) || port === agentPort) throw new Error("Choose distinct valid ports");
  const url = `http://127.0.0.1:${port}`;
  const probe = createPortProbe().listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((done) => probe.close(done));
  const broker = await startTutorServer({ notebook, url, port: agentPort });
  const marimo = spawn(resolve(projectDir, "../marimo/.venv/bin/marimo"), ["edit", notebook, "--headless", "--host", "127.0.0.1", "--port", String(port), "--no-token", "--skip-update-check"], { cwd: dirname(notebook), stdio: "inherit" });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; marimo.kill("SIGTERM"); await broker.close(); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  marimo.on("error", async () => { process.exitCode = 1; await close(); });
  marimo.on("exit", async (code) => { if (code) process.exitCode = code; await close(); });
  const launchUrl = `${url}/#zen=${broker.token}&zenPort=${broker.port}`;
  if (!values.headless) {
    const { setTimeout: delay } = await import("node:timers/promises");
    let ready = false;
    for (let i = 0; i < 100 && !closing; i++) {
      try { ready = (await fetch(url + "/health")).ok; } catch {}
      if (ready) break;
      await delay(100);
    }
    if (!ready) { process.exitCode = 1; await close(); throw new Error("marimo did not start"); }
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [launchUrl], { stdio: "ignore" }).on("error", () => console.error("Could not open browser. Use --headless to obtain the launch URL."));
    console.log(`Zen Tutor started at ${url}; use the AI → Agents panel.`);
  } else {
    console.log(`Private launch URL (do not share): ${launchUrl}`);
  }
}
