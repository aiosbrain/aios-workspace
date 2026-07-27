# Eval-lab contract

This lab is designed to be consumed by more than one repo. `aios-engineering-harness`
owns the canonical copy; other repos (starting with `aios-workspace`, for onboarding
behavior rather than engineering-loop behavior) vendor the reusable core into their own
`evals/` directory and add their own scenarios on top. This file is the line between
what's safe to sync verbatim and what every consumer must implement itself.

## Core (sync verbatim, no domain assumptions)

These files take no dependency on what a scenario's fixture contains — they only read
the `HARNESS_*` env vars, a scenario's `manifest.json`, and generic driver/grade/judge
record shapes:

- `run.sh` — orchestration loop (setup → install → drive → normalize → grade → judge →
  aggregate). Scenario discovery for `--scenario all` is automatic
  (`scenarios/*/manifest.json`, skipping any directory missing an executable
  `setup.sh`/`grade.sh` or a `prompt.md` so a WIP scenario never gets silently run), so a
  consumer never has to edit this file just to register a new scenario. Also enforces a
  scenario's `forbidden_paths` (fails the run if any changed path matches).
- `judge.sh` in full, including its mock-mode dispatch, `judge.schema.json` — fresh-session
  LLM judge against a scenario's `rubric.md`; defaults to `needs_review`, never a silent
  pass. The mock-mode path is fully domain-agnostic: it looks for an executable
  `mock-judge.sh` inside the scenario's own directory (`$SCENARIO_DIR/mock-judge.sh`,
  receiving the artifact path as `$1`, printing `{"status":...,"reason":...}` on stdout)
  and fails closed if absent. Because that per-scenario logic lives under `scenarios/`
  (never synced — see Adapter points below), re-syncing `judge.sh` verbatim can never
  clobber a consumer's own mock rubrics.
- `lib/exec_timeout.py` — timeout-wrapped subprocess exec with captured stdout/stderr.
- `lib/normalize_transcript.py` — runtime-specific transcript → generic `events.jsonl`.
- `drivers/claude.sh`, `drivers/codex.sh`, `drivers/opencode.sh` — shell out to the real
  runtime CLIs. Verified harness-agnostic: no reference to `.harness/`, `AGENTS.md`, or
  any file `lib/install-harness.sh` creates.

## Adapter points (every consumer implements its own)

- **`lib/install-harness.sh`** — same call signature (`$ROOT $WORKSPACE $RUNTIME`)
  everywhere, but its job is repo-specific: this repo's version installs the engineering
  harness's own skills/hooks/adapters into the scratch workspace so a scenario can test
  *this harness* operating on a generic code repo. A consumer whose scenarios exercise a
  different product (e.g. an AIOS personal workspace) writes its own version — often a
  near-no-op, since a scenario's `setup.sh` can build the real fixture directly (e.g. by
  calling that product's own scaffold script) instead of installing anything here.
- **`drivers/mock.sh`** — deterministic, hand-scripted "what a passing (and failing)
  trajectory looks like" per scenario, keyed by `$HARNESS_SCENARIO`. This exists to test
  the lab itself, not the runtimes, so it is inherently scenario-specific and never
  synced — each consumer's mock driver only knows about its own scenarios.
- **`scenarios/`** — the actual atoms (`manifest.json`, `prompt.md`, `setup.sh`,
  `grade.sh`, `mock-judge.sh` when `semantic_required: true` and mock-mode judging is
  needed, and `rubric.md` for the live judge). Fully repo-specific by design; see
  `evals/README.md` for the shape.

## Consuming this lab from another repo

A consumer vendors the **core** list above into its own `evals/` (matching relative
paths so `run.sh` doesn't need patching), writes its own `lib/install-harness.sh` and
`drivers/mock.sh`, and adds its own `scenarios/`. Pin the source commit the core was
vendored from (a version marker file) so drift is visible and re-syncs are deliberate,
never silent — see `aios-workspace/evals/README.md` for the concrete sync mechanism.
