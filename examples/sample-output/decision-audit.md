# Decision-Log Audit Report

**Log audited:** `examples/sample-engagement/03-status/decision-log.md`
**Audit date:** 2026-06-05
**Coverage:** 20 of 20 entries examined per rule
**Result:** 9 confirmed findings across 5 rules (5 candidates rejected as false positives)

## Summary by Severity

| Severity | Count |
|----------|-------|
| High | 1 |
| Medium | 4 |
| Low | 4 |
| **Total** | **9** |

## Summary by Rule

| Rule | High | Med | Low | Total |
|------|------|-----|-----|-------|
| type-impact-mismatch | 1 | 0 | 0 | 1 |
| missing-rationale | 0 | 2 | 2 | 4 |
| bad-audience-tag | 0 | 1 | 0 | 1 |
| orphaned-client | 0 | 1 | 0 | 1 |
| missing-decided-by | 0 | 0 | 1 | 1 |
| stale | 0 | 0 | 1 | 1 |

---

## Findings by Rule

### type-impact-mismatch (1)

#### High

- **Entry 10** — Phase-2 pricing set at the standard rate tier. Setting phase-2 pricing is a high-stakes, commercially binding decision: the Impact text itself states it "Sets the phase-2 commercial terms and shapes engagement economics going forward." A pricing anchor of this kind is hard to reverse and carries significant downstream consequences, so it should be Type 2 or Type 3. Marking it Type 1 (reversible/low-stakes) materially understates its weight.

---

### missing-rationale (4)

#### Medium

- **Entry 20** — Rationale ("Milestone reached in track 2.1") merely restates the decision that a milestone/delivery occurred; it gives no reason why the decision was made.
- **Entry 19** — Rationale ("First delivery milestone for the ops LJ") restates the decision (a Day 1 session was delivered) without giving any reason for it.

#### Low

- **Entry 15** — Rationale ("Governance track 3.1 deliverable") only labels the item as a track deliverable; it does not state a reason for the decision.
- **Entry 13** — Rationale is only a track label ("Governance track 3.1") — it categorizes the work but gives no actual reason for the decision.

---

### bad-audience-tag (1)

#### Medium

- **Entry 11** — Audience column value is "external", which is not one of the allowed values (admin | team | client).

---

### orphaned-client (1)

#### Medium

- **Entry 18** — Decision #18 has Audience = client but has no corresponding entry in `client-surface-log.md`. The surface log contains only entries matching decisions #1, #10, and #16. The other client-audience decisions (#1, #10, #16) all have matching surface-log rows; #18 is the only client-audience decision with no corresponding surfaced communication/artifact entry. (#11 is excluded because its audience is "external", not "client".)

---

### missing-decided-by (1)

#### Low

- **Entry 8** — The "Decided By" column is empty (blank between the rationale "Maps to the operations team's daily workflows" and the impact "Ops LJ build can start"). No decision-maker is attributed for approving the Ops LJ curriculum outline.

---

### stale (1)

#### Low

- **Entry 13** — Dated 2026-03-20, which is >30 days before 2026-06-05. Impact explicitly states "Awaiting SC sign-off (pending)" — the AI usage policy first draft was circulated for SC review but no later entry records the SC sign-off being obtained. Follow-up remains pending/awaiting with no resolution noted in the log.

---

## Notes

- Entry 13 appears under two rules (missing-rationale, low; and stale, low) — these are independent defects on the same row.
- 5 candidate findings were rejected during adversarial verification as false positives and are not included above.
