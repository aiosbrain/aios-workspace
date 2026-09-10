# MCP host installation

Release candidate for AIO-1112. Installer availability is gated on the toolkit release;
the standalone `@aiosbrain/mcp@0.1.1` package is already published separately.

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

The installer downloads the published `@aiosbrain/mcp@0.1.1` tarball, verifies its
pinned SHA-512 integrity, and stores its explicit file closure under owner-controlled
`~/.aios/mcp/0.1.1`. The recorded command uses the installed Node executable and the
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

Installation verifies the recorded command through `initialize` and `tools/list`.
Status reports configuration, the credential source for a new launch, and command
verification. Host loading and restart state remain explicitly unverified: confirm
the tools inside each host after restarting. Claude Code may require project trust
approval. Onboarding offers MCP setup after a successful Brain connection, with an
explicit decline path; standalone onboarding skips it.

Primary format references, verified September 2026:

- [Claude Desktop local servers](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
