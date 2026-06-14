# Integrations

Your AIOS workspace can connect to the tools you already use. Integrations come in
two shapes:

- **MCP servers** — declared in `.mcp.json` at the workspace root. Claude Code (and
  the local GUI, which loads the same project settings) starts them and exposes their
  tools to the agent.
- **CLI tools** — installed on your machine and on `PATH`; the agent calls them via
  Bash (e.g. `gog-cli` for Gmail/Google).

The catalog of what's connectable lives in
[`.claude/INTEGRATIONS.md`](../.claude/INTEGRATIONS.md) (generated from
`.claude/integrations.json`). This page is the **how-to-connect** companion.

## How to wire an MCP integration

1. Open [`.mcp.example.json`](../.mcp.example.json) and copy the server block you want
   into [`.mcp.json`](../.mcp.json) under `mcpServers`.
2. Provide the env values. **Do not inline real tokens** — `.mcp.json` is committed.
   Reference shell/managed env with `${VAR}` (as in the example), and put the actual
   secrets in your shell profile or a secrets manager. `.env` / `.env.local` are
   gitignored if you prefer a local file + a launcher that exports them.
3. Restart Claude Code / the GUI so the server is picked up.
4. Flip the tool's `status` from `available` to `wired` in
   `.claude/integrations.json`, then run `npm run gen:catalog` to refresh the catalog.

## Per-tool notes

### Slack (MCP)
Create a Slack app, add bot scopes (`channels:history`, `channels:read`,
`chat:write`), install to your workspace, and copy the bot token into
`SLACK_BOT_TOKEN`; set `SLACK_TEAM_ID` to your workspace id.

### Jira + Confluence (MCP — one server)
The `atlassian` server covers both. Create an API token at
id.atlassian.com → Security → API tokens. Set `ATLASSIAN_URL`
(e.g. `https://your-org.atlassian.net`), `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`.

### Linear (MCP)
Add the `linear` server; on first use it runs an OAuth flow in your browser. No
static token needed.

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
Export meeting notes/transcripts into `1-inbox/transcripts/`, then run the
`transcript-decisions` harness to turn them into decision-log rows. If you have the
Granola API, set `GRANOLA_API_KEY` and script the export.

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
