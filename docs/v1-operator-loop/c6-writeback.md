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

---

## Approval + egress (implementation)

C6 ships as `aios loop writeback <stamp>`, consuming a saved C5 closeout dir
(`.aios/loop/closeouts/<stamp>/`). The deterministic planner lives in
`src/operator-loop/writeback.ts` (`planWriteback`); the CLI in `scripts/aios.mjs` performs the writes.
**No LLM, no network egress** — the only thing that transmits is the user's own later `aios push`,
which re-gates every file's tier at push time.

### Target semantics

**Default-deny:** with no target flag the command is a preview — it prints the plan and writes
nothing. The three targets are independently approvable and may be combined.

| Flag | Writes | Syncable |
|------|--------|----------|
| `--local` | brief → `3-log/loop-brief-<stamp>.md` (`access: admin`) · team digest → `2-work/weekly-digest-team-<stamp>.md` (`access: team`) · external digest → `4-shared/weekly-digest-external-<stamp>.md` (`access: external`) | brief never (admin blocked by `buildPlan`); digests staged for a future `aios push` |
| `--sync` | tier-safe digests (idempotent with `--local`) + tier-safe next-week actions as rows in `3-log/tasks.md`; prints `aios push` guidance | staged for the team brain |
| `--pm` | tier-safe next-week actions as rows in `3-log/tasks.md` (idempotent with `--sync`); prints projection guidance | staged for brain→Linear (AIO-72) |

Any write into `2-work/`, `4-shared/`, or `3-log/tasks.md` is **local staging** for a future
`aios push` — C6 never pushes. Overlapping writes across flags are idempotent (stable per-`<stamp>`
filenames; `mergeTaskWriteback` upsert by `row_key`).

### tasks.md is single-tier — the load-bearing constraint

`buildPlan`/`aios push` gate tier **per file, never per row**, and `3-log/tasks.md` is in
`sync_include` at whole-file `access: team`. So C6 writes **only tier-safe rows** (≤ the tasks.md
file tier, with admin **always excluded**); admin next-week actions live exclusively in the
`access: admin` owner brief, which never syncs. Rows carry only the six core task fields
(`row_key`/title/assignee/status/sprint/due) so a clean table is never widened.

### Fail-closed leak backstop

Before writing any syncable digest or task row, C6 re-runs the deterministic leak sweep
(`sweepForLeaks` against `aboveAudienceStrings`) on the exact bytes about to hit the spine — belt and
suspenders over C5's own render-time sweep. Its corpus is the **exact manifest of the closeout**,
sourced only from a stamp-matched `--manifest` or the `manifest.json` persisted alongside the
closeout by `aios loop weekly`. C6 **never re-collects** a fresh manifest (a drifted workspace could
under-detect a leak). When no valid manifest is available, every syncable write is withheld
(`no-manifest`) and the command exits non-zero — only the admin brief may still be written.

Exit codes: `0` success/preview · `1` an approved target had nothing promotable · `2` tier-safety
withholding (`no-manifest` / `leak-detected`). Every `Skip` and the `--json` payload are audience-safe
by construction (enum codes + counts only; the brief is referenced by path, never its content).