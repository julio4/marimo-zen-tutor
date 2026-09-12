import assert from "node:assert/strict";
import { test } from "node:test";
import { createTutorDebug } from "./debug.mjs";

test("diagnostics redact, bound, pause and clear without replaying discarded events", () => {
  const debug = createTutorDebug(["launch-capability"]);
  debug.record("request", { id: "launch-capability", method: "session/prompt", params: { token: "private-token", prompt: 'Bearer bearer-secret api_key="embedded-secret" launch-capability sk-test-secret', password: "hidden" } });
  const serialized = JSON.stringify(debug.snapshot());
  for (const secret of ["launch-capability", "private-token", "bearer-secret", "embedded-secret", "sk-test-secret", "hidden"]) assert.ok(!serialized.includes(secret), secret);
  assert.ok(serialized.includes("REDACTED"));
  debug.record("agent", { params: { update: { sessionUpdate: "tool_call_update", status: "failed", rawOutput: "Expected revision mismatch", content: { type: "image", data: "private-base64" } } } });
  assert.match(debug.snapshot().events.at(-1).text, /Expected revision mismatch/);
  assert.doesNotMatch(debug.snapshot().events.at(-1).text, /private-base64/);
  for (let i = 0; i < 300; i++) debug.record("agent", { id: i, result: "x".repeat(40000) }, "session/prompt");
  assert.ok(debug.snapshot().events.length <= 200);
  assert.ok(debug.snapshot().events.reduce((n, e) => n + e.text.length, 0) <= 1000000);
  assert.equal(debug.snapshot().events[0].truncated, true);
  assert.ok(debug.snapshot().dropped > 0);
  debug.pause(true);
  const before = JSON.stringify(debug.snapshot());
  debug.record("agent", { method: "ignored" });
  assert.equal(JSON.stringify(debug.snapshot()), before);
  debug.clear();
  assert.deepEqual(debug.snapshot(), { paused: true, dropped: 0, events: [], latestPrompt: null, configuration: null });
  debug.pause(false); debug.record("agent", { method: "resumed" });
  assert.equal(debug.snapshot().events.length, 1);
});
