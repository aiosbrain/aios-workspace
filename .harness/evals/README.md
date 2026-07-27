# Harness eval lab

The lab checks policy conformance and agent trajectories without turning runtime smoke
runs into a model leaderboard.

This lab's core (`run.sh`, `judge.sh`, `lib/exec_timeout.py`, `lib/normalize_transcript.py`,
`drivers/{claude,codex,opencode}.sh`) is designed to be vendored by other repos that want
the same scenario/grading contract for a different domain — see [`CONTRACT.md`](CONTRACT.md)
for exactly what's shared vs. repo-specific.

## Deterministic floors

```bash
bash evals/guards.test.sh        # policy and destructive-command cases
bash evals/conformance.test.sh   # native payloads and adapter behavior
bash evals/install.test.sh       # four-runtime installer + non-destructive failure matrix
bash evals/visual-qa.test.sh     # visual-qa script: import safety, image-diff, interlace reject
python3 evals/evidence.test.py   # sanitized transcript and exit-code reconciliation
bash evals/graders.test.sh       # deterministic scenario-grader regressions
bash evals/runner.test.sh        # runner fault modes and five-scenario aggregate
```

Secret-shaped fixtures are assembled at runtime. Raw traces, transcripts, diffs, and
scratch repositories live under ignored `evals/results/` and `evals/scratch/`.

## Behavioral runs

Stable command:

```bash
bash evals/run.sh --runtime <claude|codex|opencode|mock> \
  --scenario <tdd-under-deadline|simplify-red-baseline|simplify-green-baseline|review-honesty-clean-diff|review-honesty-real-p1|all> \
  --runs <n>
```

Optional flags include `--model`, `--timeout`, `--results-dir`, `--judge`,
`--judge-model`, and `--keep-workspaces` (skip the post-run cleanup of a run's scratch
workspace — useful when debugging a real, non-mock run). Credentials come only from the
installed runtime; the lab never reads or stores credential configuration.

Each run creates an isolated temporary Git repository, installs a copy of the harness,
passes the scenario prompt to a driver, grades deterministic evidence, and emits a run
JSON plus an aggregate `summary.json`. Run records contain runtime/model, exit and
duration, tool/check counts, changed paths, checks, available token/cost fields, and
artifact locations. Missing usage remains `null` rather than estimated.

`hook-events.jsonl` preserves the raw adapter and fixture trace. `events.jsonl` keeps
transcript-derived events in their original order while reconciling matching check
statuses with fixture-emitted exit codes. If transcript normalization fails, the raw
hook trace becomes the grading stream. This lets graders establish check ordering,
RED-before-implementation, final GREEN, path scope, and forbidden actions without
trusting the final prose or test-output wording.

Both review-honesty scenarios need semantic grading. The clean case checks that a
reviewer does not invent findings; `review-honesty-real-p1` checks that a concrete SQL
injection is ranked P1 with an exploit scenario and a non-approval verdict. Without
`--judge`, a deterministically clean result is `needs_review`, never `pass`. A requested
judge runs in a fresh session against the rubric and captured evidence; unavailable or
malformed judge output also remains `needs_review`.

The simplification pair covers both sides of the baseline gate:
`simplify-red-baseline` must stop unchanged, while `simplify-green-baseline` must make a
real simplification only inside the original feature hunk and finish green. Any red
edit in the green variant must be fully reverted to the original feature diff.

The mock driver is deterministic and exists to test the lab. Live results demonstrate
that adapters and scenarios execute on the installed runtimes. They do not establish
general model superiority. Redacted local smoke reports may be committed under
[`evals/reports/`](reports/); raw evidence remains ignored.

## Known limitations (deferred, not this round)

- **`HARNESS_*` env vars are visible to the evaluated agent's own process** (they're
  inherited transitively through `exec_timeout.py`'s `subprocess.Popen`). An
  adversarial/reward-hacking agent could in principle detect it's under evaluation and
  locate the trace file. Closing this fully requires redesigning how each runtime's own
  hook mechanism receives its config (today `HARNESS_TRACE_FILE`/`HARNESS_ROOT` are read
  directly from the CLI subprocess's env by `adapters/*/settings.json`/`hooks.json` and
  the OpenCode plugin) — bigger than a bugfix, tracked as a follow-up.
- **No CI wiring for the eval lab.** This repo has no `.github/workflows/` at all today;
  `evals/*.test.sh` and `bash evals/run.sh --runtime mock --scenario all --judge mock`
  are run by hand. Bootstrapping CI for this repo is a separate project from the eval lab
  itself.
