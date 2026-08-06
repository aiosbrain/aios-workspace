---
name: aios-linear
description: Route Linear issue, project, state, assignee, comment, and relation work through the portable AIOS CLI. Use whenever a user asks an agent to read or mutate their connected Linear workspace. Never substitute raw GraphQL, a generic Linear CLI, or a write-capable Linear MCP tool for an AIOS Linear mutation.
version: 2.0.0
access: team
triggers:
  - Linear issue
  - Linear project
  - Linear board
  - create issue
  - update issue
  - comment on issue
---

# Linear through AIOS

Use the globally available `aios linear` command family. It resolves the target AIOS workspace in
this order: explicit `--repo`, stamped current workspace, `AIOS_AGENT_WORKSPACE`, then the user's
XDG default workspace. The Linear credential is loaded from that resolved workspace, not from an
unrelated repository.

Start with:

```bash
aios linear status --json
```

If it is not configured, ask the user to run `aios linear setup`. Never request that a secret be
pasted into chat or place it in command arguments.

Common operations:

```bash
aios linear list --team ENG --state Backlog --json
aios linear get ENG-123 --json
aios linear create --team ENG --title "Outcome-oriented title" --description-file /tmp/body.md --json
aios linear comment ENG-123 --body-file /tmp/comment.md --json
aios linear set-state ENG-123 "In Progress" --json
aios linear assign ENG-123 person@example.com --json
aios linear update ENG-123 --priority 2 --project "Launch" --label cli --json
aios linear relation add ENG-123 ENG-120 --type blocks --json
aios linear relation list ENG-123 --json
```

For Markdown bodies, use a file or stdin instead of shell-escaped multiline strings. Capture the
identifier returned by `create`; never infer the next issue number. Read the exact issue after every
mutation and verify its requested fields. The CLI performs its own readback, but the agent remains
responsible for comparing the returned object to the user's request.

AIOS maintainer policy for the private AIO board is a separate overlay and is not part of this
public skill. A project-specific maintainer skill may add team/state/relation rules, but it must still
invoke `aios linear` rather than a copied script or direct API mutation.
