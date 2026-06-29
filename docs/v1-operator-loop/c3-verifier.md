Productize the scaffold's adversarial-verify + rubric-gated self-correction pattern (`scaffold/.claude/skills` + `rubrics/`) into the loop's verification step. This is AIOS's core differentiator — "verification is the value."

**Does two checks against the C2 ledger:**
1. **Evidence check** — every shareable claim is grounded in a real manifest signal; no hallucinated or unsupported statements.
2. **Tier-policy check** — nothing admin/private leaks into a team/external digest; redactions are correct.

On failure, the rubric gates a bounded correction loop (re-draft → re-verify), not an infinite retry. Must surface a clear verifier **status** (pass / corrected / failed) the human sees before approving.

**Acceptance:**
- Independent verifier (separate from the drafter) with an explicit must-pass rubric.
- Bounded correction (cap the loop; on exhaustion, fail loud, don't ship).
- Verifier status is a first-class field in the run output, consistent across CLI + cockpit.
- Tuned so it's not so slow/verbose that users skip the ritual (roadmap risk #1) — keep daily near-zero, reserve the full pass for weekly.

Gates C5 (weekly closeout). Daily (C4) may run a lighter/no verification by design.