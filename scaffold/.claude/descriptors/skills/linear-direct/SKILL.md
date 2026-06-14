---
name: linear-direct
description: |
  Query and update Linear issues, projects, and cycles via the Linear GraphQL API
  using a personal API key (our own connector — Linear's MCP is OAuth-only). Use when
  the user asks about their Linear issues, sprint/cycle status, or wants to create or
  update an issue. Requires Linear connected (LINEAR_API_KEY).
kind: skill
version: 1.0.0
access: team
triggers:
  - my linear issues
  - linear sprint status
  - create a linear issue
  - what's in my cycle
---

# Linear (direct)

Our own Linear connector — calls the Linear **public GraphQL API**
(`https://api.linear.app/graphql`, `Authorization: <personal-api-key>`). The key is
resolved locally (env → dotenvx → `.env`) and never leaves this machine.

## How to run

```bash
# default: your open assigned issues
node .claude/skills/linear-direct/linear-query.mjs

# any GraphQL query (read or mutation)
node .claude/skills/linear-direct/linear-query.mjs --query '{ teams { nodes { name key } } }'
```

The script prints the GraphQL `data` as JSON. For mutations, pass the mutation in
`--query` (e.g. `issueCreate(...)`). Build queries from the Linear GraphQL schema
(https://linear.app/developers/graphql).

## Connect / troubleshoot

If `LINEAR_API_KEY` is missing, connect Linear first (Integrations hub, or
`aios connect linear`). Create the key in Linear → **Settings → API → Personal API
keys** (copy it — shown once).
