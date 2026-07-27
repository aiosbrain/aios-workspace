# BOOTSTRAP.md — agent-runnable harness installer

Copy the entire block below and give it to your coding agent (Claude Code, Codex,
OpenCode, or Cursor) in a new project. The agent will detect its runtime, clone the
harness, run the installer, and fill in the blanks.

---

```
Your job is to install the AIOS Engineering Harness into this project. Do not
start any other work until installation is complete and verified.

## Step 1 — detect your runtime

You are running under one of: Claude Code, Codex, OpenCode, or Cursor. Identify
which by checking your environment (Claude Code has .claude/, Codex has .codex/,
OpenCode sessions call you an "agent" and look for opencode.json, Cursor has
.cursor/). Memorize this as $RUNTIME.

## Step 2 — clone the harness

```bash
git clone https://github.com/aiosbrain/aios-engineering-harness .harness
rm -rf .harness/.git
```

## Step 3 — run the installer for your runtime

The installer is idempotent and never overwrites an existing runtime config or a
locally edited skill/agent/rule file — it writes `<file>.harness-incoming` instead
so you merge deliberately rather than clobber.

```bash
.harness/install.sh --runtime "$RUNTIME"   # claude-code | codex | opencode | cursor
# or, to wire every runtime this project might use:
.harness/install.sh --all
```

This seeds `AGENTS.md`, `CONSTITUTION.md`, and `.harness/check` (only if absent),
copies skills/agents into the runtime's native locations, makes every hook and
adapter script executable, and installs the runtime's hook/plugin config. If
`install.sh` fails (e.g. `jq` missing), fall back to the manual per-runtime steps
in `README.md`'s Quickstart or `.harness/adapters/$RUNTIME/README.md`.

## Step 4 — answer the five questions

Read `.harness/docs/adopt-any-stack.md`. Inspect this project's actual tooling
(package.json, composer.json, pyproject.toml, Makefile, etc.) and fill in
`./AGENTS.md` with real answers:

1. **The check command** — the one command that proves work is correct
   (lint + typecheck + test). Write it into both `./AGENTS.md` (Commands +
   Verification sections) and `.harness/check` (a single-line file) — `install.sh`
   only seeds a placeholder here, so replace it with your project's real gate.

2. **Protected paths** — what must agents never edit. Start with `.env*`,
   lockfiles, migrations/, generated/ — add any project-specific paths
   (auth/, payment/, deploy/). Write them into `.harness/hooks/protected-paths.txt`
   and the `./AGENTS.md` Boundaries section.

3. **Exemplar files** — for each major component kind (controller, model,
   route, test, etc.), find the cleanest existing file and name it in
   `./AGENTS.md` Conventions so future agents know what "good" looks like.

4. **Database policy** — if this project has a database, document how
   migrations are created in `./AGENTS.md` Conventions.

5. **Formatter** — confirm the project's formatter is installed and
   configured. The `post-edit-format` hook auto-detects prettier, ruff,
   black, pint, php-cs-fixer, gofmt, and rustfmt.

## Step 5 — verify

```bash
bash .harness/evals/guards.test.sh
```

All tests must pass before you report installation complete.

## Important constraints

- Do NOT edit any project source files during installation.
- Do NOT change `package.json` / `composer.json` / `pyproject.toml`.
- The only files you may create or modify are under `.harness/`, `.claude/`,
  `.codex/`, `.agents/`, `.opencode/`, `.cursor/`, and the repo-root `AGENTS.md`,
  `CONSTITUTION.md`, `opencode.json`.
- `install.sh` will not overwrite an existing `./AGENTS.md` or `./CONSTITUTION.md`
  — if either already exists, merge user content into the harness template
  rather than destroying it.
- If any step fails, stop and report what went wrong.
```
