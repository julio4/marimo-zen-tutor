import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const ONBOARDING_HTML = '<div data-zen-onboarding="v1"></div>';
export const ONBOARDING_CODE = `# Zen Tutor learning setup\nmo.Html(${JSON.stringify(ONBOARDING_HTML)})`;
const statePath = (profile, notebook) => join(profile, "learning", createHash("sha256").update(notebook).digest("hex") + ".json");

export async function initNotebook(filename, profile) {
  if (!filename.endsWith(".py")) throw new Error("Choose a .py filename for the new notebook.");
  const notebook = join(await realpath(dirname(resolve(filename))), basename(filename));
  const path = statePath(profile, notebook);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Exclusive creation: never replace a notebook or an earlier learning record.
  const source = `import marimo\n\napp = marimo.App(width="medium", app_title="Start learning")\n\n\n@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n\n\n@app.cell(hide_code=True)\ndef _(mo):\n${ONBOARDING_CODE.split("\n").map((line) => "    " + line).join("\n")}\n    return\n\n\nif __name__ == "__main__":\n    app.run()\n`;
  await writeFile(notebook, source, { flag: "wx" });
  await writeFile(path, JSON.stringify({ notebook, phase: "planning", planId: null, goal: null, prerequisites: "", outline: [] }), { flag: "wx", mode: 0o600 });
  return notebook;
}

export async function learningController(profile, notebook, connection) {
  const path = statePath(profile, notebook);
  let state = JSON.parse(await readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return "null"; throw error; }));
  if (state && state.notebook !== notebook) throw new Error("Learning setup belongs to another notebook.");
  let pending = Promise.resolve();
  const save = async (next) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    state = next;
  };
  return {
    get: () => state,
    update(action, data) {
      const result = pending.then(async () => {
        if (!state) throw new Error("This notebook was not created with zen init.");
        if (action === "initialize") {
          const result = await connection.initializeLearning(ONBOARDING_CODE, undefined, state.phase === "approved" ? state.planId : null);
          if (result.completed) await save({ ...state, phase: "complete", cellIds: result.cell_ids });
          return result;
        } else if (action === "propose") {
          if (state.phase !== "planning") throw new Error("The goal has already been approved.");
          if (typeof data.goal !== "string" || !data.goal.trim() || data.goal.length > 1000 || typeof data.prerequisites !== "string" || data.prerequisites.length > 1500 || !Array.isArray(data.outline) || data.outline.length < 1 || data.outline.length > 6 || data.outline.some((s) => typeof s !== "string" || !s.trim() || s.length > 500)) throw new Error("Provide a concise goal, prerequisites and 1–6 outline steps.");
          await save({ ...state, planId: randomUUID(), goal: data.goal, prerequisites: data.prerequisites, outline: data.outline });
        } else if (action === "approve") {
          if (!state.planId || data.planId !== state.planId || state.phase !== "planning") throw new Error("The proposed goal changed. Review the current plan before approving.");
          await save({ ...state, phase: "approved" });
        } else if (action === "generate") {
          if (!state.planId || data.planId !== state.planId || !["approved", "complete"].includes(state.phase)) throw new Error("The learner must approve this exact goal using Start learning first.");
          if (state.phase === "complete") return state;
          const result = await connection.generateLesson({ ...data, goal: state.goal, onboardingCode: ONBOARDING_CODE });
          await save({ ...state, phase: "complete", cellIds: result.cell_ids });
        } else throw new Error("Unknown learning action.");
        return state;
      });
      pending = result.catch(() => {});
      return result;
    },
  };
}

async function request(action, data, signal) {
  const base = process.env.TUTOR_BROKER_URL;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !process.env.TUTOR_BROKER_TOKEN) throw new Error("Launch through zen to use learning setup tools.");
  const response = await fetch(`${base}/learning/${action}`, {
    method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Origin: process.env.TUTOR_URL, Authorization: `Bearer ${process.env.TUTOR_BROKER_TOKEN}` },
    body: JSON.stringify(data), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
}
const string = { type: "string" };
export const learningTools = [
  { name: "propose_learning_goal", label: "Propose learning goal", description: "For zen init only: propose the exact learning goal, prerequisites and short outline after discussing them. This does NOT approve the plan. Wait for the learner's Start learning button before generating.",
    parameters: { type: "object", properties: { goal: string, prerequisites: string, outline: { type: "array", items: string } }, required: ["goal", "prerequisites", "outline"], additionalProperties: false },
    execute: (_id, args, signal) => request("propose", args, signal) },
  { name: "generate_learning_notebook", label: "Create approved lesson", description: "For zen init only, after explicit learner approval: replace ONLY the untouched setup chat cell with a goal heading and 2–8 teaching sections. Use explanation text, interactive prediction questions with 2–4 choices, and exercise instructions (an empty learner code cell is added). Other cells are preserved. Inspect first; use the approved planId and latest notebook revision. No arbitrary Python or solved assignments.",
    parameters: { type: "object", properties: { planId: string, revision: string, sections: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: { kind: { type: "string", enum: ["explanation", "practice", "exercise"] }, text: string, choices: { type: "array", items: string } }, required: ["kind", "text", "choices"], additionalProperties: false } } }, required: ["planId", "revision", "sections"], additionalProperties: false },
    execute: (_id, args, signal) => request("generate", args, signal) },
];
