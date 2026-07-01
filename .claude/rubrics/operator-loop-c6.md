---
kind: rubric
applies_to: operator-loop-c6
budget: 0
pass: no-must-fails
---

# Rubric — Operator Loop C6 (approval-gated writeback)

Machine-checkable success criteria for C6 — the deterministic, approval-gated promotion of verified
C5 artifacts into the workspace spine (and, via the owner's own later `aios push`, onward to the
brain / PM). Constitution §2: success criteria live here, never invented ad-hoc inline. This file is
the must-pass contract AND the grading sheet the independent validators score the diff against
(receiving only this rubric + the diff + the C6 acceptance in `docs/v1-operator-loop/c6-writeback.md`).

`budget: 0` — C6 has NO LLM step; it is mechanical promotion of already-verified content. Its core
principle: tier-safety is DETERMINISTIC and derived from the verified artifact, and C6 performs NO
network egress — the only send remains the user's separate `aios push`.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| P1  | Default-deny: `aios loop writeback <stamp>` with NO target flag is a preview — it prints the plan and writes nothing. A rejected/omitted target leaves zero side effects | code-read | yes |
| P2  | The three targets are independently approvable and may be combined: `--local` writes the admin brief + tier-safe digests into the spine; `--sync` stages tier-safe digests + next-week task rows and prints `aios push` guidance; `--pm` stages tier-safe task rows for the AIO-72 brain→Linear projection. Documented target semantics match the code | grounding-read | yes |
| P3  | Only shippable digests promote: a `digest-<aud>.md` must exist AND its verifier status ∈ {pass, corrected}. A `.FAILED.md`, a missing digest, or an absent/unparsable `verifier-<aud>.json` is un-promotable with a specific safe skip code | code-read | yes |
| P4  | The admin owner brief is NEVER syncable: written with `access: admin`, placed under the log spine (`3-log/`), `targets` = `["local"]` only; its existing frontmatter is not double-stamped | grounding-read | yes |
| P5  | Admin-tier next-week actions NEVER become synced task rows. `tasks.md` is single-tier (file-level `access:`), so rows are filtered to ≤ the file tier with admin EXPLICITLY removed regardless of the ceiling; admin actions remain only in the admin brief | grounding-read | yes |
| P6  | Tier → folder + frontmatter is correct and deterministic: team digest → `2-work/` (`access: team`), external digest → `4-shared/` (`access: external`), brief → `3-log/` (`access: admin`) | grounding-read | yes |
| P7  | Idempotent re-run: task `row_key` is a stable title hash (`nw-…`); `mergeTaskWriteback` upserts by key (no duplicates); only the six core fields are emitted so a clean table is never widened | code-read | yes |
| P8  | The leak backstop FAILS CLOSED and never re-derives: the manifest comes only from a stamp-matched `--manifest` or the persisted `closeouts/<stamp>/manifest.json`; when unavailable, every syncable write is withheld (`no-manifest`) and the CLI exits non-zero — only the admin brief may still write | code-read | yes |
| P9  | An independent leak re-sweep (`sweepForLeaks` + `aboveAudienceStrings`) runs on the exact bytes of every syncable digest/row before writing; any hit withholds that entry (`leak-detected`) and gates the CLI non-zero. No LLM judgment is part of the tier gate | code-read | yes |
| P10 | Every `Skip` and the `--json` payload are audience-safe BY CONSTRUCTION: enum codes + target + artifact + audience + counts only — never a raw action title, path, row text, or leak string; the brief is referenced by path only, never its content; a final sweep guards the JSON string | grounding-read | yes |
| P11 | C6 performs NO network egress: it stages local files only and never calls the brain, Linear, or `aios push`. Writes to `2-work/`/`4-shared/`/`tasks.md` are local staging for a future user-run `aios push`, which re-gates tiers at push time | code-read | yes |
| P12 | C6 uses NO LLM (deterministic promotion) — no drafter, no `CompletionFn`, no `--remote`, no new egress to a model | code-read | yes |
