#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runRpcMode } from "@earendil-works/pi-coding-agent";
import { createTutor } from "./session.mjs";

const { values } = parseArgs({ options: {
  url: { type: "string", default: process.env.TUTOR_URL || "http://127.0.0.1:2718" },
  notebook: { type: "string", default: process.env.TUTOR_NOTEBOOK },
  resume: { type: "string" },
  session: { type: "string" },
  mode: { type: "string" },
  "no-themes": { type: "boolean" },
  inspect: { type: "boolean", default: false },
  prompt: { type: "string" },
} });

try {
  if (!values.notebook) throw new Error("Pass --notebook /absolute/path/to/notebook.py (open in marimo).");
  const { runtime, connection } = await createTutor({
    url: values.url, notebook: resolve(values.notebook), resume: values.resume || values.session,
    profile: process.env.TUTOR_PROFILE,
    token: process.env.MARIMO_TOKEN,
    provider: process.env.TUTOR_PROVIDER, modelId: process.env.TUTOR_MODEL, thinking: process.env.TUTOR_THINKING,
  });
  if (values.inspect) {
    try {
      console.log(JSON.stringify({
        tools: runtime.session.agent.state.tools.map((tool) => tool.name),
        contextFiles: runtime.services.resourceLoader.getAgentsFiles().agentsFiles,
        notebook: await connection.inspect(),
      }, null, 2));
    } finally { await runtime.dispose(); }
  } else if (values.prompt) {
    try {
      runtime.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
      });
      await runtime.session.prompt(values.prompt);
      const last = runtime.session.messages.findLast((message) => message.role === "assistant");
      if (last?.stopReason === "error" || last?.stopReason === "aborted") throw new Error(last.errorMessage || last.stopReason);
      process.stdout.write("\n");
      console.error(`Resume: --resume ${runtime.session.sessionFile}`);
    } finally { await runtime.dispose(); }
  } else {
    // Pi's native JSONL protocol: prompt, abort, get_state, streamed events, etc.
    await runRpcMode(runtime);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
