// Opt-in live model check: node agent/browser-smoke.mjs (uses this tutor's credentials).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "../../marimo/frontend/node_modules/@playwright/test/index.mjs";
import { startTutorServer } from "./serve.mjs";
import { profileDir, projectDir } from "./session.mjs";
import { MarimoNotebook } from "./marimo.mjs";

const temp = await realpath(await mkdtemp(join(tmpdir(), "zen-browser-")));
const notebook = join(temp, "lesson.py"), profile = join(temp, "profile");
await copyFile(join(projectDir, "notebooks/averages.py"), notebook);
// Make competing AI features eligible so hidden controls are a real tutor-mode check.
await writeFile(join(temp, ".marimo.toml"), '[ai]\nenabled = true\n[ai.models]\nchat_model = "openai/zen-test-no-network"\nedit_model = "openai/zen-test-no-network"\nautocomplete_model = "openai/zen-test-no-network"\n[completion]\ncopilot = "custom"\n');
await mkdir(profile, { mode: 0o700 });
await copyFile(join(profileDir, "auth.json"), join(profile, "auth.json"));
const reserve = createServer().listen(0, "127.0.0.1"); await once(reserve, "listening");
const port = reserve.address().port; await new Promise((done) => reserve.close(done));
const url = `http://127.0.0.1:${port}`;
let broker, browser, server;
try {
  broker = await startTutorServer({ notebook, profile, url, port: 0 });
  const enableCapture = await fetch(`http://127.0.0.1:${broker.port}/debug/resume`, {
    method: "POST", headers: { Origin: url, Authorization: `Bearer ${broker.token}` },
  });
  assert.equal(enableCapture.status, 200);
  server = spawn(resolve(projectDir, "../marimo/.venv/bin/marimo"), ["edit", notebook, "--headless", "--no-token", "--host", "127.0.0.1", "--port", String(port), "--skip-update-check"], { cwd: temp, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/health")).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], sent = [], received = [];
  const genericAiRequests = [];
  page.on("request", (request) => {
    if (/\/api\/ai\/(completion|chat|inline_completion|invoke_tool)/.test(request.url())) genericAiRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/message")) return;
    ws.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload))));
    ws.on("framereceived", ({ payload }) => received.push(JSON.parse(String(payload))));
  });
  await page.goto(`${url}/#zen=${broker.token}&zenPort=${broker.port}`);
  const input = page.locator(".mo-agent-panel .cm-content[contenteditable=true]");
  await input.waitFor({ timeout: 30_000 });
  await expect.poll(() => received.some((m) => m.result?.sessionId), { timeout: 30_000 }).toBe(true);
  console.log("Native panel connected");
  if (process.env.ZEN_DEBUG_UI_ONLY) {
    await page.getByTestId("footer-panel").click();
    await page.getByText("Tutor", { exact: true }).click();
    await page.keyboard.press("Escape");
    const diagnostics = page.getByRole("region", { name: "Tutor diagnostics" });
    await diagnostics.getByText("Latest submitted context", { exact: true }).waitFor();
    await page.screenshot({ path: join(profileDir, "tutor-debug-opening.png") });
    await diagnostics.hover();
    await page.mouse.wheel(0, 260);
    await diagnostics.getByText("Latest submitted context", { exact: true }).click();
    await page.screenshot({ path: join(profileDir, "tutor-debug-opening.png") });
  } else {
  const notebookConnection = new MarimoNotebook({ notebook, url });
  assert.equal((await notebookConnection.initialize()).ran, false, "Page connection already ran the shared import");
  const initial = await notebookConnection.inspect();
  const hint = await notebookConnection.addHint({ after: initial.cells[0].id, revision: initial.revision, text: "Startup hint without running the notebook." });
  assert.equal((await notebookConnection.inspect()).cells.find((c) => c.id === hint.cell_id).status, "idle");
  const sessions = await (await fetch(url + "/api/sessions")).json();
  const sessionId = Object.keys(sessions)[0];
  const execute = (code) => fetch(url + "/api/kernel/execute", { method: "POST", headers: { "Content-Type": "application/json", "Marimo-Session-Id": sessionId }, body: JSON.stringify({ code }) }).then((r) => r.text());
  await execute("import marimo._code_mode as cm; help(cm)");
  assert.match(await execute("import marimo._code_mode as cm\nasync with cm.get_context() as ctx:\n    for cell in ctx.cells:\n        ctx.run_cell(cell.id)"), /"success":\s*true/);
  const before = await readFile(notebook, "utf8");
  const prompt = async (text) => {
    const count = sent.filter((m) => m.method === "session/prompt").length;
    await input.fill(text); await input.press("Enter");
    await expect.poll(() => sent.filter((m) => m.method === "session/prompt").length, { timeout: 10_000 }).toBe(count + 1);
    const request = sent.findLast((m) => m.method === "session/prompt");
    await expect.poll(() => received.find((m) => m.id === request.id), { timeout: 120_000 }).toBeTruthy();
    const response = received.find((m) => m.id === request.id);
    assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
    return request.params.sessionId;
  };
  const first = await prompt("Inspect my mean attempt. Give one guiding question without solving it; do not add or edit any cells.");
  const second = await prompt("Keep helping with a short guiding question, without stating the answer or editing cells.");
  assert.equal(first, second);
  assert.equal(await readFile(notebook, "utf8"), before);
  assert.ok(received.some((m) => m.params?.update?.sessionUpdate === "tool_call"));
  console.log("Two model turns and notebook inspection passed; original source unchanged");
  const live = await notebookConnection.inspect();
  const student = live.cells.find((cell) => cell.code.includes("mean ="));
  const cell = page.locator(`#cell-${student.id}`);
  const editor = cell.locator(".cm-content[contenteditable=true]").first();
  const draft = "# Unrun learner draft\nmean = sum(values) / 4\nmean";
  await editor.fill(draft);
  await editor.press("ControlOrMeta+Shift+e");
  await expect(page.getByText("Refactor with AI", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate with AI", exact: true })).toHaveCount(0);
  const help = cell.getByRole("button", { name: "Help me think", exact: true });
  await help.focus();
  await expect(help).toBeFocused();
  await page.screenshot({ path: join(profileDir, "tutor-cell-help.png") });
  const promptCount = sent.filter((m) => m.method === "session/prompt").length;
  await help.press("Enter");
  await expect.poll(() => sent.filter((m) => m.method === "session/prompt").length, { timeout: 15_000 }).toBe(promptCount + 1);
  const helpRequest = sent.findLast((m) => m.method === "session/prompt");
  const helpText = helpRequest.params.prompt[0].text;
  const helpContext = JSON.parse(helpText.slice(helpText.indexOf("{")));
  assert.equal(helpRequest.params.sessionId, first);
  assert.equal(helpContext.cellId, student.id);
  assert.equal(helpContext.draft.text, draft);
  assert.equal(helpContext.lastRunSource.text, student.code);
  assert.equal(helpContext.draftNotRun, true);
  assert.match(helpContext.outputFromPreviousExecution.text, /7\.5/);
  await expect.poll(() => received.find((m) => m.id === helpRequest.id), { timeout: 120_000 }).toBeTruthy();
  assert.equal(received.find((m) => m.id === helpRequest.id).result?.stopReason, "end_turn");
  const withHint = await notebookConnection.inspect();
  assert.ok(withHint.cells.some((c) => !live.cells.some((old) => old.id === c.id) && c.code.includes("A small hint")), "Help should create a hint cell");
  await expect(editor.locator(".cm-line")).toHaveText(draft.split("\n"));
  await editor.press("ControlOrMeta+s");
  await expect.poll(async () => (await readFile(notebook, "utf8")).includes("mean = sum(values) / 4"), { timeout: 10_000 }).toBe(true);
  for (const original of live.cells.filter((c) => c.id !== student.id)) {
    assert.equal(withHint.cells.find((c) => c.id === original.id).code, original.code);
  }
  assert.deepEqual(genericAiRequests, []);
  await page.screenshot({ path: join(profileDir, "tutor-cell-hint.png") });
  await expect(page.getByText("Cell context sent to tutor", { exact: true })).toHaveCount(0);
  console.log("Keyboard Help sent the unrun draft and old output, added a hint, and preserved student work; no generic AI requests");
  await page.getByTestId("footer-panel").click();
  await page.getByText("Tutor", { exact: true }).click();
  // Escape leaves the upstream tab list's accessible drag mode, if activated.
  await page.keyboard.press("Escape");
  const diagnostics = page.getByRole("region", { name: "Tutor diagnostics" });
  await expect(diagnostics).toBeVisible();
  await page.screenshot({ path: join(profileDir, "tutor-debug-opening.png") });
  await diagnostics.getByText("Latest submitted context", { exact: true }).click();
  await expect(diagnostics).toContainText("Unrun learner draft", { timeout: 10_000 });
  await diagnostics.getByText("Latest observed session/model/thinking configuration", { exact: true }).click();
  await expect(diagnostics).toContainText(first);
  await expect(diagnostics).toContainText("medium");
  const debugUrl = `http://127.0.0.1:${broker.port}/debug`;
  const debugSnapshot = () => fetch(debugUrl, { headers: { Origin: url, Authorization: `Bearer ${broker.token}` } }).then((r) => r.json());
  const snapshot = await debugSnapshot();
  assert.equal(snapshot.latestPrompt.requestId, String(helpRequest.id));
  assert.ok(snapshot.events.some((e) => e.kind === "tool_call_update"));
  assert.ok(!JSON.stringify(snapshot).includes(broker.token));
  await page.screenshot({ path: join(profileDir, "tutor-debug.png") });
  await input.fill("/export"); await input.press("Enter");
  await expect.poll(async () => (await debugSnapshot()).events.some((e) => e.text.includes("unavailable in the isolated tutor")), { timeout: 10_000 }).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  const downloadPromise = page.waitForEvent("download");
  await diagnostics.getByRole("button", { name: "Export diagnostics" }).click();
  const download = await downloadPromise;
  const exported = await readFile(await download.path(), "utf8");
  assert.ok(!exported.includes(broker.token));
  assert.match(exported, /session\/prompt/);
  await diagnostics.getByRole("button", { name: "Pause capture" }).click();
  await expect(diagnostics).toContainText("Capture paused");
  await diagnostics.getByRole("button", { name: "Clear diagnostics" }).click();
  await expect(diagnostics).toContainText("No events retained.");
  await diagnostics.getByRole("button", { name: "Enable capture" }).click();
  await page.route(debugUrl, (route) => route.fulfill({ status: 503, body: "offline" }));
  await expect(diagnostics.getByRole("alert")).toContainText("HTTP 503", { timeout: 10_000 });
  await page.unroute(debugUrl);
  await expect(diagnostics.getByRole("alert")).toHaveCount(0, { timeout: 10_000 });
  console.log("Tutor debug tab verified request IDs, context/config, tool/error events, export, pause/clear/resume and offline recovery");
  await page.reload();
  await input.waitFor({ timeout: 30_000 });
  await expect.poll(() => sent.some((m) => m.method === "session/load" && m.params.sessionId === first), { timeout: 30_000 }).toBe(true);
  await expect(page.getByText("Inspect my mean attempt.", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(profileDir, "tutor-connected.png") });
  const newRequests = sent.filter((m) => m.method === "session/new").length;
  const sessionsUrl = `http://127.0.0.1:${broker.port}/sessions`;
  await page.route(sessionsUrl, (route) => route.fulfill({ json: { notebook, sessions: [{ id: "missing-session", updatedAt: new Date().toISOString() }] } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Session does not belong", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Retry resume", exact: true })).toBeVisible();
  assert.equal(sent.filter((m) => m.method === "session/new").length, newRequests);
  await page.unroute(sessionsUrl);
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();
  await input.waitFor({ timeout: 30_000 });
  await expect.poll(() => sent.filter((m) => m.method === "session/new").length, { timeout: 30_000 }).toBe(newRequests + 1);
  assert.deepEqual(errors, []);
  console.log("Reload/resume replay passed; failed resume did not reset history; explicit Start fresh passed");
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Help me think", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate with AI", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Tutor", { exact: true })).toHaveCount(0);
  console.log("Ordinary editor retains its generic AI entry point and has no tutor Help buttons");
  }
} finally {
  await browser?.close(); await broker?.close();
  if (server && server.exitCode === null) { const exited = once(server, "exit"); server.kill("SIGTERM"); await exited; }
  await rm(temp, { recursive: true, force: true });
}
