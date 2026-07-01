---
kind: rubric
applies_to: operator-loop-c5
budget: 2
pass: no-must-fails
---

# Rubric — Operator Loop C5 (weekly closeout)

Machine-checkable success criteria for the C5 weekly closeout. Constitution §2: success criteria
live here, never invented ad-hoc inline. This file is the must-pass contract AND the grading sheet
the independent validators score the diff against (receiving only this rubric + the diff + the C5
acceptance criteria in `docs/v1-operator-loop/c5-weekly.md`).

`budget:` mirrors the verifier's weekly correction budget. The pass rule is `no-must-fails`. C5
introduces the loop's first LLM step (the drafter); its core principle is that the drafter is
UNTRUSTED and tier-safety is DETERMINISTIC — enforced by tier-bounded input + the C3 verifier +
the C5 text-leak sweep, never by an LLM answer.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| W1  | One run emits BOTH artifacts at the correct tiers: a private owner brief (admin-tier, owner sees all) and a shareable digest redacted to the target audience; verifier status is shown before any approval | grounding-read | yes |
| W2  | The drafter INPUT is tier-bounded: for a shareable audience the drafter/LLM receives only `projectManifest(audience)` — signals filtered to `visibleTiers(audience)` with `excluded[]` stripped; no above-audience signal or `excluded` ref/reason is ever sent to the model | grounding-read | yes |
| W3  | C5 sends NO admin-tier content off-machine; the owner brief is composed locally with no LLM call on admin content | grounding-read | yes |
| W4  | A deterministic C5 text-leak sweep (`sweepForLeaks`, no LLM) withholds any claim or action whose TEXT contains an above-audience signal's summary/path/row — even when it cites a legitimately allowed ref (the gap C3 does not cover); a residual whole-document sweep guards the rendered output | grounding-read | yes |
| W5  | The drafter is SEPARATE from and UNTRUSTED by the verifier; C3 re-verifies every claim's refs independently; the shareable digest is rendered from the POST-correction per-audience ledger, never the original failing ledger | code-read | yes |
| W6  | Verifier status (`pass`/`corrected`/`failed`) is surfaced before approval; `failed` or any leak-withheld claim makes the digest non-shippable, gates the CLI non-zero, and produces no shippable digest path (only a clearly-marked `digest-<aud>.FAILED.md`) | code-read | yes |
| W7  | Bounded correction uses the weekly budget (2) via the injected `correct` seam (`makeCorrectFn`, which closes over the projection + audience); no unbounded LLM loop | code-read | yes |
| W8  | No LLM `supportCheck`/semantic judgment is part of the tier-safety gate; mixed admin/team/external claims are PREVENTED by the tier-bounded input (the drafter can only cite ≤-audience refs) | grounding-read | yes |
| W9  | `VerifierResult` and the `--json` stdout are audience-safe: no raw/corrected ledger, no owner-brief content, no admin or above-audience text/path/row; the brief is referenced by PATH only; each audience block's next-week actions are filtered to tier ≤ that audience; admin actions appear only in the owner-only file | grounding-read | yes |
| W10 | Next-week actions are produced and approvable: shareable actions are drafted from the ≤-audience projection; owner/admin actions are derived DETERMINISTICALLY from full local signals (`deriveAdminActions`); `--all` dedupes/merges actions by normalized title at broadest visibility | grounding-read | yes |
| W11 | Remote LLM is opt-in via explicit `--remote` consent (requires `ANTHROPIC_API_KEY`, fails loud otherwise), documented in `c5-weekly.md`; the offline default emits valid artifacts with a visible "synthesis skipped" notice | code-read | yes |
| W12 | Artifacts carrying admin-tier content (brief, full next-week actions, manifests) are written under `.aios/loop/` (outside `sync_include`), never into the synced spine | grounding-read | yes |
| W13 | The same plan/review/approve model runs from the CLI (`aios loop weekly`); cockpit parity is deferred to a follow-up | code-read | no |
