---
kind: rubric
applies_to: operator-loop-c3
budget: 2
pass: no-must-fails
---

# Rubric — Operator Loop C3 (verifier + rubric-gated correction)

Machine-checkable success criteria for the C3 verifier. Constitution §2: success criteria live
here, never invented ad-hoc inline. This file is BOTH the runtime must-pass contract the
verifier encodes AND the grading sheet the independent validators score the diff against
(receiving only this rubric + the diff + the C3 acceptance criteria in `docs/v1-operator-loop/c3-verifier.md`).

`budget:` here is the verifier's own correction budget for the WEEKLY cadence (daily is 0:
deterministic-only, no LLM correction). The pass rule is `no-must-fails`.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| V1  | An ungrounded claim (zero evidence refs) is a must-fail and cannot be emitted; its raw text is never echoed into a finding | grounding-read | yes |
| V2  | Every evidence ref must resolve to a REAL `manifest.signals` entry (exact path + row + tier); a path/row match with a mismatched tier is fabricated grounding → must-fail | code-read | yes |
| V3  | No above-audience claim text, path, or row leaks into any finding or the serialized `VerifierResult` for the target audience; redactions stay visible (count + tier) | grounding-read | yes |
| V4  | The correction loop is bounded by the cadence budget (daily 0, weekly 2); on exhaustion with remaining must-fails the status is `failed` and the caller must not ship | code-read | yes |
| V5  | `VerifierResult.status` (`pass`/`corrected`/`failed`) is a first-class field, identical in shape across the CLI and (future) cockpit; `findings`/`advisory` carry only audience-safe `claimPreview` + `detail` | code-read | yes |
| V6  | The daily path runs deterministic checks only (no LLM); `semanticCheck` is advisory-only and never changes status; advisory findings are sanitized (preview re-derived, detail scrubbed) so the hook cannot leak above-audience content | code-read | yes |
| V7  | A mixed-evidence claim (`requiresIndependentSupport`) must-fails by default and is cleared ONLY by a blocking `supportCheck` certification or by correction into an audience-safe claim — never by an advisory hook | grounding-read | yes |
| V8  | Claim previews are built from the TRUSTWORTHY manifest tier (worst-case `admin` when a ref does not resolve), so a spoofed/fabricated ref tier cannot coax claim text into a lower-tier output | code-read | no |
