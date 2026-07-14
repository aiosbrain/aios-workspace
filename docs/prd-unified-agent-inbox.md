# PRD — Unified Human-Agent Inbox (the AIOS Workstation meta-inbox)

**Status:** Draft — vision-stage, in review. Unscheduled; no work should start without a
separate scheduling decision.
**Last updated:** 2026-07-04 · **Owner:** John
**A note on the name:** John's ask referenced "the AIO-225 workstation." AIO-225 is
specifically the `/council` cross-model harness (Done) — a different, narrower thing. The
concept this doc is actually about is the **AIOS Workstation**: the Cockpit + CLI + operator
loop taken together as one individual-contributor surface. That's the "workstation" this PRD
extends. Corrected here so the two don't get conflated in Linear history.
**Related:** [`AIO-166`](https://linear.app/je4light/issue/AIO-166) (Agentic Ergonomics —
the human operating layer, esp. EE1/EE12/EE13/EE14), [`AIO-140`](https://linear.app/je4light/issue/AIO-140)
(Communication domain), [`AIO-226`](https://linear.app/je4light/issue/AIO-226) (Agentic
Maturity Loop — instinct distillation), [`docs/prd-executor-mcp-gateway.md`](./prd-executor-mcp-gateway.md),
[`docs/prd-council-harness.md`](./prd-council-harness.md),
[`docs/v1-operator-loop/domains/asks-queue.md`](./v1-operator-loop/domains/asks-queue.md)
(the existing v1 contract this PRD builds on top of, not instead of)

---

## 1. Summary

Right now a solo operator running several parallel agent workstreams (one epic per agent,
each running its own `aios roadmap-run` / `ship` loop) has no single place to see everything
demanding their attention. Blocking questions from N parallel orchestrators compete with
Slack messages, WhatsApp texts, Telegram pings, email, and calendar holds — each in its own
tool, each interrupting on its own schedule.

**The thesis:** aggregate every demand on human attention — agent asks *and* external
comms — into one inbox inside the AIOS Workstation, drainable on the operator's own cadence
(a "focus mode" batch-and-process pattern rather than constant interruption). Over time,
every answer the operator gives becomes training signal for a triage layer that starts
auto-resolving the repeats and escalating only what's genuinely novel — a learned second
layer of orchestration sitting above the per-epic orchestrators, eventually capable of
re-steering them directly on the operator's behalf.

This is a **vision doc, not a build spec.** Most of what it describes is already scoped as
concrete, buildable Linear issues under AIO-166 — this PRD's job is to argue for the shape of
the whole, show how the pieces compose, and stage what's genuinely new against what already
exists so nothing gets rebuilt by accident.

## 2. What already exists (read this before scoping any work)

This is not a green field. Three shipped/in-flight pieces already cover large parts of this
vision:

| Piece | State | Covers |
|---|---|---|
| **AIO-167 / EE1** — `aios asks` non-blocking escalation queue | In Progress | The core append-only, dedup'd, severity-tagged queue for **agent-originated** asks (blocker/decision/fyi), with a working CLI (`list/show/resolve/drain/harvest`) and capture hook. This *is* the inbox store — v1 schema at `.aios/loop/asks/asks.ndjson`. |
| **AIO-140** — Communication domain (unified notification layer) | Done | Detectors that already normalize Slack/email/calendar activity into tier-tagged `comms` signals, feeding the same dispatch path EE1 reuses (`comms/sender.ts`). |
| **AIO-166 EE12/EE13/EE14** — two-way reply, cockpit/menubar surface, principles-trained triage agent | Backlog (deferred, "documented as complete, pick-up-able") | Exactly the two-way-reply, visual-surface, and learned-autonomy pieces of this vision — already scoped by title, just not fleshed out or prioritized. |
| **AIO-226** — Agentic Maturity Loop (instinct distillation) | In Progress | `aios instincts distill` (AM4b) already turns operator correction events into homunculus records via an injectable LLM call. This is the training substrate the triage agent needs — a second one should not be built. |
| **`prd-executor-mcp-gateway.md`** (AIO-399; replaces AIO-242) | Pilot proposed; predecessors AIO-400/AIO-409 in progress | AIOS-managed, read-only GitHub gateway only: pinned self-hosted Executor, Brain-owned member credentials/policy/audit, and exactly seven GET-backed GitHub tools. It is not a shipped generic channel aggregation layer. |
| **CLI channel access** (gog, slack-cli, wacli/whatsapp, bird/X, OpenClaw's Telegram) | Shipped, per-channel | Read/search/send already works per channel today — this PRD does not reimplement any of them. |

**What this PRD actually adds on top:** (a) one aggregation layer that reads from *both*
the asks store and the comms detectors instead of them being two separate surfaces, (b) the
explicit "focus mode batches N parallel orchestrators' blocking questions" workflow, (c) the
argument for *why* EE14's triage agent should be trained on the combined inbox (not asks
alone), and (d) the recursive orchestrator-of-orchestrators idea as a named, staged, later
phase — not yet a spec.

## 3. Goals / Non-goals

**Goals**
- **G1.** One inbox surfaces both agent asks (EE1) and external comms signals (AIO-140:
  Slack/email/calendar, extended to WhatsApp/Telegram/X) in a single severity-tagged,
  drainable list — reusing both stores' existing schemas, not replacing either.
- **G2.** Running several parallel `aios roadmap-run --epic` streams at once produces zero
  blocking stalls: every orchestrator's blocking question routes through the existing
  non-blocking asks path (EE1) instead of pausing that stream. "Focus mode" (EE2, `aios
  mode`) is the batching mechanism — process the backlog in one sitting, not on interrupt.
- **G3.** Every inbox resolution the operator performs is captured as a labeled
  observation and fed into the *existing* instinct-distillation pipeline (AM4b, AIO-226) —
  not a second, parallel learning system.
- **G4.** EE14's principles-trained triage agent, once built, is trained on the *combined*
  inbox (asks + comms), not asks alone, since both are "things demanding a human decision."
- **G5.** The recursive orchestrator-of-orchestrators concept — a meta-agent that reads
  triage-resolved answers and re-steers individual epic-agent loops without operator
  involvement for routine unblocks — is named and staged here as a real later phase, not
  hand-waved, but explicitly **not spec'd or built** until P3/P4 prove out.
- **G6.** Every existing tier/privacy invariant holds: asks stay `admin`-tier local-only
  (per the EE1 contract); comms items keep whatever tier AIO-140's detectors already assign;
  nothing this PRD adds makes previously-local content syncable.

**Non-goals (v1 — P0/P1 only)**
- **N1.** Not rebuilding the asks store, its NDJSON contract, lock protocol, or CLI — EE1's
  contract (`docs/v1-operator-loop/domains/asks-queue.md`) is reused as-is.
- **N2.** Not automating any irreversible action (a Slack/WhatsApp *send*, a merge, a
  payment). The triage agent (P4, staged) recommends/drafts; the existing draft-vs-send
  approval gate (`voice-and-rules` skill) still governs any outbound message regardless of
  who — human or triage agent — composed it.
- **N3.** Not building EE14's learned triage agent as part of this PRD's shippable scope.
  It's staged as P4, gated on a real decision-capture corpus existing first (EE4) and an
  accuracy bar being met — consistent with AIO-166's own build paradigm (slice 1 now, later
  slices documented as pick-up-able, not built ahead of need).
