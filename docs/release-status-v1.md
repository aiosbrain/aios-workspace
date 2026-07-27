# V1.0 Release Status

> Snapshot: **2026-07-22** · ship target **Friday 2026-07-24** · toolkit `v0.7.0` → `v1.0.0`
> Scope decision (2026-07-22, John + Chetan): **the Unified Inbox GUI is cut from V1.0.**
> V1.0 ships **CLI-first**: the Verified Operator Loop + the `aios` command surface + brain sync.
> The inbox GUI and all GUI-send/ingestion extensions return in **v2** (labeled `v2` in Linear).

## Shipped ✅

| Area | Evidence |
|------|----------|
| **Verified Operator Loop C1–C8** (collector, evidence ledger, verifier, daily, weekly, writeback, habit, telemetry) | AIO-123–130 all Done; `docs/v1-operator-loop/README.md` reconciled; `npm run check:v1-linear` green |
| **Operator Loop project** | ~112 issues Done (cockpit AIO-141–145/318, timeline AIO-203–210, AM epic AIO-211–235, ship pipeline AIO-237–262, P0 hardening AIO-349–357, blockers AIO-362–377) |
| **Unified Inbox CLI (kept)** | 20 issues Done incl. I-01–I-16 core, outbox + Gmail send lane (AIO-392: CLI part shipped; GUI part deferred), recovery hardening AIO-447–449/453/457 |
| **Inbox GUI removal** | PR #377 merged 2026-07-22 (28 files); full `npm test` green post-cut |
| **Ship/build pipeline** | `aios spec` / `ship` / `roadmap-run` / `pr` (AIO-156 epic, v0.6.0) + async gates/resume (AIO-236–239) |
| **Toolkit self-update** | `aios update` 3-way merge + `--contribute` (AIO-463/466/468) |
| **Brain sync contract** | `docs/brain-api.md` v1.11 (context-health ingest included) |

## Merging 🔀

| PR | What | State |
|----|------|-------|
| #378 | `fix(spec-eval)`: SR17 spec-gate regression — stop over-tripping on thorough single-feature specs (was blocking `aios spec eval` + the `aios ship` spec gate) | CI running |
| #243 | dependabot radix patch | rebasing, merge when green |

Merged today as part of this pass: #377 (inbox GUI cut), #239, #244 (dep patches).

## Open for Friday 🎯 (hardening + demo only — no new features)

| Issue | What | Why it's in |
|-------|------|-------------|
| AIO-450 | V1.0 beta demo readiness — fused use cases and demo flows | The demo itself |
| AIO-358 | Define fused core demo use cases in Team Brain | Demo content |
| AIO-359 | Chetan IC workstation onboarding + overview deck | Demo audience |
| AIO-361 | Stefan sales demo flow (Gog CLI email) | Demo content |
| AIO-445 | Onboarding path polish | Install-flow hardening |
| AIO-469 | Worktree hydration bug (`link-worktree-env.sh` first-run failure — reproduced twice today) | Hardening |
| AIO-446 | Document/test all v1 connectors before ship | Release honesty |
| — | Comprehensive release review (security / quality / coverage / promise-vs-delivery / install / integrations / harnesses) — in progress, findings feed remediation | Hardening |
| — | Docs scope sweep: release-readiness.md + inbox docs still say the GUI is in V1 scope | Release honesty |

### Needs a decision / small fix before Friday
- **PR #371** (CodeRabbit config) — fails lint+format; fix or defer.
- **PR #362** (GUI adapter error surfacing) — CodeRabbit finding open; fix or defer.
- **RELEASE-CHECKLIST.md** John-only items: brand/LICENSE reconciliation, open/closed-source boundary.
- **Dogfood criterion**: the 3-consecutive-week dogfood gate (AIO-122 exit criteria) is not met — accept as known gap for the beta or restate the criterion.

## Deferred to v2 🧊 (canceled + labeled `v2` in Linear, 2026-07-22)

Inbox GUI + extensions: AIO-452, 454, 455, 456, 458, 459 (GUI runtime/polish/journal/thread/reply/archive) · AIO-460, 461, 462 (Slack / WhatsApp / Telegram-personal ingestion) · AIO-394 (Pencil design pass) · AIO-464 (Telegram surfaces epic) · AIO-465 (agent channel bridge) · AIO-441–443 (GUI explorations) · AIO-467 (Codex asks) · PR #363 closed unmerged (GUI Gmail reply send — the CLI outbox lane of AIO-392 shipped and stands).

Also post-V1: AIO-232/235 (AM loop leftovers), #359 (system-architecture rubric), #273 (slack-personal scopes), #212 (draft), major dep bumps (vite 8, @types/node 26, actions).

## Deliberately out of scope
No new features anywhere. Feature-shaped review findings go to the Linear `v2` backlog, not into code.
