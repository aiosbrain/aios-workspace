---
kind: rubric
applies_to: calibration-verdict
budget: 0
pass: thresholds-match-code
---

# Rubric — CE Calibration Verdict (Phase B / AIO-216)

The deterministic decision contract for the Cognitive Ergonomics (CE) shadow-band calibration
test. AIO-190 Phase A records a per-day CE band for a calibration corpus but never scores it;
Phase B (`scripts/analyze/ergonomics-calibrate.mjs`) runs the statistical test that decides its
fate: **MERGE** it into the autonomy axis, **PROMOTE** it to a real 6th axis, or **HOLD**.

This file is the human-readable mirror of the code constants. `budget: 0` — there is no fix loop;
the pass rule is `thresholds-match-code`: every value below must equal the exported constant of the
same name in `ergonomics-calibrate.mjs`. A dedicated drift test parses the `CV\d+` rows of the
Thresholds table and asserts equality, so this rubric can never silently diverge from the code.

## The decision

Over the paired non-null days in the window, compute the **tie-corrected Spearman rank
correlation** `rho` between the CE band (0–4) and the already-computed autonomy axis (read-only,
never recomputed here). Then:

- **MERGE** — `|rho| ≥ MERGE_RHO`. The band tracks autonomy so closely it is redundant; fold it in.
- **PROMOTE** — `|rho| < PROMOTE_RHO` **and** the band's point-biserial correlation against the
  outcome metric (`OUTCOME_METRIC`) is significant (`p < SIG_P`) **and positive** (`r > 0`). The
  band is independent of autonomy yet still predicts *higher* outcome quality → it earns its own
  axis. A significant *negative* point-biserial (band>0 ↔ *worse* outcome) does not satisfy the
  contract and HOLDs.
- **HOLD** — everything else: the buffer zone `PROMOTE_RHO ≤ |rho| < MERGE_RHO`, an insignificant
  point-biserial, a *significant-but-negative* point-biserial, or a degenerate (constant /
  zero-variance) series where a correlation is undefined. HOLD is also the safe result of any
  degeneracy — it never emits a false PROMOTE.
- **NOT_ENOUGH_DATA** — fewer than `MIN_PAIRED_DAYS` paired non-null days. Short-circuits before any
  correlation is computed, so no `rho` is ever reported on an under-minimum window.

## Thresholds

| ID  | Constant         | Value             | Verdict rule |
|-----|------------------|-------------------|--------------|
| CV1 | MERGE_RHO        | 0.7               | MERGE when \|rho\| >= 0.7 |
| CV2 | PROMOTE_RHO      | 0.5               | PROMOTE candidate when \|rho\| < 0.5 (+ significant point-biserial) |
| CV3 | SIG_P            | 0.05              | point-biserial significant when p < 0.05 |
| CV4 | MIN_PAIRED_DAYS  | 14                | NOT_ENOUGH_DATA when n < 14 |
| CV5 | OUTCOME_METRIC   | axes.verification | outcome-quality series for the PROMOTE point-biserial |

`OUTCOME_METRIC = axes.verification` (not `overall`) is deliberate: `overall` is the mean of all
five axes *including autonomy*, and correlating a candidate new axis against an outcome that
re-embeds autonomy would weaken the very independence claim PROMOTE is testing. Verification is the
maximally autonomy-independent single axis.
