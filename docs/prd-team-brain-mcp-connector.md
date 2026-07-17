# PRD — AIOS Team Brain MCP Connector

**Status:** Phase 0 landed (read-only stdio server + `aios mcp`); Phases 1–3 proposed.
**Last updated:** 2026-06-22 · **Owner:** John
**Access doctrine:** the access-surface strategy that drove this work is an internal document (removed at public release).
Public readers: the release-safe summary is [`architecture.md` § Access surfaces](./architecture.md#access-surfaces--how-callers-reach-the-brain).
**Contract:** [`brain-api.md`](./brain-api.md) — the pinned API **major `v1`** (`/api/v1`), currently
at **doc revision 1.1**. Throughout this PRD, "v1" means the API major (the path + request/response
shapes), not the doc revision. The connector is a *consumer* of this contract and must not require
any change to it.

---

## 1. Summary

Let people who live in **Claude Desktop, Claude Cowork, Codex, or Conductor** read their team's
shared memory **without installing the `aios-workspace` toolkit**. We do this by shipping a thin,
zero-dependency **MCP server** that wraps the existing Team Brain v1 API, plus a one-click **`.mcpb`
desktop extension** that configures it. The `aios` CLI remains the primary, canonical surface for
shell-capable agents; the MCP server is the bridge for agents that have no shell.

**Scope honesty on transport.** v1 is **stdio** — the server runs as a local process the MCP host
spawns. That covers any host with local MCP hosting (Desktop, Cowork, Codex, Conductor). It does
**not** cover fully-web **claude.ai** users who cannot spawn a local process; serving them needs a
remote MCP endpoint (N2 / Phase 4), so claude.ai is explicitly **future**, not v1.

This is the **wide on-ramp** to AIOS: lead with low-cost, high-immediacy value (query the team's
memory from the app you already have), then pull users into the full governed workspace when they
hit the ceiling of read-only access.

## 2. Goals / Non-goals

**Goals**
- G1. A Claude Desktop user can, in ≤5 minutes and with no terminal, install an extension, paste
  three values (brain URL, team id, API key), and ask the Team Brain a natural-language question.
  > **G1 is gated on P1** (`.mcpb` bundle + `npx @aios/team-brain-mcp`). P0 — already in tree —
  > validates the **protocol + contract** only; reaching G1's "no terminal" bar still requires `aios`
  > on `PATH` or a hand-configured `node …/brain-mcp.mjs`, which a non-technical Desktop user won't
  > do. Do not read P0 as delivering the G1 persona.
- G2. The same server works in any **local-MCP** host (Codex, Conductor) via a config block — no
  per-host code. (Fully-web claude.ai is Phase 4 / remote MCP, not this goal.)
- G3. Zero new runtime dependencies; the server reuses the v1 contract and adds no brain-side change.
- G4. Read access is **tier-safe by construction** — every tool is a tier-filtered read the brain
  re-checks server-side; the connector can never widen a caller's tier.
- G5. The connector is a discoverable, documented part of the toolkit (`aios mcp`, integrations doc,
  scaffold example), not a side script.

**Non-goals (v1)**
- N1. **Writes.** No `push` from the connector in v1 (see §9, open question). A contextless GUI has
  no spine and no per-file tiers; pushing safely is a separate design.
- N2. **Hosted/remote MCP.** v1 is stdio (server runs on the user's machine). A remote endpoint is
  future work.
- N3. **Replacing the CLI.** The CLI stays primary for shell agents; the MCP server never becomes
  the place new capability lands first.
- N4. **Auth/key issuance changes** on the brain. We use the existing per-member key scheme as-is.

## 3. Users & motivating scenarios

| Persona | Today | With the connector |
|---|---|---|
| **Sales/CS on Claude Desktop**, never cloned a repo | Asks teammates in Slack "what did we decide about X" | `brain_query` answers with citations, in-app (v1, via P1 `.mcpb`) |
| **Exec on Claude Cowork (desktop)** | No access to team memory inside their agent | Pulls decisions/tasks into a briefing (v1, local MCP) |
| **Engineer trialing Codex** | Has the CLI but wants brain context in the IDE agent too | Same server, Codex config (v1) |
| **AIOS workspace owner** | Uses `aios query` in the terminal | Unchanged; CLI stays primary |
| **Anyone on fully-web claude.ai** (no local process) | — | **Future (P4 / remote MCP)** — not v1 |

**Primary scenario (G1):** *"In Claude Desktop, ask: what did we decide about governance review
gates? → grounded answer + `[S#]` sources, no terminal, no workspace."*

## 4. Architecture

```
MCP host (Claude Desktop / Cowork / Codex / Conductor)
   │  spawns:  aios mcp     (or: node …/brain-mcp.mjs)   — stdio, newline-delimited JSON-RPC 2.0
   ▼
brain-mcp.mjs  ──────────────────────────────────────────────┐
   • resolveBrainConfig()  env-first → .env → aios.yaml       │  zero-dep, Node ≥18
   • createBrainClient()   fetchJson + SSE query              │
   • createDispatcher()    initialize / tools/list / tools/call (pure, unit-tested)
   • TOOLS[]               brain_status, brain_query,          │
                           brain_list_projects, brain_list_tasks,
                           brain_list_decisions, brain_pull_items,
                           brain_get_item
   └───────────────────────────────────────────────────────────┘
   │  Authorization: Bearer aios_<key_id>_<secret> · X-AIOS-Team: <team>
   ▼
aios-team-brain  /api/v1/{query,projects,tasks,decisions,items,items/:id}
   • re-applies tier filtering in SQL on every read (the safety boundary)
```

**Reuse, don't fork.** The server mirrors `aios.mjs`'s `api()` HTTP shape, auth headers, and
`.env`/`aios.yaml` resolution. Phase 2 extracts a shared `brain-client.mjs` so both the CLI and the
MCP server import one HTTP/auth/config core (today the MCP server re-implements the minimal slice it
needs, to avoid a risky refactor in the same change).

## 5. Tool surface (v1, read-only)

All tools are service-prefixed (`brain_*`) to avoid collisions with other connected servers, and
carry `readOnlyHint: true`. Payloads are capped at 25 000 chars (paginate/narrow for more).

| Tool | Wraps | Inputs | Returns |
|---|---|---|---|
| `brain_status` | `GET /items?since=<far-future>` (zero-data probe) | — | `{ connected, brain_url, team, member }`; on failure `connected:false` + reason + fix hint. No team data, no key. |
| `brain_query` | `POST /query` (SSE) | `question` (req), `project?` | Grounded answer text + `[S#]` sources |
| `brain_list_projects` | `GET /projects` | — | Team projects (team-tier keys) |
| `brain_list_tasks` | `GET /tasks` | `since?` | Task rows (assignee/status/sprint/due) |
| `brain_list_decisions` | `GET /decisions` | `since?` | Decision rows (tier-scoped) |
| `brain_pull_items` | `GET /items` | `since? project? kinds? path_prefix? cursor?` | Items, keyset-paginated |
| `brain_get_item` | `GET /items/:id` | `id` (req) | One item (404 if above tier) |

`brain_status` is the recommended first call: it tells a bad/missing credential apart from a
legitimately empty result, which is a Desktop user's most common first-run failure.

**Error semantics:** brain/tool failures return MCP **in-band** results with `isError: true` (so the
model can react and retry); only malformed protocol calls return JSON-RPC errors
(`-32601`/`-32602`). A `404` on an optional endpoint surfaces as a clean tool error, never a crash.

**Forward-compat:** the connector must ignore item kinds and fields it doesn't recognize (mirrors the
contract's client rule), so a newer brain never breaks an older connector.

## 6. Configuration & auth

Resolution precedence (env-first is deliberate — a Desktop user has no workspace):

1. **Process env** — `AIOS_BRAIN_URL`, `AIOS_API_KEY` (or `aios.yaml: api_key_env`), `AIOS_TEAM`, `AIOS_MEMBER?`
2. **`./.env`** in the spawn cwd (dotenvx ciphertext skipped)
3. **`aios.yaml`** walking up from cwd (so an existing workspace "just works")

Required: `AIOS_BRAIN_URL`, `AIOS_API_KEY`, `AIOS_TEAM`. Missing → exit 1 with a precise message
naming the absent vars. Keys are the existing per-member brain keys (`aios_<key_id>_<secret>`);
the connector stores nothing and logs no secret. **stdout is protocol-only; all diagnostics → stderr.**

**Desktop config block** (also added to `scaffold/.mcp.example.json`):

```jsonc
{
  "mcpServers": {
    "aios-team-brain": {
      "command": "npx",
      "args": ["-y", "@aios/team-brain-mcp"],   // Phase 1 publishes this; pre-publish: "aios","mcp"
      "env": {
        "AIOS_BRAIN_URL": "${AIOS_BRAIN_URL}",
        "AIOS_API_KEY":   "${AIOS_API_KEY}",
        "AIOS_TEAM":      "${AIOS_TEAM}"
      }
    }
  }
}
```

## 7. Packaging & distribution (`.mcpb`)

- Build an **MCP Bundle** (`.mcpb`, formerly `.dxt`) per Anthropic's Desktop Extensions tooling.
- The bundle's **user-config manifest** prompts for `brain_url`, `team_id`, `api_key` at install
  (mapped to the env block above) so there is **no terminal step**.
- `api_key` declared as a **sensitive** field (stored in the OS keychain by the host, not plaintext).
- Distribution tiers:
  - **Private/team:** Team & Enterprise plan owners upload the `.mcpb` for org-wide install + can
    allow/deny it centrally.
  - **Public:** submit to the Claude extension directory once the hosted-key story is settled.
- Naming: server id `aios-team-brain`, server name `aios-team-brain-mcp-server` (matches mcp-builder
  convention: `{service}-mcp-server`, no version in the name).

## 8. Phasing & deliverables

| Phase | Deliverable | State |
|---|---|---|
| **P0 — Server + CLI seam** | `scripts/brain-mcp.mjs` (7 read tools incl. `brain_status` probe, zero-dep stdio), `scripts/brain-mcp.test.mjs` (16 protocol tests), `aios mcp` command + usage, `npm test` wiring | **Done** in this change |
| **P0.5 — Tier-safety integration test** | One test against a staging brain with an **external-tier** key asserting AC4 (403/422 → `isError`, never widened data). **Blocking gate before any non-engineer pilot** — protocol unit tests don't prove the core safety claim (G4). | Proposed (do before P1 pilot) |
| **P1 — Packaging** | `.mcpb` bundle + user-config manifest; `npx @aios/team-brain-mcp` entry; README + install GIF; submit to private/team distribution. **Unblocks the G1 persona** (no-terminal Desktop install). | Proposed |
| **P2 — Shared client refactor** | Extract `scripts/brain-client.mjs` (HTTP + auth + config) shared by `aios.mjs` and `brain-mcp.mjs`; delete the duplicated slice | Proposed |
| **P3 — Writes (gated)** | `brain_push_note` into a single `team`-tier inbox path, behind `AIOS_MCP_WRITES=1`, never `external`; resolves §9 | Proposed, needs design sign-off |
| **P4 — Remote MCP (optional)** | Hosted endpoint fronting the brain for fully-web users (no local process) | Backlog |

## 9. Open questions

1. **Writes over MCP (blocks P3).** Should a contextless GUI agent ever `push`? Directional proposal:
   a single `brain_push_note` that lands at `team` tier under an `inbox/`-equivalent path, opt-in via
   `AIOS_MCP_WRITES=1`, never `external`/`admin`. Needs John's sign-off because it touches the tier
   safety story. Before sign-off, the design must pin down four beats (mirrored in the strategy doc's
   open questions so both stay paired):
   - **Payload shape.** Plain-markdown note vs structured JSON. Lean: `{ title, body (markdown),
     source: "mcp", actor }` where `actor` defaults to `AIOS_MEMBER`. No frontmatter authored by the
     caller — the server stamps `access: team` so a contextless caller can't assert a tier.
   - **Idempotency / dedup.** GUI agents retry aggressively. Require a caller-supplied
     `client_token` (or hash the `(actor, title, body)`); upsert on it so a double-send is one note,
     not two. Reuses the brain's existing content-hash upsert discipline.
   - **Size limits.** Mirror the 25 000-char read cap with a write cap (reject oversize `422`,
     parallel to the contract's `payload_too_large`), so a runaway agent can't post a megabyte.
   - **Entity vs kind.** Decide whether the note becomes a first-class `item` kind the harness later
     ingests/promotes, or a separate lightweight "inbox note" entity outside the spine. Lean: a
     distinct inbox-note entity, so MCP writes never masquerade as governed, promoted workspace content.
2. **Hosted-key issuance for non-workspace users.** Keys are minted per member in the brain admin
   UI today. Confirm a Desktop-only user can be issued a key without cloning a repo (likely already
   true — verify and document).
3. **Remote vs stdio.** Is there real demand for fully-web (claude.ai) users with no local process?
   If yes, P4; if not, drop it.
4. **Versioning the connector against the contract.** The connector pins to API major `v1` and
   tolerates 404s. When the brain moves to `/api/v2`, what's the connector's compatibility window?
   (Recommend: connector advertises the contract major it targets; refuses with a clear message on
   mismatch. A doc-revision bump within v1 — e.g. 1.1 → 1.2 — never breaks it, by the additive rule.)
5. **Config-probe / `brain_status` tool — RESOLVED, shipped in P0.** A Desktop user's first failure
   mode is a bad URL/key/team, discovered only when the model eventually calls a real tool. The
   `brain_status` tool now probes with a cheap `GET /items?since=<far-future>` (returns `200` + empty
   for any valid key regardless of tier — a universal auth/URL/team check that leaks no data) and
   reports `{ connected, brain_url, team, member }`, or `connected:false` + reason + fix hint on
   failure. Remaining sub-question for P1: surface it in the `.mcpb` install flow as a "Test
   connection" affordance so the user verifies *before* the first real query.

## 10. Acceptance criteria

- **AC1 (protocol).** `initialize` → correct `protocolVersion` + tools capability; `tools/list`
  returns all read tools with JSON-Schema `inputSchema`; notifications get no reply; unknown
  method/tool → correct JSON-RPC error codes. *(Covered by `brain-mcp.test.mjs` — 16 tests passing.)*
- **AC2 (stdout hygiene).** Over a real `aios mcp` process, stdout contains only JSON-RPC frames;
  the startup banner and all diagnostics appear only on stderr. *(Verified via piped handshake.)*
- **AC3 (config).** Missing any of the three required vars exits 1 naming them; env beats `.env`
  beats `aios.yaml`; trailing slash on the URL is trimmed. *(Covered by tests.)*
- **AC4 (tier safety) — P0.5, blocking before any non-engineer pilot.** An `external`-tier key
  calling `brain_list_projects` receives the brain's `403/422` surfaced as an `isError` tool result —
  never a widened view; and an `external`-tier `brain_pull_items` returns only `external`-audience
  items. This is the core safety claim (G4) — the protocol unit tests do **not** prove it. Assert it
  with one integration test against a staging brain using a real external-tier key, **before** P1 ships
  to anyone non-technical (not deferred to P1's end).
- **AC5 (end-to-end, P1).** From a clean Claude Desktop with the `.mcpb` installed and three values
  entered, `brain_query` returns a grounded, cited answer. *(Manual acceptance — the one step not
  coverable by unit tests; gate P1 on it.)*

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| MCP protocol drift (we hand-rolled JSON-RPC, no SDK) | Pin `PROTOCOL_VERSION`; AC1 protocol tests; revisit if Anthropic bumps the stdio framing |
| Context bloat from large pulls (per-call) | 25 000-char cap + keyset pagination + `path_prefix`/`project` narrowing |
| **`tools/list` fixed per-turn tax** — the seven rich tool descriptions are excellent for tool selection but are resident context every turn (the very MCP cost the strategy cites as a CLI advantage) | Track total `tools/list` token footprint; keep descriptions information-dense but trim if Anthropic/host context limits bite; this is also *why* shell agents are pushed to the CLI, where the schema isn't resident |
| Secret leakage via stdout | Hard rule: stdout = protocol only; secrets never logged; `.mcpb` marks key sensitive (keychain) |
| Scope creep into writes | N1 + P3 gating; writes require explicit env + design sign-off |
| Two HTTP clients diverging (CLI vs MCP) | P2 shared-client refactor folds them back together |
| MCP becomes the de-facto mainline | Doctrine in the strategy doc: CLI is canonical; no brain feature lands in MCP first |

## 12. GUI repositioning (companion track, not blocking)

Decoupling Brain access from the harness re-frames the GUI. The current GUI is a chat client that
drives an agent; **chat is what Claude Desktop already does best.** The unmet need is *harness
visibility*. Re-aim the minimal GUI to a **read-only, auto-refreshing window into harness state**:

- spine + per-folder tier; hooks armed and what each guards; skills installed vs. marketplace;
  validation state; brain sync state (pending push / last pull).
- One-click actions for the five real verbs (push, pull, validate, install-skill, connect) — each
  **printing the underlying `aios …` command** so the GUI *teaches the CLI it sits on*.
- No chat surface in the minimal build. Training wheels you remove, not a parallel UI to live in.

This is a separate plan doc + workstream (tracked in `roadmap.md`); the MCP connector does not
depend on it and vice versa.

## 13. References

- Contract: [`brain-api.md`](./brain-api.md) (v1)
- Implementation: `scripts/brain-mcp.mjs`, `scripts/brain-mcp.test.mjs`, `aios mcp` in `scripts/aios.mjs`
- MCP authoring reference (vendored): `gui/server/skill-library/mcp-builder/`
- Integrations how-to: [`integrations.md`](./integrations.md)
