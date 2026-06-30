The behavior-design spine that makes the loop a habit, not a feature people forget. This is the layer the roadmap doc under-specifies and is the differentiator for a behavior-designed product.

**Three mechanics:**
- **Trigger** — how/when each cadence is invoked. Daily: a low-friction prompt (e.g. start-of-day cockpit nudge or a CLI one-liner). Weekly: an end-of-week trigger. Cheap to start, no setup tax.
- **Continuity** — unresolved items carry forward: yesterday's "owed" that's still open resurfaces today; the week rolls up the daily carry-overs so Friday is assembly, not archaeology. Feeds back into C1's collector as a source.
- **Reinforcement** — a lightweight streak / "you closed N weeks" / identity signal ("you're someone who closes their week"). Reward the ritual, not the volume.

**Acceptance:**
- Daily loop is genuinely low-friction (seconds, one action) — friction is the enemy of the habit.
- Carry-over is automatic and visible (the user sees what rolled over and why).
- Some continuity signal exists across runs (don't over-gamify — this is an operator tool, not a game).

Threads through C4 (daily) and C5 (weekly) rather than being a standalone surface.

## Continuity Store

C7's first local contract is `.aios/loop/continuity/actions.json`. It is intentionally under
`.aios/loop/` like run manifests, so it is local-only and never part of the sync plan.

```json
{
  "version": 1,
  "actions": [
    {
      "id": "next-1",
      "title": "Follow up on the API decision",
      "status": "open",
      "tier": "team",
      "createdAt": "2026-03-31T12:00:00Z",
      "due": "2026-04-01",
      "source": { "path": "3-log/decision-log.md", "row": "7", "tier": "team" }
    }
  ]
}
```

Open actions become `carryover` signals in both daily and weekly manifests. Closed statuses
(`done`, `closed`, `cancelled`, `canceled`, `resolved`) are skipped. Missing or unresolvable
tiers are default-denied and recorded in `manifest.excluded[]`.
