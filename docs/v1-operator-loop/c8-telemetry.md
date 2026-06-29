Make the epic's exit criteria measurable instead of vibes. Without this we can't tell if V1 is actually done, and it's the substrate M3 needs (cost/quality telemetry).

**Instrument per run:**
- Weekly closeout wall-clock time (→ median < 20 min).
- Verifier pass / corrected / fail rate (→ ≥90% must-pass on accepted runs).
- Tier-leak check: any admin/private content in a shareable digest = critical failure, count = 0.
- Next-week-action acceptance rate (→ ≥70%).
- Daily-loop run frequency across the dogfood window (habit signal).

**Privacy constraint (open roadmap question):** collect this **locally** — how much telemetry can we keep without violating AIOS's local-first posture? Default to on-device aggregates; nothing leaves without the same approval gate as C6.

**Acceptance:**
- A local dogfood dashboard / report shows the six exit-criteria metrics across runs.
- Tier-leak count is surfaced prominently (it's the one that's product-ending).
- Enough signal to declare each AIO-122 exit checkbox met or not.

Runs continuously through dogfood, not a one-shot task.