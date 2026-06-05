# Agentic Team Ops — Feature Set

A complete tour of what the system does today and where it's going. Agentic Team Ops
is an **agent-native operating system for consulting and transformation teams**: a
shared structure, a set of governance conventions, validators that keep repos honest,
and a library of multi-agent workflow harnesses that do real operational work with
verifiable output.

It is **fork-per-client**: a practice scaffolds one team-ops repo per engagement and
runs the same conventions, validators, and harnesses across all of them.

---

## 1. The operating model

### Hub and spokes
A practice keeps one private **hub** and many **spokes** — one team-ops repo per
engagement, scaffolded from the same template, shared with the delivery team at the
right access tier. Repository boundaries enforce cross-engagement isolation. (This
open-source project is the *toolkit*; a hub is built from it.)

### The numbered spine
Every engagement uses the same six-folder pipeline — `00-engagement`, `01-intake`,
`02-deliverables`, `03-status`, `04-client-surface`, `05-personal` — encoding maturity
from raw capture to client-facing output. Content is promoted deliberately, with a
review or approval at each step.

### Access tiers
Every file carries an audience tier (`admin | team | client`) in frontmatter. Tiers
are enforced by the guard hook and the validators, and (on the roadmap) by access-aware
retrieval. See `architecture.md`.

---

## 2. Scaffolding

`scripts/scaffold-engagement.sh` spawns a complete team-ops repo from
`scaffold/`: the full numbered spine, per-member personal workspaces, starter status
files (decision log, hours, tasks), CODEOWNERS, and the shipped governance rules and
harness skills. One command, a ready-to-run engagement repo.

The template (`scaffold/.claude/`) ships:
- **Conventions** (`rules/`): decision-log format + type/audience taxonomy, frontmatter
  schema by directory, the promotion/publishing flow, and hours logging.
- **Harnesses** (`skills/`): the dynamic-workflow skills below.

---

## 3. Validators (OGR)

Pure-shell, dependency-free checks you can point at any team-ops repo, also wired into
CI:

| Validator | Checks |
|-----------|--------|
| `check-structure.sh` | The numbered spine, required files, personal-folder shape |
| `check-frontmatter.sh` | YAML frontmatter present + required fields by directory |
| `check-secrets.sh` | API keys, tokens, private keys, `.env` files (**critical** — hard fail) |

`validate-all.sh` runs all three, with `--critical` and `--quick` modes.

---

## 4. Guard hook

`hooks/team-ops-guard.sh` is a Claude Code PreToolUse hook that fires on every
Write/Edit and blocks: (1) secrets, (2) admin-tier content (rates, margins, P&L,
strategy) written into team/client directories, and (3) markdown deliverables missing
frontmatter. Prevention at authoring time, before anything reaches version control.

---

## 5. Dynamic-workflow harnesses — the differentiator

The heart of the system. Instead of asking one agent to do a whole task in one
context, a harness spawns focused sub-agents and adds **adversarial verification** so
its output is trustworthy. Three ship today; more are on the roadmap.

| Harness | What it does | Pattern |
|---------|--------------|---------|
| **decision-audit** | Lints the decision log against governance rules; returns only verified findings | one-verifier-per-rule + adversarial verify |
| **scope-creep** | Flags deliverables that drift from the scope baseline/ledger | per-deliverable classify + severity-downgrade refuter |
| **transcript-decisions** | Turns meeting transcripts into novel, grounded decision rows | fan-out extract + dedup + adversarial grounding |

These came out of a controlled A/B study (single-pass vs harness on identical inputs).
The headline finding: **adversarial verification — not parallelism — is what makes a
harness trustworthy.** A fan-out without an independent grounding step can amplify a
single agent's error and do *worse* than a single pass. The harnesses encode ten
conventions distilled from that study (`workflows.md`, `scaffold/.claude/skills/README.md`).

Every harness is a **template**, tuned per engagement via `args`, read-only (it returns
data; the caller writes), and demonstrated against the synthetic `examples/sample-engagement/`.

---

## 6. Synthetic example engagement

`examples/sample-engagement/` is a fully fictional engagement ("Northwind Robotics")
seeded with deliberate governance issues, scope-creep cases, and transcript decisions —
so every harness can be run, demoed, and regression-tested with zero real data. Sample
outputs from one run live in `examples/sample-output/`.

---

## 7. Safety & open-source hygiene

- `scripts/leak-gate.sh` — a confidentiality gate (built from a client's confidential-
  information definition) that blocks client/firm/person identifiers and business-data
  patterns. CI runs it on every PR, so the repo stays clean as it grows.
- Apache-2.0 licensed; contributions gated on the leak gate + secret scan + validators.

---

## Roadmap (the integrations layer + more harnesses)

The clean core ships today. Deliberately deferred — and ideal contribution targets:

- **Sync pipeline** — fetch → triage → promote across email/chat/time-tracking, as
  pluggable integration adapters (rather than hard-wired to one stack).
- **Access-aware knowledge base** — local RAG over the corpus with retrieval filtered
  by access tier, exposed as an MCP server.
- **Scheduling** — OS-level recurring sync.
- **More harnesses** — a weekly-synthesis harness *with a fidelity verifier* (the study
  showed synthesis without one fabricates), a ticket-hygiene harness, and a
  classifier-router that picks single-pass vs harness by input size.

See the issue tracker for the current list.
