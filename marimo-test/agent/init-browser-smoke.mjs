// Deterministic UI + real notebook mutation check. No provider credentials or model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "../../marimo/frontend/node_modules/@playwright/test/index.mjs";
import { initNotebook } from "./learning.mjs";
import { MarimoNotebook } from "./marimo.mjs";
import { startTutorServer } from "./serve.mjs";

const temp = await realpath(await mkdtemp(join(tmpdir(), "zen-init-browser-")));
const profile = join(temp, "profile");
const notebook = await initNotebook(join(temp, "lesson.py"), profile);
const reserve = createServer().listen(0, "127.0.0.1"); await once(reserve, "listening");
const port = reserve.address().port; await new Promise((done) => reserve.close(done));
const url = `http://127.0.0.1:${port}`;
let browser, broker, server;
try {
  broker = await startTutorServer({ notebook, profile, url, port: 0 });
  const request = async (action, data) => {
    const response = await fetch(`http://127.0.0.1:${broker.port}/learning${action ? "/" + action : ""}`, {
      method: action ? "POST" : "GET", headers: { Origin: url, Authorization: `Bearer ${broker.token}`, "Content-Type": "application/json" }, body: action ? JSON.stringify(data) : undefined,
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  server = spawn(resolve("marimo/.venv/bin/marimo"), ["edit", notebook, "--headless", "--no-token", "--host", "127.0.0.1", "--port", String(port), "--skip-update-check"], { cwd: temp, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/health")).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket(`ws://127.0.0.1:${broker.port}/message*`, (socket) => {
    socket.onMessage(async (raw) => {
      const message = JSON.parse(String(raw)); requests.push(message);
      const result = (value) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
      if (message.method === "initialize") result({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
      else if (message.method === "session/new") result({ sessionId: "learning-session" });
      else if (message.method === "session/prompt") {
        try {
          const state = await request("");
          if (state.phase === "approved") {
            const current = await new MarimoNotebook({ url, notebook }).inspect();
            await request("generate", { planId: state.planId, revision: current.revision, sections: [
              { kind: "explanation", text: "Compare equally sized groups: ●● | ●● | ●●", choices: [] },
              { kind: "practice", text: "What does counting groups tell us?", choices: ["How many groups", "Their color"] },
              { kind: "exercise", text: "Make your own small example.", choices: [] },
            ] });
          } else await request("propose", { goal: "Understand averages", prerequisites: "Addition", outline: ["Compare groups", "Try an example"] });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "learning-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let's explore averages together." } } } }));
          result({ stopReason: "end_turn" });
        } catch (error) { errors.push(String(error)); socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } })); }
      } else result({});
    });
  });
  await page.goto(`${url}/#zen=${broker.token}&zenPort=${broker.port}&zenInit=1`);
  const setup = page.getByRole("region", { name: "Learning setup", exact: true });
  await expect(setup).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".mo-agent-panel")).not.toBeVisible();
  await setup.getByRole("textbox", { name: "Your learning goal" }).fill("I want to understand averages.");
  await setup.getByRole("button", { name: "Send", exact: true }).click();
  await expect(setup.getByText("Proposed goal: Understand averages")).toBeVisible({ timeout: 15_000 });
  assert.equal((await request("")).phase, "planning");
  await expect(setup.getByRole("button", { name: "Start learning", exact: true })).toBeEnabled();
  await setup.getByRole("button", { name: "Start learning", exact: true }).click();
  await expect(setup).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await request("")).phase).toBe("complete");
  assert.equal(requests.filter((message) => message.method === "session/new").length, 1);
  assert.equal(requests.filter((message) => message.method === "session/prompt").length, 2);
  assert.deepEqual(errors, []);
  console.log("Inline setup chat, explicit approval, lesson generation and one shared background session passed.");
} finally {
  await browser?.close(); await broker?.close();
  if (server) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
  await rm(temp, { recursive: true, force: true });
}