- **N4.** Not a new comms channel client. WhatsApp/Telegram/X integration means reading
  through the existing `wacli`/OpenClaw Telegram/`bird` CLIs into the same comms-detector
  pattern AIO-140 already established for Slack/email/calendar — not new per-channel code.
- **N5.** Not committing to the recursive orchestrator-of-orchestrators architecture yet —
  P5 in this doc is a *placeholder for a future spec*, not a design.

## 4. Users & motivating scenarios

| Persona | Today | With the unified inbox |
|---|---|---|
| Operator running 4 parallel `aios roadmap-run --epic` streams | Each orchestrator's blocking question stalls that stream until answered in real time — the "orchestration glass ceiling" AIO-166 already names | All 4 streams' asks land in one queue; operator enters focus mode, drains 20 items in one pass hours later, nothing stalled in the meantime |
| Operator mid-flow-state on deep work | A Slack DM, a WhatsApp text, and an agent's "is this the right approach?" all compete for attention on three different notification surfaces | One inbox, one place to check, one cadence to check it on |
| Operator processing the daily backlog | Manually triages every item fresh, no memory of how similar ones were answered before | Repeat-shaped items (P4, once built) get a suggested answer drawn from how the operator resolved the same shape of ask before, sourced from the AM4b instinct pipeline |
| A future team member scaling this pattern beyond John | No equivalent exists; this is currently John's own tooling | Same inbox pattern is product-general once proven personally — mirrors AIO-166's "personal harness first → AIOS product" arc |

