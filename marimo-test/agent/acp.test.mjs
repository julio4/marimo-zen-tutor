import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { startTutorServer, listTutorSessions } from "./serve.mjs";
import { createTutor } from "./session.mjs";

test("ACP notebook binding, isolated resources, two requests and resume", { timeout: 30_000 }, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "zen-acp-")));
  const profile = join(temp, "profile");
  const notebook = join(temp, "lesson.py");
  const other = join(temp, "other.py");
  const url = "http://127.0.0.1:2722";
  await writeFile(notebook, "# test notebook");
  await writeFile(other, "# other notebook");
  await mkdir(join(temp, ".pi/prompts"), { recursive: true });
  await writeFile(join(temp, ".pi/prompts/leak.md"), "PROFILE_MUST_NOT_LEAK");
  await writeFile(join(temp, ".pi/settings.json"), '{"quietStartup":false}');
  await mkdir(profile, { mode: 0o700 });
  // No model calls: slash commands exercise transport with a fake, unexpired credential.
  await writeFile(join(profile, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000, accountId: "test-account" } }), { mode: 0o600 });
  let broker, socket;
  t.after(async () => {
    socket?.terminate(); await broker?.close();
    await rm(temp, { recursive: true, force: true });
  });
  async function seed(path) {
    const { runtime } = await createTutor({ url, notebook: path, profile });
    runtime.session.sessionManager.appendMessage({ role: "user", content: "Remember my attempt.", timestamp: Date.now() });
    runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "What does the denominator represent?" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const id = runtime.session.sessionId;
    await runtime.dispose(); return id;
  }
  const savedId = await seed(notebook), foreignId = await seed(other);
  broker = await startTutorServer({ notebook, url, port: 0, profile });
  const endpoint = `http://127.0.0.1:${broker.port}`;
  const debugRequest = (action = "") => fetch(endpoint + "/debug" + action, { method: action ? "POST" : "GET", headers: { Origin: url, Authorization: `Bearer ${broker.token}` } }).then((r) => r.json());
  assert.equal((await fetch(endpoint + "/debug")).status, 403);
  const preflight = await fetch(endpoint + "/learning/approve", { method: "OPTIONS", headers: { Origin: url, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
  assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/i);
  assert.equal((await fetch(endpoint + "/learning/approve", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: '{}' })).status, 403);
  assert.equal((await debugRequest()).paused, true);
  assert.deepEqual((await debugRequest()).events, []);
  await debugRequest("/resume");
  assert.equal((await fetch(endpoint + "/debug/clear", { method: "POST", headers: { Origin: url } })).status, 403);
  const forbidden = new WebSocket(endpoint.replace("http", "ws") + `/message?token=${broker.token}`, { origin: "http://evil.invalid" });
  await assert.rejects(once(forbidden, "open"), /403/);
  assert.equal((await fetch(endpoint + "/sessions")).status, 403);
  assert.equal((await fetch(endpoint + "/sessions", { headers: { Origin: "http://evil.invalid", Authorization: `Bearer ${broker.token}` } })).status, 403);
  const saved = await (await fetch(endpoint + "/sessions", { headers: { Origin: url, Authorization: `Bearer ${broker.token}` } })).json();
  assert.deepEqual(saved.sessions.map((s) => s.id), [savedId]);
  assert.equal((await listTutorSessions(profile, notebook)).length, 1);
  const events = [], pending = new Map();
  let sequence = 0;
  async function connect() {
    socket = new WebSocket(endpoint.replace("http", "ws") + `/message?token=${broker.token}`, { origin: url });
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      events.push(message);
      pending.get(message.id)?.(message); pending.delete(message.id);
    });
    await once(socket, "open");
  }
  const request = async (method, params) => {
    const id = ++sequence;
    const response = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const result = await response;
    if (result.error) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.data ?? "")}`);
    return result.result;
  };
  await connect();
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(init.authMethods, []);
  await assert.rejects(request("session/load", { sessionId: foreignId, cwd: temp, mcpServers: [] }), /belong/);
  await request("session/load", { sessionId: savedId, cwd: temp, mcpServers: [] });
  assert.match(JSON.stringify(events), /Remember my attempt/);
  assert.doesNotMatch(JSON.stringify(events), /PROFILE_MUST_NOT_LEAK/);
  for (let i = 0; i < 2; i++) {
    assert.equal((await request("session/prompt", { sessionId: savedId, prompt: [{ type: "text", text: "/session" }] })).stopReason, "end_turn");
  }
  const commands = events.flatMap((m) => m.params?.update?.availableCommands ?? []);
  assert.equal(commands.some((command) => command.name === "export" || command.name === "leak"), false);
  await assert.rejects(request("session/prompt", { sessionId: savedId, prompt: [{ type: "text", text: "/export" }] }), /unavailable/);
  await assert.rejects(request("session/delete", { sessionId: savedId }), /unavailable/);
  const observed = await debugRequest();
  assert.ok(observed.events.some((e) => e.direction === "broker" && e.method === "session/delete"));
  assert.ok(observed.events.some((e) => e.direction === "agent" && e.requestId === String(sequence - 1)));
  assert.match(observed.latestPrompt.text, /session\/prompt/);
  assert.doesNotMatch(JSON.stringify(observed), /test-access|test-refresh/);
  await debugRequest("/pause");
  await debugRequest("/clear");
  await request("session/prompt", { sessionId: savedId, prompt: [{ type: "text", text: "/session" }] });
  assert.equal((await debugRequest()).events.length, 0);
  await debugRequest("/resume");
  const fresh = await request("session/new", { cwd: temp, mcpServers: [] });
  assert.notEqual(fresh.sessionId, savedId);
  assert.equal((await listTutorSessions(profile, notebook)).some((s) => s.id === savedId), true);
  const closed = once(socket, "close"); socket.close(); await closed;
  await connect();
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await request("session/load", { sessionId: savedId, cwd: temp, mcpServers: [] });
  assert.equal((await request("session/prompt", { sessionId: savedId, prompt: [{ type: "text", text: "/session" }] })).stopReason, "end_turn");
});
