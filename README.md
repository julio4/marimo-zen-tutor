# Zen Tutor

A quiet AI learning partner inside a reactive notebook—helping you think, not doing the exercise for you.

Zen Tutor runs [marimo](https://github.com/marimo-team/marimo) locally with an isolated Pi agent. Ask for help beside a cell and receive a small hint or prerequisite exercise in a new notebook block. Your original code stays yours.

## First deliverable

- Native tutor panel with streaming responses, cancellation and automatic notebook-scoped session resume.
- Per-cell **Help me think**, including the unrun editor draft separately from previous code and output.
- Safe Markdown hints and radio-choice practice blocks; no agent shell access or replacement of student cells.
- Bundled marimo guidance and read-only API documentation lookup from the installed version.
- A **Tutor** developer tab showing context, session/model configuration and real ACP request/tool/error events, with pause, clear and export.
- Competing AI generation, rewrite/fix shortcuts and AI autocomplete disabled in tutor mode. Normal editing and completion remain available.

## Run locally

Requires Git, Node.js 24+, npm, `make`, and [uv](https://docs.astral.sh/uv/). The setup uses Python 3.13 and pinned pnpm 10.28.2. macOS is the tested platform.

```sh
git clone git@github.com:julio4/marimo-zen-tutor.git
cd marimo-zen-tutor
make tutor-setup
make fork-build
```

Add credentials before starting. If you already authenticated Pi with ChatGPT/Codex, explicitly import only that provider's credential:

```sh
node marimo-test/agent/import-auth.mjs --from "$HOME/.pi/agent/auth.json"
```

This leaves your normal Pi profile untouched, refuses to replace populated tutor credentials, and writes a private `marimo-test/.tutor/auth.json`. **Never commit or share this file.** No credentials are supplied by this repository. Alternatively, provide `TUTOR_API_KEY` via your shell along with a compatible `TUTOR_PROVIDER` and `TUTOR_MODEL`.

```sh
make tutor-start
# Or open your own notebook on another port:
make tutor-start NOTEBOOK=/absolute/path/to/lesson.py PORT=2723
```

Use the browser tab opened by the launcher: its private URL fragment connects the page to the agent. Do not share that URL. The default model is `openai-codex/gpt-6-astra` with medium thinking, configurable through `TUTOR_PROVIDER`, `TUTOR_MODEL`, `TUTOR_THINKING` and the agent panel.

Keep `import marimo as mo` in its own enabled cell. Connection initializes that import without running the learner's other cells. Click the lightbulb beside a cell for help. Open the bottom-left developer-panel control and select **Tutor** for diagnostics. The upstream panel tabs are draggable; Escape exits tab drag mode if activated.

Ctrl-C stops the local services. Restart the launcher and refresh after rebuilding.

## Development

```sh
make tutor-check
# Optional live-model/browser test; uses your isolated tutor credentials:
cd marimo/frontend && npx playwright install chromium
cd ../../marimo-test && node agent/browser-smoke.mjs
```

The repository stores our changes as patches, not copies of upstream Git history. `forks/pins.json` pins marimo 0.24.2 and pi-acp 0.0.33; setup recreates the ignored `marimo/` and `pi-acp/` checkouts and applies the patches without overwriting conflicting work. After editing either checkout, run `node scripts/snapshot-forks.mjs` and commit the updated patches. Tutor runtime and tests live in `marimo-test/agent/`; the bundled example is `marimo-test/notebooks/averages.py`.

Upstream projects retain their licenses: marimo is Apache-2.0; pi-acp is MIT. Their copyright notices remain in the patches and generated checkouts.

## Boundaries

This is an early local prototype, not a hardened exam environment. Teaching tools preserve student cells, but avoiding answer leakage in conversation remains a behavioral goal. The adapter uses private marimo APIs and intentionally rejects unsupported versions.

Selected notebook context goes to your configured model provider. Local credentials, conversations, diagnostics exports and test artifacts belong under ignored `.tutor/` directories. Broker diagnostics stay in memory, retain at most 200 events / one million payload characters plus bounded context snapshots, and use best-effort redaction. Review exports before sharing. Pause/clear affect diagnostics, not the tutor conversation. Diagnostics show ACP traffic, not the full provider request or hidden reasoning.

Learner profiles, companion metadata, passive learning telemetry, homework bootstrapping, Exa and ClickHouse are not implemented yet.
