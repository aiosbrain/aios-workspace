# @aiosbrain/mcp

Read-only access to an AIOS Team Brain from an MCP host. Requires Node.js 22 or newer;
no AIOS checkout, global toolkit installation, native modules or runtime dependencies.

Start with `npx -y @aiosbrain/mcp@0.1.0`. Configure `AIOS_BRAIN_URL` and `AIOS_API_KEY`,
or use the owner-only default tuple in `~/.aios/credentials.json`:

```json
{
  "version": 1,
  "default": {
    "brain_url": "https://brain.example.com",
    "api_key": "<your API key>"
  }
}
```

Keep this file private (`chmod 600` on POSIX; owner-only ACL on Windows). Host
configuration should contain the version-pinned command, never the API key. The host
installer is tracked separately in AIO-1112; do not assume it is available in your toolkit.

Environment credentials take precedence. Existing `.env` and `aios.yaml` configuration
remains supported. Stored credentials are tied to their Brain origin: changing the URL
alone cannot send a stored key to another server. An environment key needs an explicit
or existing workspace URL; it never borrows a URL from the global credential file.

Startup performs one `/api/v1/me` probe with a three-second deadline. Team members get
all eight Brain tools; external members get the four `brain` tools. Missing configuration,
revoked credentials, delegated tokens, malformed identity responses and network failures
register no Brain tools and produce a diagnostic on stderr. Availability stays fixed until
restart; the Brain checks authorization on every call, including after membership changes.

| Toolset | Tools |
| --- | --- |
| `brain` | `brain_status`, `brain_query`, `brain_pull_items`, `brain_get_item` |
| `board` | `brain_list_projects`, `brain_list_tasks`, `brain_list_decisions`, `brain_stakeholders` |

`--toolsets brain,board` overrides `AIOS_MCP_TOOLSETS`. Repeated `--tools <name>` adds tools;
explicit selections form a union and then intersect with the permitted surface. `all` selects
all permitted tools. The workspace collector is available only in the toolkit's `aios mcp`.

Transport is newline-delimited stdio, with serialized JSON-RPC responses on stdout and
all diagnostics on stderr. Initialize returns protocol `2025-11-25` and this package's
version. Query answers preserve citation markers and source lists. This package does not
provide a remote HTTP endpoint or write tools.

Maintainers: generate and pack from the committed candidate with
`node packages/mcp-build/pack.mjs --out <new-artifact-directory>` in the source repository.
Publish the accepted tarball, never the unbuilt source directory.
