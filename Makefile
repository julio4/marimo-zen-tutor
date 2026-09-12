# Zen Tutor: run from the repository root.
PNPM = npx --yes --package=pnpm@10.28.2 -c
NOTEBOOK ?= marimo-test/notebooks/averages.py
PORT ?= 2722

.PHONY: install fork-setup fork-build fork-start fork-check tutor-setup tutor-start tutor-check

install:
	$(MAKE) tutor-setup
	$(MAKE) fork-build
	node scripts/install.mjs

fork-setup:
	node scripts/bootstrap-forks.mjs
	cd marimo && $(PNPM) 'pnpm install --frozen-lockfile'
	uv venv --allow-existing marimo/.venv --python 3.13
	uv pip install --python marimo/.venv/bin/python -e ./marimo

fork-build:
	cd marimo && $(PNPM) 'make fe'

# Start the ordinary editor without the tutor broker.
fork-start:
	test -f marimo/marimo/_static/index.html
	marimo/.venv/bin/marimo edit "$(abspath $(NOTEBOOK))" --host 127.0.0.1 --port "$(PORT)" --no-token --skip-update-check

fork-check:
	marimo/.venv/bin/python -c 'import marimo; from pathlib import Path; assert Path(marimo.__file__).resolve() == Path("marimo/marimo/__init__.py").resolve(); assert marimo.__version__ == "0.24.2"; assert Path("marimo/marimo/_static/index.html").is_file(); print("Local fork and built assets verified")'
	cd marimo-test && MARIMO_TEST_EXECUTABLE="$(CURDIR)/marimo/.venv/bin/marimo" npm test

tutor-setup: fork-setup
	cd marimo-test && npm ci
	chmod +x marimo-test/agent/runner.mjs
	cd pi-acp && npm ci && npm run build

tutor-start:
	test -f marimo/marimo/_static/index.html
	node marimo-test/agent/serve.mjs --notebook "$(abspath $(NOTEBOOK))" --port "$(PORT)"

tutor-check: fork-check
	cd pi-acp && npm run build && npm run typecheck && npm test
	cd marimo-test && node --test agent/acp.test.mjs agent/debug.test.mjs agent/cli.test.mjs
	cd marimo && $(PNPM) 'pnpm --filter @marimo-team/frontend typecheck && pnpm --filter @marimo-team/frontend test src/core/tutor src/components/chat/acp/__tests__/state.test.ts src/components/editor/chrome/__tests__/state.test.ts src/components/editor/navigation/__tests__/navigation.test.ts'
