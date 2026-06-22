# Team Brain Access Strategy — surfaces, not silos

> ⚠️ **INTERNAL (reviewer-only).** Studio strategy. Not part of the public release; remove
> before this repo is made public (see `../../RELEASE-CHECKLIST.md` and `./README.md`).
> Status: proposed direction, 2026-06-22. Owner: John. Drives the PRD at
> `../prd-team-brain-mcp-connector.md`.

## The question this answers

> *Can we get people who live in Claude (Desktop / Cowork / web) — or Codex, or Conductor —
> onto the Team Brain without forcing them through a full `aios-workspace` install first?*

Yes. And answering it properly forces a sharper articulation of what AIOS actually is, so
this doc does both: it sets the access doctrine, and it separates the two things we've been
quietly conflating.

## The conflation we're untangling

AIOS today bundles two products that have different audiences, different value, and very
different adoption costs:

| | **Layer 1 — the Harness** | **Layer 2 — the Brain Connection** |
|---|---|---|
| What | Skills, hooks, guards, the numbered spine, `CLAUDE.md`, validators, multi-agent workflows | `push` / `pull` / `query` / tasks / decisions against the one shared hub |
| Lives | On the individual's machine | Cloud (`aios-team-brain`) + a thin client |
| Job | Make *one person's* agent work governed, repeatable, high-altitude | Make *the team's* memory queryable and shared |
| Adoption cost | **High** — clone, scaffold, learn the spine, wire integrations | **Low** — a key, a team id, a URL |
| Contract | `scaffold/` + `hooks/` + `validation/` | `docs/brain-api.md` (v1) |

The strategic mistake is treating Layer 2 as something you only get *after* you've paid for
Layer 1. The brain is valuable on its own. A salesperson who never touches the spine should
still be able to ask "what did we decide about the Northwind pricing model?" from inside the
Claude app they already have open.

**Decision: decouple the two. Ship Layer 2 access independently of Layer 1 adoption.** Layer 1
remains the deep product; Layer 2 becomes the wide on-ramp. People enter through the brain and
graduate into the harness — not the reverse.

## The access doctrine: *who is the caller?*

There is no "MCP vs CLI" debate once you ask the right question. The axis is **does the calling
agent have a shell?**

```
                          ┌─────────────────────────────────────────┐
   Shell-capable agent    │  Claude Code · Codex CLI · OpenCode ·    │
   (can spawn processes)  │  Conductor-in-a-terminal · cron · CI     │
                          └───────────────────┬─────────────────────┘
                                              │  calls the binary directly
                                              ▼
                                   ┌────────────────────┐
                                   │   aios CLI         │  ← PRIMARY surface
                                   │  push/pull/query…  │     fast, cheap, no schema tax
                                   └─────────┬──────────┘
                                             │ docs/brain-api.md (v1)
   GUI-only agent         ┌──────────────────┴──────────────────┐
   (no shell)             │   aios mcp  (stdio MCP server)       │  ← BRIDGE surface
                          │  brain_query, brain_list_tasks, …    │     same contract, schema-described
                          └──────────────────┬──────────────────┘
                                             ▲  spawned by the client
        ┌────────────────────────────────────┴───────────────────┐
        │  Claude Desktop · Claude Cowork · Claude.ai · any host  │
        │  that speaks MCP but can't run a binary for the agent   │
        └─────────────────────────────────────────────────────────┘
```

### Why CLI is primary

For any agent that can shell out, a well-shaped CLI beats MCP on every axis that matters at
scale:

- **Token cost.** MCP tool schemas sit in the context window every turn. `aios --help` is read
  once, on demand. The industry read here is correct: as agents do more per session, the
  fixed-per-turn cost of resident tool schemas dominates.
- **Latency & simplicity.** A subprocess that prints to stdout is fewer moving parts than a
  long-lived JSON-RPC peer with a handshake and capability negotiation.
- **It already exists and is the source of truth.** `scripts/aios.mjs` implements the full v1
  contract, the tier default-deny, the secrets gate. We are not rebuilding any of that.

So the CLI is not just *a* surface — it's the canonical one. Everything else wraps it or wraps
the same contract.

### Why MCP is the bridge, not the mainline

MCP earns its place in exactly one situation: **the agent has no shell.** That's not a niche —
it's the entire Claude Desktop / Cowork / web population, which is the population this strategy
is trying to reach. For them MCP is the *only* bridge, so we build it. But we build it:

- **Thin.** A wrapper over `docs/brain-api.md` v1. No business logic that isn't already in the
  contract. (Implemented: `scripts/brain-mcp.mjs`, 7 read tools incl. a `brain_status` connection
  probe, zero deps.)
- **Read-first.** A contextless GUI has no spine and no per-file tiers, so *pushing* from it is
  semantically muddy. v1 is read-only: query, list tasks/decisions/projects, pull items. Writes
  are a deliberate later question (see PRD), not a default.
- **Not allowed to drive architecture.** We never add a brain capability "for MCP." The contract
  changes for product reasons; MCP and CLI both follow it.

### The one real advantage MCP has

Discovery. A fresh agent that has never seen `aios` must read `--help` and infer. An MCP server
self-describes via `tools/list`. This is genuinely nice but **narrow** — anyone adopting AIOS
reads docs anyway — so it doesn't change the primacy call. It's a reason MCP is pleasant for
the GUI population, not a reason to prefer it for the shell population.

## Tool portability (the Codex / Conductor question)

Because the bridge is a standard stdio MCP server, it is portable for free to any host that can
spawn a **local** MCP process:

- **Claude Desktop / Cowork** — the primary target; one-click via a `.mcpb` extension (PRD).
- **Codex** — OpenAI's tooling speaks MCP; same server, different config file.
- **Conductor** and other agent wrappers — if they host MCP, they get the brain with no work
  from us.

