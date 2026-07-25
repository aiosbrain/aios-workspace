# AGENTS.md

> The repo↔agent contract, per the [AGENTS.md standard](https://agents.md) (read natively
> by Claude Code, Codex, Cursor, Zed, Amp, Copilot, opencode, and 20+ other tools).

## Project

`aios-engineering-harness` is a curated, drop-in harness for agentic software
engineering — skills, hooks/guards, subagent definitions, verification rubrics, and
model-routing conventions, portable across Claude Code, Codex, OpenCode, and Cursor
through equal first-class adapters (see [`README.md`](README.md) for the full map).
Three facts to know before touching anything:

1. **Hooks read a normalized protocol, never a runtime's native payload.** Runtime
   adapters (`adapters/{claude-code,codex,cursor,opencode}/`) translate native tool
   events into one JSON shape (`hooks/PROTOCOL.md`, `hooks/protocol.schema.json`);
   scripts under `hooks/` only ever parse that shape. Never add native-payload parsing
   to a `hooks/*.sh` script — put it in the adapter.
2. **`evals/` is a two-tier contract.** `evals/CONTRACT.md` draws the line between the
   generic "core" (synced verbatim to consumer repos like `aios-workspace`) and the
   repo-specific "adapter points" (`lib/install-harness.sh`, `drivers/mock.sh`,
   `scenarios/`). Changing a core file changes behavior for every consumer.
3. **This is a zero-dependency pack.** No `package.json`, no build step for the shell/
   Python surface. The only real dependency is Bun, used solely to type-check/test the
   OpenCode TypeScript adapter (`adapters/opencode/`, `evals/opencode-plugin.test.ts`).

## Commands

```bash
# Shell lint — matches CI's lint-shell job
shellcheck --severity=warning $(git ls-files '*.sh')   # .shellcheckrc scopes reviewed exceptions
git ls-files -z '*.sh' | xargs -0 -I{} bash -n {}

# Eval-lab test suite — matches CI's tests job (needs bun on PATH; conformance.test.sh
# shells out to `bun test` for the OpenCode adapter)
bash evals/runner.test.sh
bash evals/guards.test.sh
bash evals/graders.test.sh
bash evals/conformance.test.sh
bash evals/codex-driver.test.sh
bash evals/inject-context.test.sh
bash evals/route-skills.test.sh
bash evals/stop-continuation.test.sh
python3 evals/evidence.test.py

# OpenCode plugin tests — matches CI's plugin-test job (pinned Bun version)
bun test evals/opencode-plugin.test.ts

# Judge schema + fixtures — matches CI's schema job
pip install jsonschema
python3 evals/validate_judge_schema.py

# Secret scan (whole tracked tree, not the pre-edit hook) — matches CI's secret-scan job
bash hooks/scan-tree-secrets.test.sh   # self-test first (synthetic secret, assembled at runtime)
bash hooks/scan-tree-secrets.sh

# Conformance smoke (mock runtime, every scenario) — matches CI's conformance-smoke job
bash evals/run.sh --runtime mock --scenario all --runs 1 --judge mock --results-dir "$(mktemp -d)"
```

## Conventions

- **Worktrees, not branches, in this repo's own working copy.** Do agent work in a
  `git worktree` off `origin/main`; never commit feature work straight onto the primary
  checkout's `main` (this repo doesn't ship the AIOS `pre-commit-primary-guard`, but the
  convention still applies — see `skills/git-master/SKILL.md`).
- **Secrets: two different tools, two different jobs.** `hooks/guard-secrets.sh` is a
  stdin protocol-event hook (single edit's `added_content`, exits 0 on empty content) —
  it is not a tree scanner. `hooks/scan-tree-secrets.sh` greps every `git ls-files`
  entry against `hooks/secret-patterns.txt` for CI. Don't repurpose one for the other's
  job.
- **Test fixtures assemble secret-shaped strings at runtime** (string concatenation),
  never as a literal in source — otherwise the secret scanners (rightly) refuse to let
  the file exist. See `evals/guards.test.sh` and `hooks/scan-tree-secrets.test.sh`.
- **A new core `evals/` behavior needs an `evals/CONTRACT.md` read first** — decide
  whether it belongs in "core" (syncs to consumers) or an "adapter point" (repo-local)
  before writing it.

## Boundaries

- Never edit: `.env*`, anything under a scenario's `forbidden_paths` (see each
  `evals/scenarios/*/manifest.json`), vendored/generated output.
- Always ask before: changing `hooks/PROTOCOL.md`'s wire shape (breaks every adapter +
  every consumer repo that vendored the core), or adding a dependency to the
  zero-dependency shell/Python surface.

## Verification

Definition of done for any change here: the CI suite green
(`.github/workflows/ci.yml` — lint-shell, tests, plugin-test, schema, secret-scan,
conformance-smoke) plus, for anything touching `hooks/` or `adapters/`, the relevant
`evals/*.test.sh` run locally first.

---

## Error ledger

> The compounding section. Whenever an agent makes a mistake a rule could have
> prevented, add the rule here (or promote it to a hook if it must be *guaranteed*).
> Date each entry. Prune entries that graduate into hooks or formatters.

- `2026-07-25` — a CI job that runs `bash evals/conformance.test.sh` also transitively
  needs Bun on `PATH` (it shells out to `bun test` for the OpenCode adapter suite) even
  when a separate job already covers the plugin tests directly — install Bun in both.
