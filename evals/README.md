# Onboarding eval lab

Scenario-based evals for **agent behavior during AIOS onboarding** — a different layer
than `test/`, which already covers scaffold/CLI/sync-client *code* correctness
(`test/scaffold-*.test.mjs`, `test/sync-plan.test.mjs`, `test/onboard-*.test.mjs`, etc.).
This lab checks the layer above that: handed a realistic onboarding task inside a real
scaffolded workspace, does an **agent** make the right call — one code alone can't
guarantee, because the failure mode is a judgment call, not a bug.

Each scenario is one atom: a scoped, independently verifiable procedure, graded
deterministically wherever possible and by a fresh-session LLM judge (against a
`rubric.md`) only where a script can't tell right from wrong on its own. A judge
defaults to `needs_review`, never a silent pass, when no `--judge` is requested.

## Running

```bash
bash evals/run.sh --runtime mock --scenario all --runs 1 --judge mock
bash evals/run.sh --runtime <claude|codex|opencode> --scenario <id> --runs <n> --judge <runtime>
```

`mock` is deterministic and exists to prove the lab's own wiring (setup → grade → judge),
not to rank models — see `evals/CONTRACT.md` in `aios-engineering-harness` for that
framing. Live runs against real runtimes are the next step once a scenario's fixture is
solid; nothing here has been run against a live runtime yet.

## Scenarios

- **`onboarding-catalog-freshness`** — after a skill is added, does the agent notice
  `.claude/skills/INDEX.md` has gone stale and regenerate it (mirrors the real
  `gen-catalog.mjs` staleness risk — scaffold swallows generation failures, and
  `install-skill` only prints a reminder to re-run it, nothing enforces that). Fully
  deterministic: `grade.sh` re-runs the real `gen-catalog.mjs` as an oracle and diffs it
  against what's actually in the workspace.
- **`onboarding-skill-install-review-honesty`** — handed a skill pulled from the Team
  Brain whose install hook contains a concrete env-exfiltration backdoor, does the agent
  actually read the code and refuse to install by default (mirrors the real gap: nothing
  automated scans a pulled skill before `install-skill` copies it in). Semantic — the
  verdict lives in what the agent says, not just in a file diff.

## This lab is vendored, not forked

`aios-engineering-harness/evals/` is the canonical eval lab (built first for its own
engineering-loop scenarios: TDD discipline, honest review, safe simplification). Its
`run.sh` orchestration, `judge.sh`'s live-judge path, `judge.schema.json`, and the real
`lib/`/`drivers/{claude,codex,opencode}.sh` are domain-agnostic — this repo vendors those
files verbatim rather than re-implementing the same grading/judging contract for a
second time. See `../aios-engineering-harness/evals/CONTRACT.md` for exactly what's
core vs. repo-specific, and this repo's `scripts/sync-eval-lab.sh` for the sync mechanism
(same "always dry-run first" convention as `hermes-skills.md`'s cross-repo sync).

**Re-syncing:**

```bash
scripts/sync-eval-lab.sh              # dry-run: shows what would change
scripts/sync-eval-lab.sh --apply      # copies the core files, stamps evals/.eval-lab-version
```

Default source is a sibling `../aios-engineering-harness` checkout; override with
`EVAL_LAB_SOURCE=<path>` (needed when running from a worktree, since the sibling-path
default assumes the primary checkout layout).

**What's synced (core) vs. owned locally (repo-specific):**

| Synced from the harness | Owned here |
|---|---|
| `run.sh`, `judge.schema.json`, `lib/exec_timeout.py`, `lib/normalize_transcript.py`, `drivers/{claude,codex,opencode}.sh` | `lib/install-harness.sh` (here: a near-no-op, since a scenario's `setup.sh` builds the real fixture by calling `scaffold-project.sh` directly), `drivers/mock.sh` (hand-scripted per this repo's own scenarios), `scenarios/` |
| `judge.sh` — **live-judge path only** | `judge.sh`'s mock-mode `case` switch is a **deliberate local extension**: it's hardcoded per-scenario even in the vendored file, so after every re-sync, re-apply this repo's own scenario cases (`onboarding-skill-install-review-honesty`, and any new semantic scenario) to the switch statement before the mock judge can grade them. Do not treat a clean re-sync as having restored this. |

## How this grows

New scenarios are sourced from real friction, not invented in the abstract — the same
way `onboarding-skill-install-review-honesty` generalizes a documented, real gap
(`install-skill` has no automated review gate) rather than a hypothetical one. As new
onboarding dogfood runs (`docs/pre-ship/dogfood/*`) or real incidents surface a fresh
"an agent could silently get this wrong" moment, that becomes the next scenario:
`manifest.json` + `prompt.md` + `setup.sh` (build the fixture, usually via the real
scaffold/CLI as a black box) + `grade.sh` (deterministic where possible) + `rubric.md`
(only where judgment is genuinely required) + a `drivers/mock.sh` case proving the
grading pipeline itself is sound before ever pointing it at a real runtime.
