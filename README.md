# Zen Tutor

A quiet AI learning partner inside a reactive notebook - helping you think, not doing the exercise for you.

Zen Tutor runs [marimo](https://github.com/marimo-team/marimo) locally with an integrated agent. The agent keeps track of your progress, analyze your effort and help you when you're stuck. Ask for help beside a cell and receive a small hint or prerequisite exercise in a new notebook block.

Zen can also help you transform a learning intent in a full fledged notebook that evolves with your understanding.

## Features

- Native tutor panel with streaming responses, cancellation and automatic notebook-scoped session resume.
- Per-cell **Help me think** to give hints and advices.
- Bundled marimo guidance and read-only API documentation lookup from the installed version.
- A **Tutor** developer tab showing context, session/model configuration and all request/tool/error events, with pause, clear and export.
- No cheat mode: Agent can't give the answer. Competing AI generation, rewrite/fix shortcuts and AI autocomplete disabled in tutor mode. Normal editing and completion remain available.

Important notes:
- Keep `import marimo as mo` in its own enabled cell as the first cell.

## Run locally

Requires Git, Node.js 24+, npm, `make`, and [uv](https://docs.astral.sh/uv/). Tested on Python 3.13 , pinned pnpm 10.28.2 on macOS.

```sh
git clone git@github.com:julio4/marimo-zen-tutor.git
cd marimo-zen-tutor
make install
```

Then, from any directory:

```sh
zen auth
zen /path/to/notebook.py
```

`zen auth` uses pi's auth flow, with browser or device-code authentication when supported. Credentials are private in `~/.zen/auth.json` (0600); notebook-bound sessions and model configuration also live under `~/.zen/`. For pi user, default profile is not loaded.

 **Never commit or share credentials.** You can instead explicitly import one provider from an existing Pi profile, or authenticate an API-key provider:

```sh
zen auth --from "$HOME/.pi/agent/auth.json"
zen auth --provider openai --api-key
zen notebook.py --port 2723 --agent-port 3028
zen pip install numpy matplotlib
```

## Installation details

The installer places `zen` in `~/.local/bin`; add that directory to `PATH` if needed. It copies the built app into `~/.zen/installs/` and switches `~/.zen/runtime` after successful installation, so the checkout is not required afterward.

Node.js 24+ must remain available. `uv` manages Python 3.13 and is also needed for `zen pip install`. This first version shares one Python environment across notebooks; it does not automatically use a notebook's `.venv` or install its dependencies. Reinstalling retains credentials, configuration, sessions and older runtimes, but starts a fresh Python environment. Reinstall additional libraries as needed. `ZEN_HOME` and `ZEN_BIN_DIR` override the profile/install and launcher directories; keep `ZEN_HOME` set when using a custom installation.

Use the browser tab opened by the launcher: its private URL fragment connects the page to the agent. Do not share that URL. The default model is `openai-codex/gpt-6-astra` with medium thinking. Edit `~/.zen/config.json` (`provider`, `model`, `thinking`), use `TUTOR_PROVIDER`, `TUTOR_MODEL`, `TUTOR_THINKING`, or use the agent panel. `TUTOR_API_KEY` is an optional environment-only credential for compatible providers.

 Connection initializes that import without running the learner's other cells. Click the lightbulb beside a cell for help. Open the bottom-left developer-panel control and select **Tutor** for diagnostics. The upstream panel tabs are draggable; Escape exits tab drag mode if activated.

Ctrl-C stops the local services. Run `make install` again after changing the source; restart Zen to use the updated installation.

## Development

```sh
make tutor-check
# For checkout-based development, use make tutor-setup, make fork-build,
# and make tutor-start NOTEBOOK=/path/to/notebook.py.
# Optional live-model/browser test; uses your isolated tutor credentials:
cd marimo/frontend && npx playwright install chromium
cd ../../marimo-test && node agent/browser-smoke.mjs
```

The repository stores our changes as patches, not copies of upstream Git history. `forks/pins.json` pins marimo 0.24.2 and pi-acp 0.0.33; setup recreates the ignored `marimo/` and `pi-acp/` checkouts and applies the patches without overwriting conflicting work. After editing either checkout, run `node scripts/snapshot-forks.mjs` and commit the updated patches. Tutor runtime and tests live in `marimo-test/agent/`; the bundled example is `marimo-test/notebooks/averages.py`.

Upstream projects retain their licenses: marimo is Apache-2.0; pi-acp is MIT. Their copyright notices remain in the patches and generated checkouts.

