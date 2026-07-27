# Thin spots — what this pack is honest about

v0 is four weeks of curation distilled into a usable pack. These are the places where
it is still thin, unproven, or deliberately deferred — read this before treating any
component as battle-tested. (Curation-with-provenance cuts both ways: we cite where
patterns came from, and we tell you where ours haven't been pressure-tested yet.)

## Thin (shipped, but young)

- **The hooks are new code.** The *patterns* are proven (they're adapted from guards
  running in production in the AIOS toolkit and from disler's hook repos), but these
  specific scripts have unit-level testing only (synthetic payloads), not months of
  field time. Expect to tune the destructive-command regexes to your team's habits.
- **The adapters are conformance-tested, not mature field infrastructure.** Claude
  Code, Codex, and OpenCode now ship working native adapters and fixtures. Local CLI
  loading and adversarial smoke evidence does not substitute for sustained team use,
  managed deployment, or cross-version testing.
- **`models/routing.yaml` is a convention, not an engine.** Nothing enforces the lane
  policy mechanically yet — MG6 (bulk output needs frontier review) is enforced by
  rubric + process. The category-routing pattern it encodes is proven elsewhere
  (oh-my-opencode, Amp); our YAML contract for it is new.
- **The eval lab is a validation tool, not a benchmark.** It automates isolated
  N-run scenarios, trajectory grading, summaries, and optional semantic judging.
  Five scenarios—including clean/P1 review calibration and red/green simplification
  variants—are still far too small for model comparisons, and live proof runs only
  validate the lab/runtime path used on that date.

## Deferred (deliberately not in v0)

- **The pipeline CLI.** A tracker-agnostic `plan → build → review → simplify → PR` loop
  (one command per stage, worktree-isolated, fail-closed gates) exists in the AIOS
  toolkit (`aios build/ship/spec/simplify/consolidate-findings`) but is coupled to its
  workspace + Linear conventions. Extracting it as a standalone CLI is the headline V1
  item — v0 ships the methodology (skills/rubrics/agents) that the CLI automates, and
  [`modules/aios-cli`](../modules/aios-cli/) documents using it in place today for
  teams willing to take the ecosystem coupling.
- **Rung 4 / unattended loops (Ralph).** Powerful and real (see PROVENANCE), but only
  safe behind sandbox + comprehensive tests + rollback + cost caps, all four. We'd
  rather ship the ladder that earns it than the loop that skips it.
- **Durable agent memory (Beads-style issue graph).** Compatible add-on; adopting it is
  an infrastructure decision a team should make deliberately, not a default.
- **GAR / governed-autonomy runtime.** Mechanical enforcement of the autonomy ladder
  (rung tracked per work-category, gates that move the leash automatically on
  evidence). Today the ladder is process + hooks; the runtime is roadmap.
- **CI-side enforcement.** The same guards and review gates as a CI stage (so the rules
  hold for humans and agents alike, and for agents running outside the harness).
  Today: local hooks + branch protection.
- **Team Brain / telemetry integration.** Plugging harness activity (lanes used,
  escapes, ladder movement) into a shared team surface. Available today by adopting
  [`modules/aios-cli`](../modules/aios-cli/) (an explicit ecosystem opt-in); a
  looser-coupled telemetry story for non-AIOS teams remains roadmap.

## Known trade-offs

- **Shell adapters require a POSIX shell + `jq`.** Safety normalization or policy
  failure maps to a block; formatting stays non-blocking. A stripped environment can
  therefore stop edits/commands until its dependency issue is fixed.
- **The stop gate allows a stop after one continuation** to prevent recursion. Claude
  Code and Codex use native Stop behavior; OpenCode uses weaker `session.idle` prompt
  injection. A red session can still end for human review and must not be reported as
  complete.
- **No hook is the outer security boundary.** Runtime sandboxing/permissions, managed
  policy, review, and CI must enforce organization-critical controls even when local
  hooks are unavailable or bypassed.
- **Portable policy still needs native code.** Claude/Codex normalize in shell while
  OpenCode requires a TypeScript plugin. The protocol reduces policy duplication; it
  does not erase runtime churn or make lifecycle strength identical.
