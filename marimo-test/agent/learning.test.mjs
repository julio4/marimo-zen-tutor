import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { initNotebook, learningController, ONBOARDING_CODE } from "./learning.mjs";
import { MarimoNotebook } from "./marimo.mjs";

test("learning generation requires exact approval and replaces only the original setup cell", { timeout: 30_000 }, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "zen-learning-")));
  const profile = join(temp, "profile");
  const notebook = await initNotebook(join(temp, "lesson.py"), profile);
  const original = await readFile(notebook, "utf8");
  await assert.rejects(initNotebook(notebook, profile), /EEXIST/);
  assert.equal(await readFile(notebook, "utf8"), original);
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.MARIMO_TEST_EXECUTABLE || resolve("marimo/.venv/bin/marimo"), ["edit", notebook, "--headless", "--no-token", "--host", "127.0.0.1", "--port", String(port), "--skip-update-check"], { cwd: temp, stdio: "ignore" });
  const exited = once(server, "exit");
  let socket;
  t.after(async () => { socket?.close(); server.kill("SIGTERM"); await exited; await rm(temp, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/health")).ok) break; } catch {}
    await delay(100);
  }
  socket = new WebSocket(`${url.replace("http:", "ws:")}/ws?session_id=learning-test`);
  await once(socket, "open");
  const connection = new MarimoNotebook({ url, notebook });
  for (let i = 0; i < 100; i++) {
    try { await connection.inspect(); break; } catch { await delay(100); }
  }
  await connection.initializeLearning(ONBOARDING_CODE);
  const initial = await connection.inspect();
  const controller = await learningController(profile, notebook, connection);
  const plan = await controller.update("propose", { goal: "Understand averages", prerequisites: "Addition", outline: ["Predict", "Explore"] });
  const sections = [
    { kind: "explanation", text: "Compare the three equally sized groups: **●● | ●● | ●●**", choices: [] },
    { kind: "practice", text: "What changes if we add another group?", choices: ["The count", "Nothing"] },
    { kind: "exercise", text: "Try a small example of your own.", choices: [] },
  ];
  await assert.rejects(controller.update("generate", { planId: plan.planId, revision: initial.revision, sections }), /approve/);
  await assert.rejects(controller.update("approve", { planId: "stale" }), /changed/);
  await controller.update("approve", { planId: plan.planId });
  await assert.rejects(connection.addHint({ after: initial.cells[0].id, revision: initial.revision, text: "Premature hint" }), /goal approval/);
  const response = await fetch(url + "/api/kernel/execute", {
    method: "POST", headers: { "Content-Type": "application/json", "Marimo-Session-Id": "learning-test" },
    body: JSON.stringify({ code: 'import marimo._code_mode as cm\nasync with cm.get_context() as ctx:\n    ctx.create_cell("student_value = 42", after=ctx.cells[0].id)' }),
  });
  assert.match(await response.text(), /"success":\s*true/);
  await assert.rejects(controller.update("generate", { planId: plan.planId, revision: initial.revision, sections }), /Notebook changed/);
  const before = await connection.inspect();
  const finished = await controller.update("generate", { planId: plan.planId, revision: before.revision, sections });
  assert.equal(finished.phase, "complete");
  const after = await connection.inspect();
  assert.ok(!after.cells.some((cell) => cell.code.includes("data-zen-onboarding")));
  const student = before.cells.find((cell) => cell.code === "student_value = 42");
  assert.equal(after.cells.find((cell) => cell.id === student.id).code, student.code);
  assert.ok(after.cells.some((cell) => cell.code.includes("mo.ui.radio")));
  assert.ok(after.cells.some((cell) => cell.code.includes("# Your turn")));
  assert.ok(after.cells.every((cell) => cell.errors.length === 0));
  await controller.update("generate", { planId: plan.planId });
  assert.equal((await connection.inspect()).cells.length, after.cells.length);
  assert.equal((await learningController(profile, notebook, connection)).get().phase, "complete");
  // Recover if the lesson was applied but its completion receipt was lost.
  const record = join(profile, "learning", (await readdir(join(profile, "learning"))).find((name) => name.endsWith(".json")));
  await writeFile(record, JSON.stringify({ ...finished, phase: "approved" }));
  const recovered = await learningController(profile, notebook, connection);
  await recovered.update("initialize", {});
  assert.equal(recovered.get().phase, "complete");
  assert.equal((await connection.inspect()).cells.length, after.cells.length);
});
