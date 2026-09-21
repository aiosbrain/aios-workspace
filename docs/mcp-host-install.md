# MCP host installation

Released in toolkit **2.1.0** (AIO-1112). The installer ships inside `@aiosbrain/aios`;
the server it installs is the separately published, zero-dependency `@aiosbrain/mcp@0.2.1`.

MCP setup is **optional and always explicit**. Installing or upgrading the toolkit
(`npm i -g @aiosbrain/aios`, `aios update`) never reads or rewrites a host configuration:
the package's `postinstall` step only checks the bundled operator-loop build and prints
a banner, and touches no Claude Desktop, Claude Code, Codex or Cursor file. A host is configured only when you run `aios mcp install`, or accept the offer
onboarding makes after a successful Brain connection.

`aios mcp install` offers host selection. Noninteractive use requires an explicit list:

```sh
aios mcp install --host claude-desktop,claude-code,codex,cursor --dry-run
aios mcp install --host claude-desktop,claude-code,codex,cursor
aios mcp status --json
aios mcp install --host cursor --uninstall
```

The host registry is separate from the runtime registry. Claude Desktop uses its
documented macOS Application Support or Windows AppData JSON file; Claude Code uses
the current project's `.mcp.json`; Codex uses global `~/.codex/config.toml`; Cursor
uses global `~/.cursor/mcp.json`. Claude Desktop on Linux is unsupported.

The installer downloads the published `@aiosbrain/mcp@0.2.1` tarball from the npm
registry (bounded to 1 MiB, redirects refused), verifies its pinned SHA-512 integrity
before unpacking, and stores its explicit 15-file closure under owner-controlled
`~/.aios/mcp/0.2.1`. Any other entry, a dependency, or a lifecycle script in the
archive is refused. Nothing is installed through `npm`, so no package script runs.
The recorded command uses the installed Node executable and the
absolute server entry point; project-local packages cannot shadow it. Host entries contain a nonsecret
installer marker, not an API key. Installation ownership is recorded separately in
`~/.aios/mcp-installations.json`.

One default Brain tuple is stored in `~/.aios/credentials.json`, after a successful
three-second `/api/v1/me` validation. POSIX ownership and permissions or Windows ACLs
are enforced before credential bytes are written. Credentials remain readable by
other processes running as the same user; this centralizes configuration rather
than isolating secrets from those processes. Existing insecure files are refused,
not silently repaired. Changing the default affects new launches in every configured
host. Restart all configured hosts after credential rotation.

Every selected file is parsed and preflighted before any mutation. Malformed files,
symlinks, foreign ownership, running hosts, and unowned or edited server entries
are refused. Existing content receives a restrictive backup. Same-directory temporary
files replace existing targets with an OS atomic swap or replace-with-backup operation,
after source identity and bytes are rechecked. The displaced inode is checked too,
so an edit made at the final replacement boundary is retained for recovery. New
files use exclusive creation. Unsupported filesystem operations fail closed.
The toolkit uses Koffi for these native operations; the standalone MCP package
retains zero runtime dependencies.
A partial failure restores prior writes only while their identities and bytes still
match the installer; conflicting edits are preserved and reported. Backups may remain
for recovery. Uninstall preserves shared credentials and edited or unowned entries.

JSON changes preserve unrelated values. TOML changes preserve unrelated source bytes,
including comments, numbers, and other server tables, by editing only the exact
installer block and validating the complete result. Dry-run returns redacted proposed
entry changes and creates no credentials, backups, records, files, or directories.

Installation verifies the recorded command through `initialize` and `tools/list`
before any host file is replaced. The launch must report server version `0.2.1` and
exactly the pinned artifact's read-only tools: the five Brain tools (`brain_status`,
`brain_search_evidence`, `brain_query`, `brain_pull_items`, `brain_get_item`) for an
`external` identity, or those five plus the four board tools (`brain_list_projects`,
`brain_list_tasks`, `brain_list_decisions`, `brain_stakeholders`) for a `team`
identity. A missing, extra, renamed or writable tool, or another version, fails the
installation and rolls it back. The expected membership is frozen with the pinned
artifact rather than read from the toolkit's current source, so it changes only when
the pin does.

Status reports configuration, the credential source for a new launch, and command
verification. Host loading and restart state remain explicitly unverified: confirm
the tools inside each host after restarting. Claude Code may require project trust
approval.

A running host is never changed underneath you. If a selected host is running, the
installer refuses before writing anything and asks you to quit it; it does not stop,
signal or restart applications, and it re-checks immediately before each replacement.
A host reads its MCP configuration at launch, so new tools appear only after you
restart that host yourself.

`aios onboard` offers MCP setup once, after the Team Brain connection has been
validated (`/api/v1/me` succeeded), as a confirmation that defaults to **No**.
Declining, cancelling, or choosing no hosts skips setup and changes nothing; run
`aios mcp install` later. Accepting runs the same installer described here with the
credential onboarding just validated. Personal (standalone) onboarding, and any run
where the Brain connection did not validate, never shows the offer. A failed MCP
setup is reported as a warning and does not fail onboarding.

Primary format references, verified September 2026:

- [Claude Desktop local servers](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