## 5. Architecture

```text
External channels                    Agent / loop asks
(Slack · email · calendar via        (EE1 hook capture: idle-Notification / Stop-tail
 AIO-140 detectors; WhatsApp ·        from N parallel `aios roadmap-run --epic`
 Telegram · X — extend the           orchestrators running concurrently)
 same detector pattern)
        │                                        │
        ▼                                        ▼
  comms/detectors.ts                      hooks/asks-capture.mjs
  (existing, AIO-140)                     → asks/store.ts (existing, EE1)
        │                                        │
        └────────────────┬───────────────────────┘
                          ▼
          Unified inbox aggregation layer  ← NEW, this PRD's P0/P1 scope
          - reads both stores' existing schemas unmodified
          - normalizes to one severity-tagged view (blocker | decision | fyi)
          - groups by source + focus-mode session
                          │
                          ▼
        `aios inbox` CLI + Cockpit surface (EE13)  ← NEW surface, existing store contracts
                          │
            ┌─────────────┴──────────────┐
            ▼                             ▼
   Operator drains manually        Decision-capture (EE4) records every
   (v1 — this is the whole         resolution as a labeled observation
   shippable P0/P1 loop)                   │
                                            ▼
                              `aios instincts distill` (AM4b, AIO-226 — REUSED, not rebuilt)
                                            │
                                            ▼
                         Learned triage agent (EE14)  ← STAGED, P4, own rails required
                         - auto-resolves high-confidence repeats
                         - escalates novel/high-stakes items only
                         - never sends without the existing draft-vs-send gate
                                            │
                                            ▼
              Orchestrator-of-orchestrators  ← STAGED, P5, no spec yet
              - reads triage-agent-resolved answers
              - re-steers/unblocks individual epic-agent loops
              - itself only ever surfaces its OWN asks back into the same inbox
                (it does not get a side channel that bypasses the audit trail)
```

The managed Executor pilot (`prd-executor-mcp-gateway.md`) is intentionally narrower than this
inbox: it can serve only the seven declared read-only GitHub operations when an inbox workflow
explicitly needs them. Slack, email, calendar, WhatsApp, Telegram, X, decision search, and LLM
calls do not route through that pilot, and no future connector is implied without its own contract
and security review. The council harness
(`prd-council-harness.md`) is a possible-but-optional future arbiter for genuinely ambiguous
items that warrant more than one model's opinion before escalating — noted as an idea, not
committed to any phase below.

## 6. Phasing & deliverables

| Phase | Deliverable | State |
|---|---|---|
| **P0 — Cross-source aggregation** | Extend the inbox read path to pull from both `asks.ndjson` (EE1) and AIO-140's comms signals into one sorted, severity-tagged list. No new store; a read-side merge only. | Proposed |
| **P1 — Focus-mode batching** | Wire `aios mode` (EE2, deep-work/orchestration) so entering focus mode with ≥2 parallel `aios roadmap-run --epic` streams routes every blocking question through EE1's non-blocking path — zero stalls, verified under real concurrent streams. | Proposed |
| **P2 — Cockpit surface + channel expansion** | Render the unified inbox in the Cockpit (EE13), grouped by source/severity, with resolve/reply actions (EE12 two-way reply). Extend AIO-140's detector pattern to WhatsApp/Telegram/X via the existing CLIs. | Proposed, depends on EE12/EE13 being picked up |
| **P3 — Decision-capture training corpus** | Every inbox resolution becomes a labeled observation feeding AM4b's existing instinct-distillation pipeline (no second pipeline). | Proposed, depends on EE4 |
| **P4 — Learned triage agent (EE14)** | Principles-trained agent auto-resolves high-confidence repeats from the combined inbox; escalates the rest. Ships behind explicit autonomy rails: escalate-not-remove default, audited sample of every auto-resolution, no irreversible sends. | Deferred — explicitly not started until P3's corpus + an accuracy bar exist |
| **P5 — Orchestrator-of-orchestrators** | A meta-agent reading triage-resolved answers to re-steer individual epic-agent loops directly. | Placeholder only — no spec written; a separate PRD is required before any scheduling decision |

