# Domain spec — Generation Engine (Prescribe, generalized past a maturity tip)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Generative Education** initiative (epic **AIO-257**, issue **AIO-260 / GE3**) — see
[`docs/prd-generative-education.md`](../../prd-generative-education.md). Third and last
build-ready epic in this initiative; **hard-gated** on Workflow Inventory (GE1) and Competency
Taxonomy (GE2) both landing first (this domain's Assess step reads both).

## Why

The Maturity Loop (`docs/v1-operator-loop/domains/maturity-loop.md`, epics AM1–AM8) already closes
a real Assess→Place→Prescribe→Re-assess cycle today: AM1 captures per-session signals, **AM2
(`hooks/maturity-brief.mjs`, shipped) injects a 3-line placement-plus-tip at `SessionStart`**, AM5
observes corrections, AM6 distills instincts. This is the exact mechanism the Generative
Education vision doc calls "the Generation Engine" — it already exists, for one narrow payload
type (a maturity coaching tip). This domain **widens that one payload type**, it does not build a
second, parallel injection mechanism. Building a second `SessionStart` hook that also emits
`additionalContext` would violate Constitution §4 (well-bounded modules; the Operator Loop /
existing hook is the composition point) and would race AM2's own hook for the same context slot.

## Reuse (shipped, KEEP)

- **`hooks/maturity-brief.mjs`** (AM2, `SessionStart`) — emits exactly one
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` line today,
  a 3-line placement+tip string. This domain extends the string this hook can emit; it does not
  add a second hook.
- **`.aios/loop/maturity/sessions.ndjson`** (AM1) and the observation/instinct stores (AM5/AM6) —
  the existing local, append-only signal substrate this domain's Assess step reads from, in
  addition to Workflow Inventory (GE1) and Competency Taxonomy (GE2).
- **Agentic Maturity placement** (`scripts/analyze/aem.mjs`) — read as-is, never modified (owned
  by the in-flight AM/CE rollout, AIO-211).
- **`AskUserQuestion` + Decision Capture** (`src/operator-loop/decisions/store.ts`,
  `hooks/decision-capture.mjs`, AIO-170) — the existing human-in-the-loop approval and corpus
  mechanism. When Prescribe's answer is an automation-proposal, it is presented via
  `AskUserQuestion` and any approve/reject is captured by the *existing* Decision Capture hook.
  This domain adds **no new hook** for approval — reusing this exact pipeline is the whole point.
- **`weekly-synthesis` workflow-harness shape** (`scaffold/.claude/skills/weekly-synthesis/`) —
  the Draft→Grade→Correct, rubric-gated pattern this domain's own harness skill copies (see
  Skill/tool surface in the PRD, §7).

## Contract

### Widened `SessionStart` payload (extends AM2's existing string, does not add a field)

AM2 today emits a fixed 3-line string. This domain changes *what informs that string's content*,
not its wire shape — `additionalContext` remains a single string (Claude Code's `SessionStart`
hook contract does not support a structured payload), so "lesson vs. automation-proposal" is
encoded as a **prefix convention** the string itself carries:

```
AEM L4 · weakest axis: Autonomy/leash · tip: hand whole pieces of work to sub-agents...
```
becomes, when the Generation Engine has something more specific to prescribe:
```
AEM L4 · weakest axis: Autonomy/leash · lesson: <short framing, 1 sentence>
```
or:
```
AEM L4 · weakest axis: Autonomy/leash · automation-proposal: <workflow name> is at
automation_readiness 8/10, costs ~3.5h/week — run `aios learn --propose <workflow>` to review.
```

The Assess→Place step is unchanged (still Agentic Maturity's placement). **Prescribe** is the new
logic: given the placement plus Workflow Inventory + Competency Taxonomy signals, decide among
`{tip (existing default), lesson, automation-proposal}` and render exactly one line.

### Prescribe decision (deterministic precedence, not a free-form model choice)

1. If a Workflow Inventory entry owned by this actor has `automation_candidate: true` **and** no
   automation-proposal for that workflow has been surfaced in the last 7 days (checked against
   the existing decision corpus, AIO-170, to avoid repeat-nagging) → **automation-proposal**.
2. Else if Competency Taxonomy has a `competency_weak_areas` entry for this actor's `job_family`
   **and** no lesson for that category has been surfaced in the last 3 days → **lesson**.
3. Else → the existing AM2 maturity tip, unchanged (this domain's floor behavior is today's
   shipped behavior — it never regresses a session to silence).

This precedence is stated as a hard rule, not left to model judgment, precisely so SR15
("refutation — no underspecified must-path") has nothing to refute: the decision is fully
deterministic given the three input stores.

### Automation-proposal delivery (the actual "unit of value," per the PRD's wedge)

`aios learn --propose <workflow>` (a new CLI command, invoked by the operator after seeing the
`SessionStart` prompt) reads the Workflow Inventory entry, drafts a short automation plan via the
`generation-engine` workflow-harness skill (Draft → Grade against a new rubric,
`.claude/rubrics/generation-engine.md` → Correct, same loop shape as `weekly-synthesis`), and
presents it via `AskUserQuestion` for approve/reject/defer. An **approve** does not auto-ship
code — v1's acceptance criterion is a reviewed, human-approved plan handed to the operator, not an
autonomously-merged PR (shipping the approved plan is out of scope for this slice; it would reuse
the existing `aios ship` pipeline in a later slice).

## Scope

**In scope (v1):** the widened `SessionStart` string logic, the deterministic Prescribe
precedence, `aios learn --propose <workflow>`, the `generation-engine` skill + rubric, the
`AskUserQuestion`/Decision-Capture approval reuse.

**Deferred:**
- Auto-shipping an approved automation-proposal (reuses `aios ship` in a later slice, explicitly
  not this one).
- Reading Cognitive Ergonomics (`ce_band`) as a real Assess input — **gated on AIO-211's Phase B
  calibration harness (W5) returning a verdict.** Until then, this domain's Assess step does not
  read `ce_band` at all (not even as a shadow signal) — adding an unconfirmed-calibration input to
  a new decision path would be exactly the kind of premature promotion AIO-211's own design
  (`ce_band` "always badged shadow · uncalibrated") exists to prevent. This is a hard dependency,
  not a nice-to-have.
- Org-level generation telemetry (lessons/automations generated per team) — belongs to the
  Flywheel/ROI ledger (`flywheel-roi-ledger.md`), which is explicitly not epic'd yet.

## Build with

opus / high — the decision precedence touches a shipped, in-production hook (AM2) and introduces
a new human-approval-gated CLI surface; errors here are a session-disrupting regression risk, not
a cosmetic one.

## Dependencies

- **Hard:** Workflow Inventory (GE1) schema frozen. Hard: Competency Taxonomy (GE2) schema frozen.
- **Hard:** AIO-211's calibration verdict, but only as a *scope-limiter* — this domain ships and
  is useful with CE excluded entirely; it does not block on CE, it blocks *CE's inclusion*.
- **Soft:** AM2 (`hooks/maturity-brief.mjs`) — already shipped; no version/timing dependency, this
  domain edits that file directly once GE1/GE2 land.

## Tier-safety posture

No new sync surface. `SessionStart` context is local-only (never leaves the machine — matches
AM2's own posture). `aios learn --propose` reads Workflow Inventory data via the existing
`GET /api/v1/company-graph` team-tier gate (inherits GE1's tier posture verbatim); no new tier
surface is introduced.

## Acceptance

- With no Workflow Inventory automation-candidate and no Competency Taxonomy weak area present for
  an actor, `SessionStart` output is byte-identical to today's AM2 behavior (regression guard).
- With a qualifying `automation_candidate: true` Workflow Inventory entry present, `SessionStart`
  emits the `automation-proposal:` line exactly once per 7-day window per workflow (verified
  against the decision corpus, not a separate cooldown store).
- `aios learn --propose <workflow>` produces a plan, grades it against
  `.claude/rubrics/generation-engine.md`, and presents it via `AskUserQuestion`; an approve/reject
  is captured by the existing Decision Capture store (`.aios/loop/decisions/decisions.ndjson`)
  with no new store introduced.
- Demonstrated by new tests: `test/operator-loop/generation-engine-prescribe.test.mjs` (the
  deterministic precedence logic) and `test/operator-loop/generation-engine-propose.test.mjs` (the
  CLI + rubric-gate + Decision Capture integration, using injected fixtures for Workflow
  Inventory/Competency Taxonomy).

## Implementation

Edits: `hooks/maturity-brief.mjs` (widen the emitted string per the Prescribe precedence). New:
`src/operator-loop/generation-engine/prescribe.ts` (the deterministic decision logic),
`scaffold/.claude/skills/generation-engine/SKILL.md` + `generation-engine.workflow.js` (Draft→
Grade→Correct, modeled on `scaffold/.claude/skills/weekly-synthesis/weekly-synthesis.workflow.js`),
`.claude/rubrics/generation-engine.md` (product-repo rubric, mirrors
`.claude/rubrics/operator-loop-c5.md`'s shape — table `ID | Criterion | Check method | Must`), a
`cmdLearn` command in `scripts/aios.mjs`.
