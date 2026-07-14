# V1 Operator Loop status reconciliation

Captured 2026-07-14 before Linear cleanup. This is the read-only code-footprint pass required
before changing release states. It distinguishes implemented code from release evidence and does
not treat a passing unit suite as longitudinal dogfood proof.

| Issue(s) | Linear state | Code status | Reachability | Release interpretation |
|---|---|---|---|---|
| AIO-123–130 (C1–C8) | Done | code-confirmed in `src/operator-loop/`, `scripts/loop.mjs`, and `test/operator-loop/` | CLI commands live; C5/C8 are also wired through the cockpit server | Implementation-complete; AIO-122 exit evidence remains separate. |
| AIO-139 | Done | code-confirmed in `src/operator-loop/time/` and the time collector/tests | CLI/operator-loop source | No demo trap found. |
| AIO-140 | Done | code-confirmed in `src/operator-loop/comms/` and comms source/tests | Daily loop consumes the source | No demo trap found. |
| AIO-141 | Done | code-in-other-repo: meeting/stakeholder code is in `aios-team-brain` | Team Brain meeting surface exists | Legitimate cross-repo scope. |
| AIO-142 | Todo | code-absent; only the domain spec exists | n/a | V1 stretch cut; do not claim shipped. |
| AIO-143 | Done | cockpit task surface is in `aios-team-brain`; workspace owns task-file compatibility | User-facing task surface exists | Legitimate cross-repo scope; this close-out repaired `tasks-team.md` resolution and safe JSON writeback. |
| AIO-144 | Done | code-confirmed across workspace telemetry and cockpit maturity code | Cockpit panel is wired | No demo trap found. |
| AIO-145 | Done | code-in-other-repo: Linear reconciliation lives in Team Brain PM sync | API/worker surface, not a nav claim | Legitimate cross-repo scope. |
| AIO-362–377 | Done | code-confirmed by the named hardening paths and operator-loop tests | CLI/runtime behavior | Retain Done, subject to the release test and evidence gates. |
| AIO-398 | In Progress | partial implementation present in the ship pipeline | CLI-only | Keep open. |
| AIO-399 / AIO-406 | Todo / Backlog | pilot/E2E not complete | demo-critical | Tag blockers; do not close or defer automatically. |
| AIO-381 | In Progress | Inbox implementation is active in John's worktrees | read-only audit only | Keep open and do not block or modify implementation. |

The live Linear query initially reported C1–C8 as missing because
`scripts/check-v1-linear-drift.mjs` fetched only the first 250 team issues. Direct identifier
queries confirmed all eight were Done in `V1.0 — Verified Operator Loop`; the release-hygiene
change fixes the checker to follow every cursor page.
