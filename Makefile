# aios-workspace — one-command entry points.
# `make setup` is pure environment setup + a frontend build check: it runs `npm ci` and
# builds the GUI client (a Vite build). It needs NO Rust/Tauri toolchain and NO secrets.
# The desktop (Tauri) targets are kept separate because they require Rust and may need env.

.PHONY: setup test lint format gui app-dev app-build

setup: ## install deps + build the GUI client (no Rust/secrets needed)
	npm ci
	npm run gui:build

test: ## run the unit/test suite
	npm test

lint: ## eslint + prettier check
	npm run lint
	npm run format:check

format: ## auto-format first-party source
	npm run format

gui: ## run the local GUI server
	npm run gui

app-dev: ## Tauri desktop dev (requires Rust toolchain)
	npm run app:dev

app-build: ## Tauri desktop release build (requires Rust toolchain)
	npm run app:build
