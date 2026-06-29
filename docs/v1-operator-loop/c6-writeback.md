Nothing leaves the machine or mutates state without explicit human approval. The weekly closeout (C5) ends here.

**Three approval-gated write targets:**
- **Local** — write the brief to `3-log/`, digest to `4-shared/` (correct tiers).
- **Team Brain sync** — push the tier-safe digest + next-week actions (`aios push`; brain rejects admin-tier at the boundary, 422).
- **PM / Linear** — create/update next-week actions as tasks via the existing projection rails (AIO-72: brain tasks table is canonical → one-way projection to Linear). Do NOT write Linear directly; go through the brain task model.

**Acceptance:**
- Each target is individually approvable (user can approve local but not sync, etc.).
- Default is no-write; approval is explicit and per-target.
- PM writeback flows through AIO-72's projection (brain → Linear), not a direct Linear write — keeps the canonical source intact.
- A rejected approval leaves zero side effects.

Reuses the AIO-72 projection rails — this is wiring, not new infra.