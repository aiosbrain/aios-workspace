# aios-workspace — one-command entry points.
# `make setup` is pure environment setup: it runs `npm ci`. It needs NO secrets.
# The GUI and desktop (Tauri) targets left with the AIO-612 cut — they now live in
# aiosbrain/aios-workspace-gui.

.PHONY: setup test lint format

setup: ## install deps
	npm ci

test: ## run the unit/test suite
	npm test

lint: ## eslint + prettier check
	npm run lint
	npm run format:check

format: ## auto-format first-party source
	npm run format