> **Footnote — "portable" means local-stdio portable.** All three above spawn a local process, so
> one zero-dep server reaches them with no per-host code. What this does *not* yet reach is a
> surface that can only host *remote* MCP (e.g. fully-web claude.ai with no local process) — that's
> a remote endpoint, deliberately out of v1. And note Codex is already shell-capable, so a Codex
> user could equally call the `aios` CLI directly; the MCP path is the convenience, not the only
> door. The honest claim is "free portability across local-MCP hosts," not "every AI surface."

The same portability is *already true at the harness layer* via a different mechanism: the GUI's
`runtime-adapters/` and `aios skills export --runtime <name>` (BYOA) already drive Claude Code,
Codex, and OpenCode. **Keep these two portability stories distinct in our heads:**

- **MCP server** = which *AI surfaces* can reach the **Brain (Layer 2)**.
- **Runtime adapters / BYOA** = which *agent runtimes* can run the **Harness (Layer 1)**.

They rhyme but they are not the same lever. Conflating them leads to building Brain features in
the adapter layer or vice versa.

## The GUI's real job (and what it is *not*)

Che-Tun's instinct — wrap the toolkit so people get skills/hooks/guards/integrations without
fighting the terminal — is right. But the current GUI is a chat client that drives an agent, and
**chat is the one thing Claude Desktop already does better than we ever will.** Competing there
is a losing game.

The harness has a real, unmet visibility problem instead. In a terminal you cannot *see*:

- which hooks are armed and what each one guards,
- which skills are installed vs. available in the marketplace,
- the spine and the tier on each folder,
- validation state (did my last edit break frontmatter / leak a secret?),
- brain sync state (what's pending push, how stale is my last pull).

So the minimal GUI is **a window into harness state, not another chat box.** Read-only,
auto-refreshing, with one-click actions for the five things people actually do (push, pull,
validate, install a skill, wire an integration) — and every action prints the underlying
terminal command, so the GUI *teaches the CLI it sits on top of* rather than hiding it. Training
wheels you take off, not a parallel interface you get stuck in. (Full spec: PRD §"GUI
repositioning".)

## Adoption flywheel this unlocks

```
   Claude user, no AIOS          install AIOS-Brain          ask one question that
   (Desktop / Cowork)     ──►    MCP extension (2 min)  ──►  saves them an hour
        │                                                          │
        │  "where does this memory come from? can I add to it?"    │
        ▼                                                          ▼
   scaffold a workspace   ◄──   GUI shows them the spine,   ◄──  they want to PUSH,
   (Layer 1, the harness)       hooks, sync — the depth          not just read
```

The brain is the hook; the harness is the depth. Today we ask for the depth first. This inverts
it: **lead with the lowest-cost, highest-immediacy value (query the team's memory from the app
you already have), then pull people down into the governed workspace when they hit the ceiling
of read-only access.**

**And not everyone has to graduate.** A salesperson who only ever queries the brain from Claude
Desktop and never scaffolds a workspace is a *legitimate permanent end-state*, not a stalled
funnel. Layer-2-only consumers are a feature: they widen the team's read surface at near-zero
onboarding cost, and the harness is there for the people whose work actually needs governance.
The flywheel converts the subset who hit the read-only ceiling — it doesn't require everyone to.

## What we are deciding here (summary)

1. **Decouple Layer 2 (Brain) from Layer 1 (Harness)** as products and as adoption steps.
2. **CLI is the primary, canonical access surface.** It owns the contract; everything wraps it.
3. **MCP is the bridge for shell-less agents** (Desktop/Cowork/Codex/Conductor — any host with
   *local* MCP): thin, read-first, contract-following, never architecture-driving. Shipped as
   `aios mcp` + a `.mcpb` extension. Fully-web claude.ai (no local process) needs a remote MCP
   endpoint and is explicitly later, not v1.
4. **Keep two portability stories separate:** MCP = surfaces→Brain; runtime adapters = runtimes→Harness.
5. **Re-aim the GUI** from "chat client" to "harness-state window + CLI trainer."

## Open questions for the PRD / follow-ups

- **Writes over MCP.** Do we ever let a GUI agent `push`? If so, to which tier, and how does a
  contextless caller assert one safely? Leaning: only into a single `inbox`-equivalent at `team`
  tier, behind an explicit opt-in env, never `external`. Before any sign-off the design must pin
  four beats (kept paired with **PRD §9 open question 1**, do not let them drift):
  - **Payload shape** — plain-markdown note vs structured; the *server* stamps `access: team` so a
    contextless caller never asserts a tier; attribution defaults to `AIOS_MEMBER`.
  - **Idempotency / dedup** — GUI agents retry hard; require a `client_token` (or hash of
    actor+title+body) and upsert on it so a double-send is one note.
  - **Size limits** — a write cap paralleling the 25k read cap; reject oversize rather than post a
    megabyte.
  - **Entity vs kind** — does the note become a governed `item` the harness ingests, or a separate
    lightweight "inbox note" entity? Leaning: a distinct entity, so MCP writes never masquerade as
    promoted, governed workspace content.
- **Auth UX in one-click installs.** The `.mcpb` config flow must capture key + team + URL
  without a terminal. What's the least-friction, least-footgun path? (PRD §Auth.)
- **Hosted/remote MCP.** stdio assumes the server runs on the user's machine. Is there demand
  for a remote MCP endpoint fronting the brain for fully-web users? Out of scope for v1; note it.
- **Key issuance for non-workspace users.** Today keys are minted per member in the brain admin
  UI. A Desktop-only user needs the same key without ever cloning a repo — confirm that path.
