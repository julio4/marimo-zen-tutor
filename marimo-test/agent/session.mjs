import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createAgentSessionRuntime, createExtensionRuntime,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MarimoNotebook, notebookTools } from "./marimo.mjs";

export const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const profileDir = join(projectDir, ".tutor");

// Explicit resource loader: no discovery or execution of machine/project profiles.
export function tutorResources(prompt) {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createTutor({ url, notebook, token, provider, modelId, thinking, resume, profile = profileDir }) {
  const config = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
  provider ??= config.provider;
  modelId ??= config.model;
  thinking ??= config.thinking;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("Invalid thinking level.");
  const notebookPath = await realpath(notebook);
  const cwd = dirname(notebookPath);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const sessionDir = join(profile, "sessions");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(profile, "auth.json"),
    modelsPath: join(profile, "models.json"),
    modelsStorePath: join(profile, "models-store.json"),
    allowModelNetwork: false,
    signal: AbortSignal.timeout(15_000),
  });
  if (process.env.TUTOR_API_KEY) {
    if (!provider) throw new Error("Set TUTOR_PROVIDER when using TUTOR_API_KEY.");
    await modelRuntime.setRuntimeApiKey(provider, process.env.TUTOR_API_KEY);
  }
  const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
  if ((provider || modelId) && !model) throw new Error("Set a valid TUTOR_PROVIDER and TUTOR_MODEL together.");
  const prompt = (await Promise.all(["./tutor.md", "./marimo-guide.md"].map(
    (file) => readFile(new URL(file, import.meta.url), "utf8"),
  ))).join("\n\n");
  const connection = new MarimoNotebook({ url, notebook: notebookPath, token });
  const customTools = notebookTools(connection);
  const resourceLoader = tutorResources(prompt);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  let sessionManager = SessionManager.create(cwd, sessionDir);
  if (resume) {
    const path = await realpath(resume);
    if (dirname(path) !== await realpath(sessionDir)) throw new Error("Resume only a session from this tutor profile.");
    sessionManager = SessionManager.open(path, sessionDir, cwd);
  }
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    if (dirname(resolve(sessionManager.getSessionFile())) !== resolve(sessionDir)) throw new Error("Session must stay inside this tutor profile.");
    const entries = sessionManager.getEntries();
    const binding = entries.find((e) => e.type === "custom" && e.customType === "zen-notebook");
    if (binding ? binding.data?.path !== notebookPath : entries.some((e) => e.type === "message")) {
      throw new Error("Session belongs to a different notebook or was not created by this tutor.");
    }
    if (!binding) sessionManager.appendCustomEntry("zen-notebook", { path: notebookPath });
    const result = await createAgentSession({
      cwd, agentDir: profile, modelRuntime, model, thinkingLevel: thinking, resourceLoader, settingsManager,
      sessionManager, sessionStartEvent,
      tools: customTools.map((tool) => tool.name), customTools,
    });
    return { ...result, services: { cwd, agentDir: profile, modelRuntime, resourceLoader, settingsManager, diagnostics: [] }, diagnostics: [] };
  }, { cwd, agentDir: profile, sessionManager });
  return { runtime, connection, modelRuntime };
}
