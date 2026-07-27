# CLI output contract — machine-readable markers

**Status:** contract · **Owner:** toolkit CLI · **Tests:** `test/cli-output-contract.test.mjs`

This document inventories every string in the AIOS CLI whose **exact bytes, stream, line
shape, or ordering is load-bearing** — the lines a machine reads. It exists because a
rendering change (colour, glyphs, a live region, a progress rail) is safe for human prose
and *catastrophic* for these. Any change to the CLI's output layer must satisfy this file
first.

The governing rule, stated once:

> **Human output is not an API. These markers are.**
> A marker line carries no styling, no prefix, no gutter, and no decoration. Nothing may
> share its line. Nothing may be appended after it when a detector reads the last line.

There are **two directions**, and conflating them is the easy mistake:

| Class | Direction | Risk if broken |
|---|---|---|
| **E — emitted** | AIOS → an external consumer (a hook, a CI step, an operator's `grep`) | The consumer silently stops seeing the signal, or sees a false one |
| **D — detected** | a subprocess or reviewer model → AIOS | AIOS mis-reads approval; a gate opens or jams |

---

## Class E — emitted by AIOS

Exact bytes on their own line. The stream matters: a consumer reading only stdout will
never see a stderr marker.

| Marker | Emitter | Stream | Line shape | Exit code | Known consumer |
|---|---|---|---|---|---|
| `AIOS_BUGBOT_RESULT=clear` | `review-bugbot.mjs` (`--hook-protocol` only) | **stdout** | own line, preceded by a blank line | `0` | `hooks/local-bugbot-gate.mjs`; `test/local-bugbot-gate.test.mjs` |
| `AIOS_BUGBOT_RESULT=blocked` | `review-bugbot.mjs` (`--hook-protocol` only) | **stderr** | own line, preceded by a blank line | non-zero | same |
| `SHIP_GATE plan pending` | `ship.mjs` (2 sites) | stdout | own line, **must precede the interactive prompt** | — | `aios ship --resume` operators/tooling (AIO-239 R7c) |
| `SHIP_GATE merge pending` | `ship.mjs` (2 sites) | stdout | own line, **must precede the prompt** | — | same |
| `VERDICT=CLEAR` | `consolidate-findings.mjs` | stdout | own line, last | `0` | `build.mjs`, `ship.mjs`; `test/consolidate-findings*.test.mjs` |
| `VERDICT=BLOCKED` | `consolidate-findings.mjs` | stdout | own line, last | `3` | same |
| `leak-gate: CLEAN — …` | `leak-gate.sh` | stdout | own line, last | `0` | `test/scanner-ignored-trees.test.mjs` |
| `leak-gate: FAILED — …` | `leak-gate.sh` | stdout | own line, last | `1` | `build.mjs`, `promote.mjs`, `timeline.mjs` (any non-zero ⇒ fail-closed) |
| `leak-gate: SKIPPED — …` | `leak-gate.sh` | stdout | own line | `0` | `timeline.mjs` matches `/SKIPPED/` to distinguish "unconfigured" from "clean" |

**`--hook-protocol` is the only sanctioned machine channel for the Bugbot verdict.** Without
that flag `review-bugbot` prints human prose only. The stream split (clear→stdout,
blocked→stderr) is part of the contract, not an accident.

**Exit codes are part of the contract.** `leak-gate.sh` exits `1` for any detected leak;
`SECURITY.md` documents non-zero as the fail-closed boundary and all three callers treat it
that way. Adding a distinct exit code for a new *presentation* state would silently change
three consumers — see `SECURITY.md`.

---

## Class D — detected by AIOS from captured output

These are emitted by a **reviewer model or subprocess** and parsed by AIOS. Detection is
deliberately token-specific; there is no universal Class-D dialect. Do not generalise one
row's tolerance to another.

| Token | Detector | Match rule |
|---|---|---|
| `MERGE_READY` | `detectMergeToken` (`build.mjs`) | `^MERGE_READY\b` — tolerates trailing prose glued on by streaming (`MERGE_READY - lgtm`), rejects `MERGE_READY_SOMETHING` |
| `SIMPLIFY_DONE` | `detectSimplifyToken` (`simplify.mjs`) | `^SIMPLIFY_DONE\b` |
| `SIMPLIFY_NOOP` | `detectSimplifyToken` (`simplify.mjs`) | `^SIMPLIFY_NOOP\b` |
| `PLAN_READY` | `relay.mjs`, `ship.mjs` | **strict equality** with the last non-blank line |
| `SAFETY_APPROVED` | `detectSafetyToken` (`ship.mjs`) | **strict equality** |
| `BUGBOT_CLEAR` | `detectBugbotClear` (`review-bugbot.mjs`) | **every non-blank line** must consist only of one or more repeated `BUGBOT_CLEAR` tokens; repetition tolerates a known streaming artifact, while any prose is rejected |
| `BUGBOT_BLOCKED` | `detectBugbotBlocked` (`review-bugbot.mjs`) | **strict equality with the entire trimmed capture** |

**The strict-equality tokens (`PLAN_READY`, `SAFETY_APPROVED`, `BUGBOT_BLOCKED`) are the most
fragile thing in the CLI.** Any non-whitespace decoration in their comparison scope — a
glyph, a reset sequence, or a collapsed spinner line — turns the verdict into "not
approved" and jams the gate. `BUGBOT_CLEAR` is equally hostile to prose or decoration even
though it tolerates repeated bare tokens.

### The rule this imposes on the output layer

> **Never write anything to a stream that is being captured for token detection.**

A live region, a progress rail, a celebration, or a "collapse to a static line on
completion" flourish in a captured verdict stream will break the affected Class-D
detector: after the final line for last-line detectors, or anywhere in the capture for the
whole-capture Bugbot detectors. Concretely: the writer must close and clear any live region
**before** a captured subprocess starts, and must not append to that stream when it ends.

---

## Live hazards

Recorded here because they are real today, not hypothetical.

1. **AIOS prints Class-D token literals inside its own human prose.** For example
   `build.mjs` prints `✓ local Bugbot clear (BUGBOT_CLEAR)`, and both `relay.mjs` and
   `build.mjs` print failure lines naming the token they did *not* receive
   (`… without MERGE_READY`). `relay.mjs` also prints `✓ spec SPEC_READY (score …)`.

   These are **safe for the detectors**, which parse the *model's* captured output rather
   than AIOS's own stdout. They are **not safe for a naive external `grep`** of AIOS output.
   Anything consuming a verdict must use the Class-E channel (`--hook-protocol`,
   `VERDICT=`), never a substring search of human output.

2. **Decoration and markers must never share a line.** No gutter, no rail glyph, no colour
   wrapper. A marker line is written raw.

3. **`--json` / `--porcelain` are a stronger promise than "no colour".** stdout carries the
   payload and nothing else; every human-facing byte goes to stderr. 30+ scripts accept one
   of these flags, several with local branches — which is why the output mode must be passed
   in explicitly by the command, never inferred globally from `process.argv`.

---

## Not markers (recorded to stop future false positives)

Names that look like markers and are not. Each was misidentified once already:

| Name | What it actually is |
|---|---|
| `CORE_MARKERS` (`onboard-inspect.mjs`) | workspace file/dir names (`aios.yaml`, `0-context`, …) used to *detect a workspace*. Nothing to do with output. |
| `MIN_HEALTHZ_TOKEN_LEN` (`inbox-coordinator.mjs`) | a minimum length for a health-check auth token |
| `HELP_TOKENS` (`cli/dispatch.mjs`) | accepted CLI arguments (`-h`, `--help`, `help`) |
| `BASE_SHA_MARK` (`build.mjs`) | a filename (`.aios-build-base-sha`) |

---

## Changing this contract

1. Update this file **first**, in the same PR as the code.
2. Add or update the case in `test/cli-output-contract.test.mjs`.
3. Update every consumer named in the tables above.
4. Removing or renaming a Class-E marker is a **breaking change** to `hooks/`, CI, and any
   operator tooling — treat it as a versioned change, not a refactor.
