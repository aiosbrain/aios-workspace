# AIOS Engineering Constitution

> The pinned engineering contract for the AIOS **workflow layer** — the domain
> features that feed the [Verified Operator Loop](./v1-operator-loop/README.md).
> This is to engineering what [`brain-api.md`](./brain-api.md) is to sync and
> `aios-design/DESIGN.md` is to UI: change the principle here **first**, then build.
>
> Adopted from [GitHub Spec Kit](https://github.com/github/spec-kit)'s
> Spec-Driven Development, mapped onto AIOS's existing rules + rubrics layer.

---

## 1. Spec before code

Every workflow-layer change follows **spec → plan → tasks → implement**:

1. **Spec** — a short document under `docs/v1-operator-loop/domains/<domain>.md` (or a
   feature spec beside it) stating *what* and *why* and the **acceptance criteria**.
   No greenfield code starts without one.
2. **Plan** — the implementation approach (modules touched, interfaces, trade-offs).
3. **Tasks** — broken into Linear issues under the relevant milestone, each linking
   back to its spec.
4. **Implement** — built against the spec; the spec's acceptance criteria are the
   definition of done.

The spec is the durable artifact. Code that drifts from its spec is a bug in one of them.

Spec readiness is machine-checked: `aios spec eval|fix` grades a spec against `.claude/rubrics/spec-readiness.md` before a builder picks it up — see [`docs/agentic-ergonomics/spec-readiness.md`](./agentic-ergonomics/spec-readiness.md).

## 2. The constitution = rules + rubrics

AIOS already has the constitution layer; this document formalizes it:

- **`scaffold/.claude/rules/`** — conventions, decision-log format, tier model, frontmatter.
- **`scaffold/.claude/rubrics/`** — machine-checkable success criteria for scaffolded
  workspace harnesses.
- **`.claude/rubrics/operator-loop-*.md`** — product-repo rubrics for the typed V1 Operator
  Loop components. These are not stamped into every workspace; they grade the toolkit's own
  workflow-layer implementation.

Treat these as the source of truth. A new workflow feature either reuses an existing
rule/rubric or adds one — it never invents ad-hoc success criteria inline.

## 3. All TypeScript in the workflow layer

The workflow layer (the 5 domains + the Operator Loop) is **TypeScript only**.

- The zero-dep Node ESM style of `scripts/aios.mjs` is the baseline; new modules are
  typed (`.ts`) with explicit interfaces at their boundaries.
- The Team Brain's Python ingestion sidecar (`ingestion/aios_ingest/`) stays Python by
  design (LlamaHub leverage) — it is **not** part of the workflow layer and is exempt.
- Do **not** port prior-build (legacy team-ops) code verbatim. Reference its patterns;
  rebuild clean and typed.

## 4. Well-bounded modules + the signal contract

One module per domain. Domains are **siblings, not friends**:

- A domain module exposes a narrow public interface and **emits typed, tier-tagged
  signals** into the C1 collector manifest. It does not reach into another domain.
- The **Operator Loop is the only composition point** across domains. If two domains
  need to interact, they do it through the loop's manifest, not direct calls.
- **Signal shape** (the contract every domain implements): a typed record carrying at
  minimum `{ kind, source, tier, occurredAt, ref (evidence path/id), payload }`. Tier
  is mandatory; the loop's C2 evidence ledger relies on `ref`, and C3 enforces tier.

## 5. Tier-safety is non-negotiable

The access-tier model (`admin` never syncs · `team` syncs to brain · `external` syncs
outward) is the safety boundary, enforced at every layer:

- Default-deny on missing `access:`. No signal without a resolvable tier enters a
  shareable digest or a brain push.
- The verifier (C3) and the existing leak-gate / `team-ops-guard` hook are the gates;
  never weaken them to make something ship.

## 6. Verification is the value

Trust comes from rubric-gated, adversarially-verified output — not from speed or
parallelism. Every shareable claim is backed by an evidence reference and passes the
verifier before a human is asked to approve. Keep each harness's rubric honest: the
rubric is what makes the output trustworthy.

## 7. Agent digest

The block below is machine-read by `scripts/constitution.mjs` and injected into every
`aios ship`/`aios build` plan, build, review, and simplify prompt. Keep it a faithful
distillation of §1–6 (≤40 lines); when a principle above changes, update the digest in
the same commit.

<!-- agent-digest:start -->
- Spec before code: workflow-layer changes follow spec → plan → tasks → implement; the
  spec's acceptance criteria are the definition of done.
- Success criteria live in rules + rubrics (`scaffold/.claude/rules|rubrics`,
  `.claude/rubrics/operator-loop-*.md`). Reuse or extend one — never invent ad-hoc
  success criteria inline.
- The workflow layer (5 domains + Operator Loop) is TypeScript with explicit interfaces
  at module boundaries; CLI tooling stays zero-dep Node ESM in the style of
  `scripts/aios.mjs`. Never port legacy team-ops code verbatim.
- Domains are siblings, not friends: one module per domain, narrow public interface,
  typed tier-tagged signals `{ kind, source, tier, occurredAt, ref, payload }` into the
  C1 manifest. The Operator Loop is the ONLY cross-domain composition point — no direct
  cross-domain calls.
- Tier safety is non-negotiable: default-deny on missing `access:`; `admin` never syncs;
  never weaken the leak-gate, `team-ops-guard`, validators, or hooks to make something
  ship.
- Verification is the value: every shareable claim is rubric-gated and evidence-backed
  (`ref`) before a human is asked to approve.
- Simplification bar: prefer deleting code to adding it; no new dependency without a
  stated reason; no abstraction before the second concrete use (YAGNI); cleanup passes
  must be behavior-preserving and stay inside the changed hunks.
<!-- agent-digest:end -->

---

## Quick reference

| Concern | Source of truth |
|---|---|
| Sync protocol | [`docs/brain-api.md`](./brain-api.md) (v1.10) |
| Design system | `aios-design/DESIGN.md` |
| Engineering / workflow layer | **this file** |
| Conventions & tiers | `scaffold/.claude/rules/` |
| Scaffold harness success criteria | `scaffold/.claude/rubrics/` |
| V1 Operator Loop success criteria | `.claude/rubrics/operator-loop-*.md` |
| V1 product decomposition | [`docs/v1-operator-loop/`](./v1-operator-loop/README.md) |
