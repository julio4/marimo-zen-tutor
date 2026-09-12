import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("CLI works outside the checkout and explicitly imports private, isolated credentials", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "zen-cli-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const profile = join(temp, "profile with spaces");
  const cli = process.env.ZEN_TEST_CLI || fileURLToPath(new URL("cli.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: temp, env: { ...process.env, ZEN_HOME: profile, TUTOR_API_KEY: "" }, encoding: "utf8",
  });
  assert.match(run("--help").stdout, /zen notebook.py/);
  await writeFile(join(temp, "lesson.py"), "import marimo\n");
  assert.match(run("lesson.py").stderr, /Authenticate first/);
  assert.match(run("auth").stderr, /interactive terminal/);
  const original = JSON.stringify({ "openai-codex": { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 0 }, other: { type: "api_key", key: "excluded" } });
  await writeFile(join(temp, "source.json"), original);
  const imported = run("auth", "--from", "source.json");
  assert.equal(imported.status, 0, imported.stderr);
  assert.doesNotMatch(imported.stdout + imported.stderr, /fake-access|fake-refresh|excluded/);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(profile, "auth.json"), "utf8"))), ["openai-codex"]);
  assert.equal((await stat(join(profile, "auth.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(temp, "source.json"), "utf8"), original);
  assert.equal(run("auth", "--from", "source.json").status, 1);
  assert.equal(run("lesson.py", "--unknown").status, 1);
  assert.match(run("lesson.py", "--port", "invalid").stderr, /distinct valid ports/);
  const initialized = run("init", "new lesson.py", "--port", "invalid");
  assert.match(initialized.stdout, /Created/);
  const setup = await readFile(join(temp, "new lesson.py"), "utf8");
  assert.match(setup, /data-zen-onboarding/);
  assert.equal(run("init", "new lesson.py").status, 1);
  assert.equal(await readFile(join(temp, "new lesson.py"), "utf8"), setup);
});

test("installed CLI launches a notebook from another directory without contacting a model", { skip: !process.env.ZEN_TEST_CLI, timeout: 30_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "zen-launch-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(join(temp, "lesson.py"), await readFile(new URL("../notebooks/averages.py", import.meta.url)));
  const reserve = async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  };
  const notebookPort = await reserve(), brokerPort = await reserve();
  const port = notebookPort.address().port, agentPort = brokerPort.address().port;
  await Promise.all([notebookPort, brokerPort].map((server) => new Promise((done) => server.close(done))));
  const child = spawn(process.execPath, [process.env.ZEN_TEST_CLI, "lesson.py", "--headless", "--port", String(port), "--agent-port", String(agentPort)], {
    cwd: temp, env: { ...process.env, ZEN_HOME: join(temp, "profile"), TUTOR_API_KEY: "fake-no-model-request" }, stdio: "ignore",
  });
  const exited = once(child, "exit");
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "Installed notebook server starts outside the checkout");
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html/);
});
