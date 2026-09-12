// The same HTTP/scratchpad path used by marimo-pair. Pinned to marimo 0.24.2.
// Keep the private API here; never expose arbitrary Python to the tutor.
const PRELUDE = `import json, hashlib, html, ast
import marimo as _zen_marimo
if _zen_marimo.__version__ != "0.24.2":
    raise RuntimeError("This adapter requires marimo 0.24.2; verify the private API before upgrading.")
import marimo._code_mode as cm
def revision(ctx):
    return hashlib.sha256(json.dumps([(c.id, c.code) for c in ctx.cells]).encode()).hexdigest()
def marimo_alias(ctx):
    for cell in ctx.cells:
        try:
            nodes = ast.parse(cell.code).body
        except SyntaxError:
            continue
        for node in nodes:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name
                    if alias.name == "marimo" and not name.startswith("_"):
                        return name
    raise ValueError("The notebook needs a shared import, such as import marimo as mo.")
`;
const payload = (value) => `json.loads(bytes.fromhex("${Buffer.from(JSON.stringify(value)).toString("hex")}"))`;

export class MarimoNotebook {
  constructor({ url, notebook, token = "" }) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
      throw new Error("Use a loopback HTTP marimo URL without credentials, path, or query.");
    }
    if (!notebook) throw new Error("An explicit absolute notebook path is required.");
    this.url = parsed.origin;
    this.notebook = notebook;
    this.token = token;
  }

  async #request(path, options = {}, signal) {
    const response = await fetch(this.url + path, {
      ...options,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers },
    });
    if (!response.ok) throw new Error(`marimo ${path}: HTTP ${response.status}`);
    return response;
  }

  async #execute(code, signal) {
    const sessions = await (await this.#request("/api/sessions", {}, signal)).json();
    const matches = Object.entries(sessions).filter(([, s]) => s.path === this.notebook || s.filename === this.notebook);
    if (matches.length !== 1) {
      throw new Error(`Expected one open session for ${this.notebook}; found ${matches.length}. Open it in the browser.`);
    }
    const response = await this.#request("/api/kernel/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Marimo-Session-Id": matches[0][0] },
      body: JSON.stringify({ code }),
    }, signal);
    const body = await response.text();
    let stdout = "", stderr = "", done;
    for (const record of body.replaceAll("\r\n", "\n").split("\n\n")) {
      const lines = record.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const value = JSON.parse(data);
      if (event === "stdout") stdout += value.data;
      if (event === "stderr") stderr += value.data;
      if (event === "done") done = value;
    }
    if (!done?.success) throw new Error(stderr || "marimo execution ended without a successful result.");
    const result = stdout.split("\n").findLast((line) => line.startsWith("ZEN_RESULT:"));
    if (!result) throw new Error("marimo returned no adapter result.");
    return JSON.parse(result.slice("ZEN_RESULT:".length));
  }

  async inspect(signal) {
    return this.#execute(`${PRELUDE}
ctx = cm.get_context()
def output(value):
    return None if value is None else {"mimetype": value.mimetype, "data": str(value.data)[:4000]}
print("ZEN_RESULT:" + json.dumps({
    "revision": revision(ctx),
    "cells": [{"id": c.id, "code": c.code, "status": c.status,
        "errors": [e.msg for e in c.errors], "output": output(c.output),
        "console": [output(o) for o in c.console_outputs][-5:]} for c in ctx.cells]
}))`, signal);
  }

  async lookupApi({ symbol }, signal) {
    if (typeof symbol !== "string" || !/^mo(?:\.[a-zA-Z][a-zA-Z0-9_]*){0,4}$/.test(symbol) || symbol.length > 160) {
      throw new Error("Use a public marimo symbol such as mo.ui.slider; no expressions or private attributes.");
    }
    return this.#execute(`${PRELUDE}
import inspect
symbol = ${payload(symbol)}
obj = _zen_marimo
for part in symbol.split(".")[1:]:
    if not (inspect.ismodule(obj) or inspect.isclass(obj)):
        raise ValueError("Only public module and class members can be looked up.")
    try:
        obj = inspect.getattr_static(obj, part)
    except AttributeError:
        raise ValueError("Unknown marimo API symbol: " + symbol) from None
if isinstance(obj, (classmethod, staticmethod)):
    obj = obj.__func__
signature = None
if callable(obj):
    try:
        signature = str(inspect.signature(obj))
    except (TypeError, ValueError):
        pass
doc = inspect.getdoc(obj) or "No docstring available."
members = []
if inspect.ismodule(obj) or inspect.isclass(obj):
    # Read dictionaries, never invoke descriptors, constructors or API functions.
    owners = [obj] if inspect.ismodule(obj) else obj.__mro__
    members = sorted({name for owner in owners for name in vars(owner) if not name.startswith("_")})
print("ZEN_RESULT:" + json.dumps({"version": _zen_marimo.__version__, "symbol": symbol,
    "signature": signature, "doc": doc[:16000], "truncated": len(doc) > 16000,
    "members": members}))`, signal);
  }

  async initialize(signal) {
    return this.#execute(`${PRELUDE}
ctx = cm.get_context()
alias = marimo_alias(ctx)
ran = False
if getattr(ctx.globals.get(alias), "__name__", None) != "marimo":
    candidates = []
    for cell in ctx.cells:
        try:
            nodes = ast.parse(cell.code).body
        except SyntaxError:
            continue
        if (len(nodes) == 1 and isinstance(nodes[0], ast.Import)
            and len(nodes[0].names) == 1 and nodes[0].names[0].name == "marimo"
            and (nodes[0].names[0].asname or "marimo") == alias):
            candidates.append(cell)
    if len(candidates) != 1 or candidates[0].config.disabled:
        raise ValueError("Put import marimo as mo in its own enabled cell, or run the shared import manually.")
    # Suppress reactive descendants while initializing only the trusted import.
    previous_mode = ctx._kernel.reactive_execution_mode
    try:
        ctx._kernel.reactive_execution_mode = "lazy"
        async with ctx:
            ctx.run_cell(candidates[0].id)
    finally:
        ctx._kernel.reactive_execution_mode = previous_mode
    ran = True
if getattr(ctx.globals.get(alias), "__name__", None) != "marimo":
    raise ValueError("The shared marimo import did not initialize successfully.")
print("ZEN_RESULT:" + json.dumps({"alias": alias, "ran": ran}))`, signal);
  }

  async addHint({ after, revision, text }, signal) {
    if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Hint must contain 1–4000 characters.");
    return this.#append({ after, revision, text, kind: "hint" }, signal);
  }

  async addPractice({ after, revision, question, choices }, signal) {
    if (typeof question !== "string" || !question.trim() || question.length > 2000
        || !Array.isArray(choices) || choices.length < 2 || choices.length > 4
        || choices.some((s) => typeof s !== "string" || !s.trim() || s.length > 200)
        || new Set(choices).size !== choices.length) {
      throw new Error("Practice requires a question and 2–4 distinct, nonempty choices.");
    }
    return this.#append({ after, revision, question, choices, kind: "practice" }, signal);
  }

  async #append(data, signal) {
    if (typeof data.after !== "string" || !/^[a-f0-9]{64}$/.test(data.revision)) throw new Error("Inspect first; provide the cell ID and revision.");
    await this.initialize(signal);
    return this.#execute(`${PRELUDE}
data = ${payload(data)}
async with cm.get_context() as ctx:
    if revision(ctx) != data["revision"]:
        raise ValueError("Notebook changed. Inspect again before adding help.")
    anchor = ctx.cells[data["after"]]
    mo = marimo_alias(ctx)
    if getattr(ctx.globals.get(mo), "__name__", None) != "marimo":
        raise ValueError("Run the notebook's shared marimo import cell before adding teaching cells.")
    if data["kind"] == "hint":
        body = mo + ".md(" + repr("### A small hint\\n\\n" + html.escape(data["text"])) + ")"
    else:
        # A private variable stays local to this new cell. No answer key is embedded.
        body = "_choice = " + mo + ".ui.radio(" + repr([html.escape(s) for s in data["choices"]]) + ", label=" + repr(html.escape(data["question"])) + ")\\n_choice"
    cid = ctx.create_cell(body, after=anchor.id, hide_code=True)
    ctx.run_cell(cid)
print("ZEN_RESULT:" + json.dumps({"cell_id": cid, "kind": data["kind"]}))`, signal);
  }
}

export function notebookTools(notebook) {
  const string = { type: "string" };
  const define = (name, description, properties, execute) => ({
    name, label: name, description,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    execute: async (_id, args, signal) => {
      const result = await execute(args, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  return [
    define("inspect_notebook", "Read this notebook's current cells, outputs, errors and revision. Inspect before offering help.", {}, (_args, signal) => notebook.inspect(signal)),
    define("lookup_marimo_api", "Read installed marimo API signatures, docstrings/examples and public members. Use mo or mo.ui to discover symbols; mo.ui.slider or mo.ui.radio.form for detail. Does not execute the API or edit cells.",
      { symbol: string }, (args, signal) => notebook.lookupApi(args, signal)),
    define("add_hint", "Insert a small hint after a cell without changing any existing cell. Requires the latest inspected revision.",
      { after: string, revision: string, text: string }, (args, signal) => notebook.addHint(args, signal)),
    define("add_practice", "Insert a short prerequisite prediction question with 2–4 radio choices. Do not solve the original assignment. Ask the learner to explain their choice in chat.",
      { after: string, revision: string, question: string, choices: { type: "array", items: string, minItems: 2, maxItems: 4 } },
      (args, signal) => notebook.addPractice(args, signal)),
  ];
}
