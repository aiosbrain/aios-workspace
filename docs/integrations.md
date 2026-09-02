# Integrations

Your AIOS workspace can connect to the tools you already use. Integrations come in
two shapes:

- **MCP servers** — declared in `.mcp.json` at the workspace root. Claude Code (and
  the local GUI, which loads the same project settings) starts them and exposes their
  tools to the agent.
- **CLI tools** — installed on your machine and on `PATH`; the agent calls them via
  Bash (e.g. `gog-cli` for Gmail/Google).

The catalog of what's connectable lives in
[`.claude/INTEGRATIONS.md`](../scaffold/.claude/INTEGRATIONS.md) (generated from
`.claude/integrations.json`). This page is the **how-to-connect** companion.

## Global command installation

Install the toolkit once so every repository can use the same command surface and credential
resolver:

```bash
npm install --global @aiosbrain/aios
aios --help
aios slack --help
aios linear template aios
```

`aios` remains repo-scoped for sync commands (`status`, `push`, and `pull`); use `--repo` when
working outside a stamped workspace. Account-scoped commands such as `aios query` and
`aios connect` may use the explicit `AIOS_AGENT_WORKSPACE` environment variable. The built-in
`aios slack` and `aios linear` adapters resolve credentials from the current environment, the
current repository, or the toolkit's encrypted `.env`; Slack then fetches the member's personal
token from the Team Brain when no local token is present. (The bare `slack`/`linear` bins are
deprecated compat delegates to the same adapters, removed no earlier than v3.0.0.)

## How to wire an MCP integration

1. Open [`.mcp.example.json`](../scaffold/.mcp.example.json) and copy the server block you want
   into [`.mcp.json`](../scaffold/.mcp.json) under `mcpServers`.
2. Provide the env values. **Do not inline real tokens** — `.mcp.json` is committed.
   Reference shell/managed env with `${VAR}` (as in the example), and put the actual
   secrets in your shell profile or a secrets manager. `.env` / `.env.local` are
   gitignored if you prefer a local file + a launcher that exports them.
3. Restart Claude Code / the GUI so the server is picked up.
4. Flip the tool's `status` from `available` to `wired` in
   `.claude/integrations.json`, then run `npm run gen:catalog` to refresh the catalog.

## Per-tool notes

### AIOS Team Brain (first-party MCP — for GUI agents)

