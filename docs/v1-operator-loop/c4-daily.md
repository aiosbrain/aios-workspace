The lightweight daily cadence — the habit driver. Reads a 1-day C1 manifest and answers exactly three questions, nothing more:

1. **What changed** since yesterday (decisions logged, deliverables moved, PRs).
2. **What's blocked** (stale blockers, things waiting on someone).
3. **What I owe today** (open next-actions, carried-over from yesterday via C7).

**Design rules (friction is the enemy):**
- Seconds to read, one screen / a few CLI lines. No verbose verification, no approval gate — daily is read-only orientation, not a deliverable.
- ONLY essential context. If in doubt, cut it. The daily's job is to keep the user oriented and feed the weekly, not to be a mini-report.
- Optional light evidence inline (a path), but skip the full C3 verifier pass.
- Runs identically from CLI and cockpit.

**Acceptance:**
- Daily run produces the three-section orientation in under a few seconds from a warm workspace.
- Carry-over from prior day is visible (via C7).
- No writeback, no sync — purely local orientation.

Ships first of the two cadences: cheapest, exercises C1, and builds the ritual before the heavy weekly lands.