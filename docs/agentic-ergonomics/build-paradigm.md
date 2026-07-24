# The Build Paradigm — Agentic Ergonomics

**Status:** the referenceable standard for how AIOS work is decomposed, ordered, built, and
shipped (AIO-172 / EE6, epic AIO-166). Harnesses and agents follow this document; when a harness
and this document disagree, fix one of them in the same change.

Sibling contracts: [`ENGINEERING-CONSTITUTION.md`](../ENGINEERING-CONSTITUTION.md) (spec-before-code,
typed tier-tagged signals), the [asks queue](../v1-operator-loop/domains/asks-queue.md) and
[decision capture](../v1-operator-loop/domains/decision-capture.md) domains (the harness this
paradigm feeds), and the AEM engine
([agentic-maturity](../v1-operator-loop/domains/agentic-maturity.md)) which scores whether we
actually work this way.

---

## 1. The paradigm in one sentence

**Build ONE slice now; document every other slice as a complete, pick-up-able issue** — so that
any agent (or any future you) can start any slice cold, with zero archaeology.

### What "one slice" means

- A slice is the smallest unit that **ships**: merged to main, gates green, acceptance criteria
  demonstrated live — not "code complete."
- A slice is **vertically whole**: store + capture + surface + CLI + spec + tests, not a layer.
- A slice declares its own boundary. Scope that was cut is *written down* at cut time (in the
  spec's scope section, a Linear comment, or a follow-up issue) — never silently dropped.

### What "pick-up-able" means

Every deferred slice is an issue that carries the sections in
[`aios-issue-template.md`](./aios-issue-template.md) — the canonical scaffold for
Linear issue bodies and local spec files. At minimum:

1. **What / why** — the behavior and the reason it matters, in the epic's language.
2. **Outcomes** — target state without over-constraining implementation.
3. **Concrete integration points** — file paths, module names, contracts it builds on.
4. **Acceptance** — observable criteria a builder can self-verify (Automated / Manual / Visual).
5. **Build-with** — the model/effort tier the work deserves (see §3).
6. **Deps** — which slices must land first.

Author with `aios spec init`, grade with `aios spec eval`, push to Linear with
`linear.mjs set-desc` or `create --template aios`.

The test: an agent with no conversation history can read the issue and start correctly. If the
issue needs a human to explain it, it is not done being written.

## 2. Build-order decision-making

Order is decided by **leverage per unit of attention**, not by architectural elegance:

1. **Actuators before dashboards** — ship the thing that changes behavior (a queue, a toggle)
   before the thing that measures it; then ship the measurement so the change is visible.
2. **Dependencies are real, everything else is preference.** A slice waits only on declared deps.
3. **The leverage layer outranks the polish layer.** Work that compounds (decision corpora,
   tighter specs, standards docs) beats work that decorates.
4. **Personal harness first → product.** Prove a capability as the owner's dogfood (this repo's
   own hooks/config), *then* generalize to the scaffold/product. Registering dogfood-only is a
   scope decision, stated in the PR, with the scaffold step recorded as a follow-up.
5. **Defer loudly.** Deferred ≠ forgotten: the deferred slice exists as a pick-up-able issue
   before the current slice merges.

## 3. Product principles

These recur in every shipped slice; treat them as defaults, deviate only with a written reason:

- **Deterministic before model-driven.** If a signal exists structurally (a tool call, a hook
  payload, a transcript field), capture it with zero-LLM code. Model judgment is for synthesis,
  not for plumbing.
- **Local-only until tier-cleared.** New personal-harness data is `admin`-tier under `.aios/`
  (gitignored, never synced) by default. Crossing to the brain or any shareable surface is its
  own slice with its own tier review (default-deny; the constitution's boundary).
- **Append-only stores, writer-honored locks.** Durable local state is an NDJSON event log folded
  to state on read; every writer honors the same lockfile; rewrites (GC/compaction) re-verify
  lock ownership before rename. Records are never mutated — later facts (outcomes, resolutions)
  are appended ops.
- **Hooks never disturb a session.** Capture hooks are dependency-free, bounded, and always exit
  0. A missed capture is acceptable; a blocked or slowed session is not. When extraction is
  ambiguous, capture unclassified (`null`) rather than guess.
- **Cards before axes.** New measurements render as standalone cards/readouts first. Folding a
  measurement into a scoring model (an AEM axis) requires its own researched calibration slice.
- **Human-meaningful metrics.** An attention metric measures the operator, not the machine —
  e.g. context switches count transitions between *user prompts*, because raw-event interleaving
  under concurrency measures the scheduler, not the person.
- **Idempotent + deduped at the write path.** Re-fires, re-harvests, and concurrent sessions must
  not flood a store; dedupe keys are checked inside the lock, and identity (unique id) is never
  conflated with the dedupe key.

## 4. How a slice ships (the harness loop)

The proven cycle — encode it in tooling (`aios ship`, AIO-156) rather than re-deciding it:

1. **Plan against the real code** (explore first; the plan names files, contracts, tests).
2. **Adversarial plan review** before building; blockers fix the plan, not the review.
3. **Build in a dedicated worktree** (never the primary checkout), at the issue's declared
   build-with tier.
4. **The orchestrator independently re-runs gates** — builder green is a claim, not evidence —
   plus a live smoke of the acceptance criteria.
5. **PR titled with the issue key**; the board moves itself (In Review on open, Done on merge).
6. **Bot-review loop with a stated merge bar:** CI green + no unaddressed finding above Minor
   that is *real*. Fix real findings with regression tests; decline speculative ones with a
   written rationale on the PR; never loop past the point of diminishing severity.
7. **Hygiene is part of shipping:** delete branches (local + remote), remove the worktree,
   fast-forward main, verify the board, record decisions/follow-ups on the issue.

## 5. Decisions are corpus

Every human decision the harness elicits — plan approvals, option picks, scope calls — is
captured as a structured record (`aios decisions`, EE4) and annotated with outcomes when known.
Standards like this document are *distilled from that corpus*: when a decision pattern repeats
three times, it belongs here; when this document and the corpus disagree, one of them is wrong —
update whichever it is.

## 6. Fold into AEM

The AEM engine treats adherence to this paradigm as maturity signal:

- The **Attention card** (`aios analyze`) is the measurement surface for §2's premise — leverage
  per unit of attention (focus blocks, prompt-level context switches, session hops, concurrency).
- The **agentic-maturity skill** and future axis work (EE8 / AIO-174, the researched 6th lens)
  reference this document as the behavioral standard being scored.
- Placement guidance that prescribes "practice next" patterns should link the relevant section
  here rather than restating it.
