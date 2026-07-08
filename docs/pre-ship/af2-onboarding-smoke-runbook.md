# AF2 — Onboarding smoke test runbook + insight log template

Owner: john@john-ellison.com
Parent epic: Agent-first onboarding. Linear child: **AF2 — Onboarding smoke test runbook (fresh identity)**

## Why

We ship the agent-first onboarding path without ever having run it end-to-end from a
truly fresh identity. A repeatable, documented smoketest with a brand-new brain member
captures real friction (missing steps, silent failures, unclear prompts) **before** ship,
instead of discovering it in a customer's first hour.

## What

Produce two documents (both **new files to create** — neither exists yet):

- `docs/pre-ship/af2-onboarding-smoke-runbook.md` — the operator runbook, phases 0–8.
- `docs/pre-ship/dogfood/onboarding-run-TEMPLATE.md` — the insight-log template an
  operator copies per run.

The runbook documents the following phases. Each phase step below references either a
real repo file (see **Integration points**) or a **runtime artifact** produced inside the
scaffolded workspace during the run (not a repo path).

| Phase | Steps |
|-------|-------|
| **0. Prep** | Self-serve a fresh brain member + key; if self-serve unavailable, admin creates one; record `{handle}`. Record the created member id + key id for teardown (see Tier-safety). |
| **1. Agent handoff** | Paste the AF1 prompt only (from `docs/pre-ship/af1-agent-onboarding-contract.md`). |
| **2. Scaffold** | Run `scripts/scaffold-project.sh` with `{handle}-workspace` flags. |
| **3. Validate** | Run `validation/validate-all.sh .`; expect exit **0**. |
| **4. Brain** | Create the runtime `.env` and `aios.yaml` **inside the scaffolded workspace** (runtime artifacts, not repo files); run `aios status` (via `scripts/aios.mjs`); expect exit **0**. |
| **5. Profile** | Run `aios onboard` CLI (GUI only if the operator requests it). |
| **6. MCP** | Optional: run `aios mcp`; confirm `brain_status` succeeds. |
| **7. Push** | Push a `team`-tier stub file under `2-work/` in the scaffolded workspace (runtime artifact; see Runtime artifacts) via `scripts/aios.mjs` push when connected. |
| **8. Debrief** | Fill the insight log from the template. |

### New files to create

All four paths below are **new**. Their repo parents are verified: `docs/pre-ship/`
already exists (it holds `af1-agent-onboarding-contract.md`) and `test/` already exists;
`docs/pre-ship/dogfood/` is a **new subdirectory** the builder creates alongside the
template.

| Path | Purpose | Created by |
|------|---------|-----------|
| `docs/pre-ship/af2-onboarding-smoke-runbook.md` | The runbook (phases 0–8). | Builder |
| `docs/pre-ship/dogfood/onboarding-run-TEMPLATE.md` | Insight-log template (new `dogfood/` dir). | Builder |
| `test/onboarding-runbook.test.mjs` | Structural test of the two deliverables (see Testability). | Builder |
| `docs/pre-ship/dogfood/onboarding-run-$(date +%Y-%m-%d).md` | One dated insight log per operator run (copy of the template). `$(date +%Y-%m-%d)` is replaced with the run date at execution time. | Operator, at run time |

### Runtime artifacts (not repo files, not builder deliverables)

Created **inside the scaffolded workspace** during a run and torn down at debrief — never
committed to this repo and never resolved as integration points. These are workspace-local
paths relative to the scaffolded `{handle}-workspace`, not repo paths:

- `.env` — workspace environment file (Phase 4).
- `aios.yaml` — workspace config (Phase 4).
- `2-work/smoke-test.md` — the `team`-tier push stub (Phase 7).

## Interface-first — required runbook structure (contract)

The two deliverables have a fixed, test-checked structure. The builder MUST author the
runbook to these exact anchors so the acceptance test asserts against **spec-defined
literals**, not builder-chosen strings:

- **Phase headings:** the runbook contains nine headings, one per phase, each matching the
  regex `^##+ Phase [0-8]\b` (i.e. `## Phase 0` … `## Phase 8`).
- **Teardown section:** the runbook contains a heading matching `^##+ Teardown\b`, and under
  it these four **exact** checklist lines (verbatim substrings the test greps for):
  - `- [ ] Delete or deactivate the brain member (member id recorded in Phase 0)`
  - `- [ ] Revoke the API key (key id recorded in Phase 0)`
  - `- [ ] Scrub or delete the workspace .env`
  - `- [ ] Delete the team-tier push 2-work/smoke-test.md`
- **Template rows:** the template contains a markdown table with a header row whose columns
  include `Phase`, `Pass/Fail`, and `Friction notes`, followed by nine data rows whose first
  cell matches `Phase [0-8]`.

Because these literals are fixed by this spec, the teardown assertion is not
self-satisfiable: the test checks for spec-mandated strings the builder cannot rename.

## Acceptance criteria

All bullets are observable — file presence, exit code, or a named test assertion against the
fixed literals above.

1. `docs/pre-ship/af2-onboarding-smoke-runbook.md` exists and contains nine phase headings
   matching `^##+ Phase [0-8]\b` (Phase 0 through Phase 8).
2. `docs/pre-ship/dogfood/onboarding-run-TEMPLATE.md` exists and contains a table with columns
   `Phase`, `Pass/Fail`, and `Friction notes`, and nine data rows (`Phase 0` … `Phase 8`).
3. `node --test test/onboarding-runbook.test.mjs` exits **0**. The test asserts, against the
   produced files:
   - **3a** — the runbook has all nine `## Phase [0-8]` headings.
   - **3b** — the template table has the three named columns and nine `Phase [0-8]` rows.
   - **3c** — the runbook contains a `## Teardown` heading and all four **verbatim** teardown
     checklist lines quoted in *Interface-first* above (brain member, API key, workspace
     `.env`, and `2-work/smoke-test.md`).

