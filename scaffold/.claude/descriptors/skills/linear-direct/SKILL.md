---
name: linear-direct
description: |
  Query and update Linear issues, projects, and cycles via the Linear GraphQL API
  using a personal API key (our own connector — Linear's MCP is OAuth-only). Use when
  the user asks about their Linear issues, sprint/cycle status, or wants to create or
  update an issue. Requires Linear connected (`aios connect linear`).
kind: skill
version: 2.0.0
access: team
triggers:
  - my linear issues
  - linear sprint status
  - create a linear issue
  - what's in my cycle
---

# Linear (direct)

This skill is **routing documentation only** (AIO-1072): the Linear implementation is the
aios CLI's built-in adapter (`aios linear <verb>`), which calls the Linear **public
GraphQL API** (`https://api.linear.app/graphql`). The credential is resolved by the
adapter (environment → workspace vault, scoped dotenvx decryption of `LINEAR_API_KEY`
only → the reference stored by `aios connect linear`) and never leaves this machine.
There is no executable client in this directory.

## How to run

```bash
# default: your open assigned issues (paginated), printed as JSON
aios linear query

# any GraphQL query (read or mutation)
aios linear query '{ teams { nodes { name key } } }'
aios linear query 'query($id:String!){ issue(id:$id){ title } }' --vars '{"id":"AIO-73"}'
```

The command prints the GraphQL `data` as JSON. For mutations, pass the mutation as the
query (e.g. `issueCreate(...)`). Build queries from the Linear GraphQL schema
(https://linear.app/developers/graphql). For everyday issue operations prefer the typed
verbs (`aios linear get|list|create|set-state|comment …` — see the `aios-linear` skill).

A recording owner `aios loop daily` invokes the same connector through the built-in
activity verb before collection. It writes open issues assigned to the authenticated
viewer into `1-inbox/comms/activity.jsonl` as owner-private visibility signals:

```bash
aios linear activity pull --repo "$PWD"
```

These records surface work in the daily brief; they do not replace Linear as task authority or
claim GUI writeback. The connector paginates assigned work and projects current state with stable
issue identities and tombstones, so completed or unassigned work does not remain in the brief.

## Connect / troubleshoot

If no credential resolves, connect Linear first: `aios connect linear` (guided flow in a
workspace; `--reference env:LINEAR_API_KEY` / `--token <key>` elsewhere). Create the key
in Linear → **Settings → API → Personal API keys** (copy it — shown once).