## 7. Open questions

1. **Is inbox fragmentation actually the bottleneck, or a comfortable one?** AIO-166's own
   audit found the "17k permission clicks" framing was a mislabeled metric, and the real
   levers were correction-loops and context-switching, not interruption volume per se. This
   PRD should not proceed past P0/P1 without checking whether aggregating sources actually
   moves those levers, versus just centralizing something that wasn't the real friction.
2. **Same severity model for a Slack DM and an agent's blocker?** They have very different
   urgency and reply semantics (two-way conversation vs. resolve-and-move-on). P0 should
   validate whether one unified list is right, or whether comms and asks want a shared queue
   with source-specific reply affordances rather than one undifferentiated model.
3. **Access-tier boundary for the triage agent (P4).** It will read across `admin`-tier
   local content (asks, decisions, possibly comms) that must never sync. EE14's spec already
   says "own rails, escalate-not-remove, audited sample" — this PRD doesn't add new
   requirements here, just flags that P4 cannot start without that rail design being real,
   not aspirational.
4. **Where does P5 actually stop being "orchestration" and start being "the agent decides
   what to build next"?** Worth an explicit boundary in the eventual P5 spec — this PRD
   intentionally leaves it open rather than guessing.

## 8. Acceptance criteria (P0/P1 scope only — everything past P2 is too far out to gate yet)

- **AC1.** `aios inbox list` (or equivalent) surfaces both an EE1 agent ask and an AIO-140
  comms signal in one sorted, severity-tagged list, reading both existing stores unmodified.
- **AC2.** A focus-mode session running ≥2 parallel `aios roadmap-run --epic` streams
  completes with zero blocking stalls — every orchestrator question lands in the queue
  instead of pausing its stream, verified under real concurrency (not simulated).
- **AC3.** No existing tier invariant weakens: comms items keep their assigned tier; nothing
  admin-tier becomes syncable as a side effect of aggregation.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope creep into re-litigating or rebuilding all of AIO-166/AIO-140 | This PRD is explicitly additive — P0/P1 only touch the read/aggregation layer; every existing store, contract, and CLI stays as-is |
| Learned triage agent (P4) auto-resolves wrongly, eroding trust in the whole inbox | EE14's existing rails (escalate-not-remove, audited sample) carried over verbatim; no autonomy expansion without a measured accuracy bar first |
| "AIO-225" naming confusion recurs (it's the council harness, not this) | Corrected explicitly in this doc's header; this vision is filed as its own new issue, not attached to AIO-225 |
| Vision doc balloons into an unshippable everything-project | P0/P1 acceptance criteria are small and concrete; P3–P5 are explicitly deferred/placeholder per AIO-166's own "document the other slices, don't build ahead of need" paradigm |
| Building a second instinct-learning pipeline instead of reusing AM4b | G3/P3 explicitly reuse `aios instincts distill`; flagged as a hard requirement, not a suggestion |

## 10. References

- [`docs/v1-operator-loop/domains/asks-queue.md`](./v1-operator-loop/domains/asks-queue.md) — the v1 asks contract this PRD builds on
- [`docs/v1-operator-loop/domains/communication.md`](./v1-operator-loop/domains/communication.md) — the comms detector pattern to extend
- [`docs/v1-operator-loop/domains/maturity-loop.md`](./v1-operator-loop/domains/maturity-loop.md) — the instinct-distillation substrate (AM4b)
- [`docs/prd-executor-mcp-gateway.md`](./prd-executor-mcp-gateway.md) — proposed managed, read-only GitHub pilot; not a shipped generic channel gateway
- [`docs/prd-council-harness.md`](./prd-council-harness.md) — optional cross-model arbiter for ambiguous inbox items
- AIO-166 (Agentic Ergonomics epic), AIO-167/178/179/180 (EE1/EE12/EE13/EE14), AIO-140, AIO-226
- `voice-and-rules` skill — the draft-vs-send approval gate that governs any outbound action regardless of who composes it