`spec eval` is **not** applied to the runbook: the runbook is an operator document, not a
spec, so grading it against the spec-readiness rubric (SR1–SR16) is out of scope and is not a
builder-closure gate. See *Scope*.

## Builder vs operator closure

- **Builder delivers:** `af2-onboarding-smoke-runbook.md` + `onboarding-run-TEMPLATE.md` +
  `test/onboarding-runbook.test.mjs`, all merged; acceptance bullets 1–3 pass in CI. Closure
  is fully deterministic — every gate is a file-presence or `node --test` exit code, with no
  dependency on any LLM verdict.
- **Operator verifies (out of builder scope):** performs a real fresh-identity run and commits
  `docs/pre-ship/dogfood/onboarding-run-$(date +%Y-%m-%d).md` with pass/fail recorded per phase 0–8.
  Deliverable correctness (headings, rows, teardown coverage) is proven by the builder test in
  bullet 3; the operator run proves real-world usability, not builder closure.

## Well-bounded module

One narrow surface: two markdown deliverables plus a single structural test that reads only
those two files. The test reaches into no sibling domain — it does not run onboarding, does
not touch the brain, and does not import product code; it asserts document structure only.

## Integration points

Existing repo files this spec references (all resolve in the tree):

- `docs/pre-ship/af1-agent-onboarding-contract.md` — source of the Phase 1 prompt.
- `scripts/scaffold-project.sh` — Phase 2 scaffolder.
- `validation/validate-all.sh` — Phase 3 validator.
- `scripts/aios.mjs` — the `aios` CLI entrypoint used in phases 4–7 (`status`, `onboard`,
  `mcp`, and the Phase 7 push).

All other paths named in *What* are either **new files to create** (see that heading) or
**runtime artifacts** produced inside the scaffolded workspace (see that heading); neither
is a repo integration point and neither is expected to resolve in the repo tree.

MCP verification (Phase 6) is a **manual** runbook step exercised through the live `aios mcp`
command in `scripts/aios.mjs`; the `brain_status` check is performed by the operator. No
automated MCP test file is created or referenced by this spec.

## Deps

Depends on the AF1 prompt being stable (`docs/pre-ship/af1-agent-onboarding-contract.md`
merged). Blocked by AF1 and AF3 in Linear. No new npm/tooling dependencies — the builder
test uses the built-in `node --test` runner already used elsewhere in the repo.

## Scope

**In scope:** the runbook, the insight-log template, and the structural builder test for both.

**Out of scope / deferred:**
- CI-driven smoketest automation.
- Automating the fresh-identity brain-member provisioning.
- GUI onboarding walkthrough (CLI is the documented default).
- Running `spec eval` / spec-readiness grading against the runbook (the runbook is an operator
  doc, not a spec).
- The operator's real fresh-identity run and the dated dogfood log (operator responsibility,
  not builder closure).

## Build-with

Build-with: **sonnet / low**. This is documentation plus one structural test — no architecture
or algorithm work.

## Tier-safety

The smoketest creates real, tier-sensitive state. The runbook MUST document teardown for
each, so repeated fresh-identity runs do not orphan resources. The four teardown items map
1:1 to the verbatim checklist lines in *Interface-first* and are asserted by bullet 3c:

- **Phase 0 brain member + key:** after debrief, delete (or deactivate) the member and revoke
  the key created for the run, using the member id + key id recorded in Phase 0. A run MUST NOT
  leave orphaned brain members or live keys.
- **Phase 4 `.env` key:** the real key written to the scaffolded workspace `.env` MUST be
  removed (delete the workspace or scrub `.env`) at debrief so no live key persists on disk.
- **Phase 7 push:** the `2-work/smoke-test.md` stub is pushed with the tier tag `access: team`
  only, then deleted after verification.

### Signal-contract conformance

- The two builder deliverables and `test/onboarding-runbook.test.mjs` **emit no signals** and
  author no new signal path; the test reads files only and persists no durable state.
- The only tier-tagged signal in the flow is the **Phase 7 operator push**, which is emitted
  through the **existing** `aios` push path in `scripts/aios.mjs` — no new emit surface is
  created here. The runbook MUST document that push as carrying the tier-tagged shape used by
  that path, i.e. the `access` field set explicitly to `team` (`access: team`). The runbook
  MUST NOT instruct the operator to push at any wider tier. This tier-tagged shape is the same
  one `scripts/aios.mjs` already produces; this spec references it and adds none of its own.

## Testability

- **Builder (automated, deterministic):** `node --test test/onboarding-runbook.test.mjs`
  exits **0**, asserting the deliverables' structure and teardown coverage per acceptance
  bullet 3 (3a headings, 3b template columns/rows, 3c teardown heading + four verbatim
  checklist lines). No LLM step gates builder closure.
- **Operator (manual, out of scope for builder closure):** a dated dogfood file with nine
  phase rows and pass/fail columns, produced by an actual run.

## Open questions / unresolved decisions

**None.** Every must-path decision is fixed by this spec:

- Deliverable paths, the new `docs/pre-ship/dogfood/` directory, and the test path are named
  above.
- The runbook/template structure is fixed to spec-defined literals in *Interface-first*.
- Builder closure is fully deterministic (file presence + `node --test` exit code); no LLM
  verdict gates it.
- Push tier is fixed at `access: team` through the existing `scripts/aios.mjs` path.
- The fresh-identity run and dated dogfood log are explicitly assigned to the operator and
  deferred out of builder scope.

There is no builder decision left open on any must-path.