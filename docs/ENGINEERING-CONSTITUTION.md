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
distillation of §1–6 and §8 (≤40 lines); when a principle changes, update the digest in
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
- Every invariant lands with its wired enforcer in the same PR — no aspirational rules.
<!-- agent-digest:end -->

## 8. Invariant registry

Every enforced invariant is listed here with the tool that enforces it and where that
tool actually runs. **An invariant lands with its wired enforcer in the same PR** — a
rule with no enforcer row is aspirational and does not belong in this table. The table
is machine-parsed by `scripts/invariant-registry.mjs` and checked by
`test/invariant-registry.test.mjs`: for every row not marked *pending*, the enforcer
file must exist and be reachable from `test:prepare` or a CI workflow. Rows marked
*pending* name the issue/PR that wires them; remove the pending marker when it merges.

| Invariant | Enforcer | Runs in |
|---|---|---|
| file-size gate — default-deny caps on every source file | `scripts/check-file-size.mjs` | `test:prepare` (`check:size`) + CI `constitution` job |
| boundary gate — module dependency boundaries (`scripts/boundaries.json`) | `scripts/check-boundaries.mjs` | `test:prepare` (`check:boundaries`) + CI `constitution` job; defense in depth via `test/check-boundaries.test.mjs` |
| domain isolation — domains are siblings, no cross-domain value imports | `scripts/check-domain-isolation.mjs` | `test:prepare` (`check:domains`) + CI `constitution` job |
| leak gate — no confidential terms leave the machine | `scripts/leak-gate.sh` (installed as `hooks/git/pre-push-leak-gate`) | pre-push git hook + CI `guard` job |
| coverage floors — changed-line + baseline coverage floors | `scripts/check-coverage.mjs` | CI coverage shards (`test:coverage`) |
| mutation floors — mutation-score floors on changed code | `scripts/run-mutation.mjs` | CI `mutation` job (`test:mutation`) + nightly `mutation.yml` |
| context-health — context-engineering health floors | `scripts/check-context.mjs` (wraps `scripts/context-health.mjs`) | `check:context` in CI `context-health` job |
| toolkit-manifest parity — manifest buckets ↔ scaffold destinations in lockstep | `test/toolkit-manifest-parity.test.mjs` | test suite (`test:node` + CI test shards) |
| contract-schema parity — vendored brain JSON Schema ↔ client validator agree | `test/item-payload-schema-parity.test.mjs` | test suite (`test:node` + CI test shards) |
| aios-linear skill parity — the two canonical skill copies (`scaffold/.claude/skills/aios-linear/` ↔ `.claude/skills/aios-linear/`) both exist and stay byte-identical | `scripts/check-linear-skill-parity.mjs` (thin gate: both-dirs-exist assertion + delegation to OGR17 `validation/check-skill-sync.mjs`) | `test:prepare` (`check:linear-skill-parity`) + CI `constitution` job |
| brain-api revision label — CLAUDE.md pinned-contract label matches `docs/brain-api.md` | `checkVersionLabels()` in `scripts/context-version-labels.mjs`, invoked by `scripts/context-health.mjs` via `scripts/check-context.mjs` | `check:context` in CI `context-health` job |
| codebase-health — repo-level health rubric | `validation/codebase-health.rubric.json` | pending AIO-605 (not yet built) |

---

## Quick reference

| Concern | Source of truth |
|---|---|
| Sync protocol | [`docs/brain-api.md`](./brain-api.md) (v1.24) |
| Design system | `aios-design/DESIGN.md` |
| Engineering / workflow layer | **this file** |
| Conventions & tiers | `scaffold/.claude/rules/` |
| Scaffold harness success criteria | `scaffold/.claude/rubrics/` |
| V1 Operator Loop success criteria | `.claude/rubrics/operator-loop-*.md` |
| V1 product decomposition | [`docs/v1-operator-loop/`](./v1-operator-loop/README.md) |
