# V1 — Verified Operator Loop (Milestone 1)

> The buildable decomposition of **Milestone 1 ("Solo loop magical")** from
> [`docs/product-roadmap-three-milestones.md`](../product-roadmap-three-milestones.md).
> Source document for Linear epic **AIO-122** and its sub-issues **AIO-123–130**.
> Engineering approach is governed by [`docs/ENGINEERING-CONSTITUTION.md`](../ENGINEERING-CONSTITUTION.md).

## Component index

| # | Component | Spec | Status |
|---|-----------|------|--------|
| C1 | Source collector + run manifest | [c1-collector.md](./c1-collector.md) | ✅ merged |
| C2 | Evidence ledger | [c2-evidence-ledger.md](./c2-evidence-ledger.md) | ✅ merged |
| C3 | Verifier + rubric-gated correction | [c3-verifier.md](./c3-verifier.md) | ✅ merged (`aios loop verify`) |
| C4 | Daily light loop | [c4-daily.md](./c4-daily.md) | planned |
| C5 | Weekly closeout | [c5-weekly.md](./c5-weekly.md) | planned |
| C6 | Approval-gated writeback | [c6-writeback.md](./c6-writeback.md) | planned |
| C7 | Habit + continuity layer | [c7-habit.md](./c7-habit.md) | planned |
| C8 | Loop telemetry + dogfood instrumentation | [c8-telemetry.md](./c8-telemetry.md) | planned |

The five workflow domains that feed the loop have their own specs under
[`domains/`](./domains/).

---

## What V1 is

V1 = **Milestone 1 of the three-milestone roadmap** ("Solo loop magical"), shipped as the **Verified Operator Loop**. This is the product wedge — the one thing that must feel magical before we expand to the team loop (M2) or harness catalog (M3).

> Roadmap source: `aios-workspace/docs/product-roadmap-three-milestones.md` (M1). This epic is the buildable decomposition of that milestone.

**Promise:** "AIOS helps me run my work. It knows what changed, what I decided, what is blocked, what I owe next, and what is safe to share — and it proves its work."

## Two cadences (the design decision)

The loop runs at two weights. Daily is the habit; weekly is the payoff.

| Cadence | Weight | Job | What it pulls |
| -- | -- | -- | -- |
| **Daily** | Lightweight, low-friction, fast | Keep me oriented + build the ritual | ONLY essential context: what changed since yesterday, what's blocked, what I owe today. Light/no verification. Seconds to read. |
| **Weekly** | Heavy, verified, approval-gated | Close my week with proof | Full collect across the week → private operator brief + tier-safe shareable digest → independent verifier + rubric-gated correction → human-approved writeback to brain/PM → next-week actions. |

Daily reduces the friction of the weekly: by the time Friday comes, carry-over items are already surfaced and triaged, so the weekly closeout is assembly, not archaeology. Daily = trigger + fast reward; weekly = the verified deliverable. This is the habit-formation spine, not just two report sizes.

## Cross-cutting constraints

- **Runs from CLI and cockpit against the same plan/review/approve model.** The cockpit is its own track (AIO-114) and does NOT have to host this as a home screen — we will design the ritual flow independently and see how it feels before deciding placement.
- **Tier policy is the safety boundary.** No admin/private content ever reaches a shareable digest or brain sync. Default-deny on missing `access:`.
- **Verification is the value, not parallelism.** Every shareable claim is backed by an evidence reference and passes the verifier before a human is asked to approve.
- **We assemble mostly-built parts.** Tiers/guards, brain-api v1.2, projection rails (AIO-72), and the weekly source inputs (Granola AIO-21, GitHub AIO-32) are already Done. The keystone is wiring them into the loop + instrumenting it — not greenfield.

## Suggested build sequence

1. **Substrate** — source collector + manifest (C1), evidence ledger (C2), verifier + rubric correction (C3).
2. **Daily light loop** (C4) — ships first; cheapest, builds the habit, exercises the collector.
3. **Weekly closeout** (C5) — the heavy verified pull; depends on the verifier.
4. **Writeback** (C6) wired onto the existing AIO-72 rails; **habit/continuity** (C7) threaded through; **telemetry/dogfood** (C8) running continuously.

## Exit criteria (must all hold to call V1 done)

- Three consecutive dogfood **weekly** runs per active user with **zero** admin/private-tier leaks.
- Daily loop run on the majority of working days across the dogfood window (habit signal).
- Median weekly closeout under **20 minutes** after initial setup.
- Shareable digest passes must-pass verifier criteria in **≥90%** of accepted runs.
- **≥70%** of accepted weekly runs produce approved next-week actions.
- Loop runnable from **both** cockpit and CLI against the same plan/review/approve model.

## Out of scope for V1 (post-loop)

Team Brain aggregation of weekly artifacts (M2), harness registry/catalog + eval telemetry (M3), and the platform "organs" track (context engine, policy engine, action layer, feedback loop — Chetan's parallel workstream). These reuse V1's artifacts but do not gate V1.
