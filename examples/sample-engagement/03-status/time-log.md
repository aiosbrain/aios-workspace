---
access: admin
---

# Agent session time-log — local only · never synced · edit via `aios time reconcile`, not by hand

<!-- Synthetic demo data (AIO-139). Written by `aios time capture` from ~/.claude session logs;
     per-row tier is authoritative (default-deny). File is admin-tier and never syncs; the weekly
     closeout surfaces only a { tag, durationMin } roll-up, never the repo alias or block id. -->

| ID | Start | End | Repo | Runtime (min) | Tag | Tier | Confirmed | Task Ref |
|----|-------|-----|------|---------------|-----|------|-----------|----------|
| 9f3c1a2b04 | 2026-03-30T14:02:00Z | 2026-03-30T15:11:00Z | acme-platform | 69 | engineering | team | yes | NR-142 |
| 4d77e0c9a1 | 2026-03-30T11:20:00Z | 2026-03-30T11:58:00Z | acme-platform | 38 | research | team | yes | NR-140 |
| b1e6602f8c | 2026-03-30T09:05:00Z | 2026-03-30T09:35:00Z | acme-brief | 30 | communication | team | no | |
| 27aa93d5e0 | 2026-03-29T16:40:00Z | 2026-03-29T17:25:00Z | acme-platform | 45 | strategy | team | yes | NR-138 |
| e08b4417d2 | 2026-03-29T13:10:00Z | 2026-03-29T13:32:00Z | personal-notes | 22 | admin | admin | no | |