Most integrations here pull *other* tools **into** your workspace agent. This one points
the other way: it exposes **your Team Brain** to an AI surface that can't run the `aios`
CLI — Claude Desktop, Claude Cowork, claude.ai. Shell-capable agents (Claude Code in the
terminal, and also **Codex and Conductor** — see [Conductor](#conductor) below) should keep
using `aios query` / `aios pull` directly; the MCP bridge exists for agents with no shell. See the
[access-surface architecture](architecture.md#access-surfaces--how-callers-reach-the-brain)
and the [MCP connector PRD](prd-team-brain-mcp-connector.md).

The server is `scripts/brain-mcp.mjs` (zero-dep, read-only), launched by `aios mcp`. Add
this block to the MCP host's config (`.mcp.json` for a workspace, or the host's own config
for Claude Desktop / Codex). It needs **no workspace** — config is env-first:

```jsonc
{
  "mcpServers": {
    "aios-team-brain": {
      "command": "aios",
      "args": ["mcp"],
      "env": {
        "AIOS_BRAIN_URL": "${AIOS_BRAIN_URL}",
        "AIOS_API_KEY":   "${AIOS_API_KEY}",
        "AIOS_TEAM":      "${AIOS_TEAM}"
      }
    }
  }
}
```

It exposes read tools only — `brain_status` (connection probe; call it first),
`brain_query`, `brain_list_projects`, `brain_list_tasks`, `brain_list_decisions`,
`brain_pull_items`, `brain_get_item` — each tier-filtered server-side. For non-technical
users, the PRD's `.mcpb` one-click desktop extension wraps the same server with an
install-time form (no terminal). Writes (`push`) are deliberately out of v1.

### Conductor

[Conductor](https://conductor.build) runs Claude Code agents in parallel **git worktrees**
it creates itself. **Nothing to configure** — if your toolkit is current
(`aios update`), open your workspace repo in Conductor and every workspace it creates
gets the full AIOS harness.

Why an adapter is needed: `aios worktree add` is what normally hydrates a worktree
(`node_modules` symlink, `.mcp.json`, `.claude/` config, `aios asks wire`), and
Conductor never calls it. Three independent layers close that, earliest first:

| Layer | Fires | Ships as |
|-------|-------|----------|
| `.conductor/settings.toml` → `[scripts] setup` | at workspace creation, before the agent's first turn | tracked repo content |
| `.git/hooks/post-checkout` | on `git worktree add` | per-machine, installed silently by `aios update` / `aios onboard` |
| `SessionStart` → `hooks/worktree-self-heal.mjs` | at the start of every Claude Code session | tracked repo content (the guarantee) |

All three run the same `scripts/link-worktree-env.sh`, and all three are no-ops once
`.aios/.worktree-hydrated` exists — so they can't fight each other. The third layer is
why a Conductor workspace created *before* you updated also self-heals: it hydrates on
its next turn, with no manual step and no re-creating the workspace.

Verify from Conductor's integrated terminal (or the agent's Bash tool):

```bash
aios worktree doctor    # → "Conductor support: ready"
aios status             # the CLI works with no setup
```

Conductor reads project-root `.mcp.json` for MCP servers and `CLAUDE.md`/`AGENTS.md`
for instructions, exactly as terminal Claude Code does — hydration puts both in place.
Because Conductor has a real shell, it does **not** need the `aios mcp` bridge above;
that stays available as an optional path for reaching the brain with no workspace open.

### Codex

Same shape as Conductor: a real local shell/git session, so it uses the `aios` CLI
directly and benefits from the same `SessionStart` self-heal when it runs inside a
worktree. Its worktree-creation behaviour has not been verified as closely as
Conductor's — if you hit a worktree that didn't hydrate, `aios worktree init` fixes it
in place and is worth reporting.

### Slack (MCP)
Create a Slack app, add bot scopes (`channels:history`, `channels:read`,
`chat:write`), install to your workspace, and copy the bot token into
`SLACK_BOT_TOKEN`; set `SLACK_TEAM_ID` to your workspace id.

This is the **bot** path: messages post as an app, not as you. For acting as
yourself, use `slack-personal` below. The two use different credentials and are not
interchangeable — never put a bot token (`xoxb-`) into the personal connector.

### Slack (personal) — acting as you, with a user token

`slack-personal` talks straight to the Slack Web API with a **user token**
(`xoxp-…`), so messages post as you and replies land in your own DMs. Preferred
route is `aios connect slack-personal`, which runs the browser OAuth flow and stores
the token in the Team Brain — never on your machine. Everything below is for
people standing up their **own** Slack app, either because they run their own brain
or because they are adding a capability the shared app does not yet request.

#### Creating the app

1. api.slack.com/apps → **Create New App** → *From scratch*, pick your workspace.
2. **OAuth & Permissions** → **User Token Scopes** (the section headed *"Scopes that
   access user data and act on behalf of users that authorize them"*). Do **not** add
   these under Bot Token Scopes — a bot token cannot act as you, and the connector
   rejects one.
3. Add the scopes in the table below, then **Install to Workspace** and authorize.
4. Copy the **User OAuth Token** (`xoxp-…`). Either paste it when `aios connect
   slack-personal` offers the manual fallback, or export `SLACK_USER_TOKEN`.

#### Scopes

Every scope here is one the shipped tooling actually calls. The right-hand column
names the API method that needs it, so the list stays auditable instead of being
copied around and slowly growing.

| Scope | Needed for | Slack method |
|---|---|---|
| `chat:write` | `aios slack send`, `aios slack dm` | `chat.postMessage` |
| `im:write` | opening a DM before the first message | `conversations.open` |
| `im:read`, `channels:read`, `groups:read`, `mpim:read` | `aios slack channels` | `conversations.list` |
| `im:history`, `channels:history`, `groups:history`, `mpim:history` | `aios slack read`, the daily unread scan (`aios slack activity pull`) | `conversations.history`, `conversations.replies` |
| `users:read` | resolving a teammate's name or id | `users.list`, `users.info` |
| `users:read.email` | `aios slack resolve <email>` | `users.lookupByEmail` |
| `reactions:write` | `aios slack react` | `reactions.add` |
| `files:write` | uploading a file or deck to a DM or channel | `files.getUploadURLExternal`, `files.completeUploadExternal` |

The four `*:read` and four `*:history` scopes come in matched sets on purpose: read
lists the conversation, history reads inside it. Drop `groups:*` and you silently
lose private channels; drop `mpim:*` and you lose group DMs. The failure mode is a
conversation that simply never appears, not an error.

If `files:write` is added after the app was installed, you must **reinstall the
app** and reconnect — adding a scope does not retroactively widen an issued token.

#### Scopes you do not need

Slack's scope picker makes it tempting to tick everything. These get requested often
and buy nothing for this tooling: `emoji:read`, `pins:read`, `pins:write`,
`search:read`, `team:read`, `usergroups:read`, `reactions:read` (writing a reaction
does not require reading them), and `files:read` (only needed if you later read
files *out* of Slack rather than uploading).

Skip `stars:read` and `stars:write` outright. Slack has effectively retired that
feature: *"Stars can still be listed via `stars.list` but they can no longer be
viewed or interacted with by end-users. We recommend retiring any app functionality
that relies on `stars` APIs."* ([stars.list](https://docs.slack.dev/reference/methods/stars.list))

Every extra scope is consent surface a teammate has to grant and an auditor has to
justify. Add one when a method needs it, not in advance.

#### Verifying

```bash
aios slack whoami       # expect your own user id + workspace, not a bot
aios slack channels     # public + private + DMs; if private channels are missing, groups:* is absent
```

If Slack reports `missing_scope`, compare the app's User Token Scopes with the
table above, add the missing scope, reinstall the app, and reconnect. If you are
on the shared one-click flow, the scope set lives in
`scaffold/.claude/descriptors/slack-personal.json` **and** in the brain's Slack
app config; both must list a scope before the OAuth flow will request it.

### Jira + Confluence (example-only MCP — manual setup)
**Not an auto-wired connector.** Jira was removed from the `aios connect` set in the
V1.0 supply-chain hardening: the `atlassian` server it relied on runs the **unofficial,
single-maintainer** `mcp-atlassian` npm package, and `npx -y` would re-pull latest on
every start. It now ships **example-only** in `.mcp.example.json`, with the version
**pinned** (`mcp-atlassian@2.1.0`) and a provenance warning. Review the package before
using it. The maintained alternative is `sooperset/mcp-atlassian` via `uvx` (different
transport — swap deliberately). To wire it manually, copy the `atlassian` block from
`.mcp.example.json` into `.mcp.json`. Create an API token at id.atlassian.com → Security
→ API tokens. Set `ATLASSIAN_URL` (e.g. `https://your-org.atlassian.net`),
`ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`. One server covers both Jira and Confluence.

### Linear (built-in `aios linear` adapter + Team Brain PM sync)
The shipped workspace connector uses a personal Linear API key (`LINEAR_API_KEY`)
and the built-in `aios linear` adapter (raw GraphQL via `aios linear query`; the
installed `linear-direct` skill is routing documentation), because Linear's
official MCP is OAuth-oriented.
Team Brain can also store a Linear integration with non-secret mapping hints
(`teamId`, `projectId`, `doneStateName`) and an encrypted token so merged AIOS
work can move linked Linear issues to a completed workflow state.

### Plane (REST/API key + Team Brain PM sync)
Use Plane personal access tokens through `PLANE_API_KEY`. Team Brain stores the
workspace/project mapping (`workspaceSlug`, `projectId`, `doneStateName`,
`externalSource`) and an encrypted token. Merged AIOS work uses task row keys
and Plane `external_id` / `external_source` to move linked work items to DONE.

### Notion (MCP)
Create an internal integration at notion.so/my-integrations, copy its token into
`NOTION_TOKEN`, and **share the pages/databases** you want reachable with that
integration (Notion is deny-by-default per page).

### GitHub (MCP or CLI)
Either add the `github` MCP server with a fine-grained PAT (`GITHUB_TOKEN`), or just
rely on the `gh` CLI if it's already authenticated (`gh auth status`).

### Gmail / Google Workspace (CLI — gog-cli)
Install `gog-cli`, run `gog auth login` once for OAuth. The agent reads/sends mail,
calendar, and drive by shelling out to `gog`. No MCP server.

### Granola (CLI / export)

Export meeting notes/transcripts into `1-inbox/transcripts/`. New workspaces include
that path in the team sync configuration; for an existing workspace, enable it once:

```bash
aios transcripts enable-sync
```

Transcript processing is an explicit, portable CLI flow—not a Workflow template:

```bash
aios transcripts draft --transcripts 1-inbox/transcripts/meeting.md
aios transcripts list
aios transcripts approve .aios/staging/transcript-decisions/<stage>.json
```

The typed engine extracts decisions and explicit task commitments, grades the full batch,
and keeps the V2 stage owner-private until one human approval applies both local logs.
Approval attempts the existing `aios push` path after local apply; use `--no-push` for an
explicit skip, or rerun `approve` to retry a failed push without reapplying. Scheduled,
connector-triggered, and daily-triggered drafting is deferred. If you have the Granola
API, set `GRANOLA_API_KEY` and script only the export.

### Mattermost (MCP)
Self-hosted Slack alternative. Set `MATTERMOST_URL` and a personal access token
(`MATTERMOST_TOKEN`).

### Toggl (MCP)
Set `TOGGL_API_KEY` (Toggl → Profile → API token). Use it to reconcile timers
against `3-log/hours-log.md`.

## Security

- `.mcp.json` is committed — keep secrets out of it; use `${ENV}` indirection.
- Treat every integration as an egress path. Only wire what the work needs.
- The same access-tier discipline applies: content an integration pulls in lands in
  `1-inbox/` (private) until you deliberately promote it.
