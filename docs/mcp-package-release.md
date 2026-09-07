# Standalone MCP package release

`packages/mcp` is the source manifest for independently versioned `@aiosbrain/mcp`.
It is not a publishable build directory. The release artifact contains the canonical
MCP core, stdio runtime, Brain client and configuration/credential readers, with no
runtime dependencies or lifecycle scripts. Operator Loop is outside its explicit
module closure.

## Candidate acceptance

Commit the candidate first. `node scripts/pack-mcp.mjs --out <new-directory>` validates
the static import closure and npm inventory, runs a pack dry-run, then creates one
tarball. `candidate.json` records the source SHA, source digests, tarball SHA-256,
npm SHA-512 integrity, inventory and toolchain versions. Reuse those bytes for every
acceptance cell and publication; do not repack between acceptance and publish.

The `MCP package acceptance` workflow packs the exact PR head (or dispatch SHA),
then installs that artifact in isolated Node 22, 24 and 26 Docker environments.
Only the artifact and built-in-only acceptance driver enter those containers.
The production Brain server and real Postgres run outside them on disposable,
per-run infrastructure at the explicit Brain commit in the workflow. A local
OpenAI-compatible synthetic provider answers only when the real Brain retrieval
supplies the known fixture source; it does not replace Brain routes or authorization.
All eight tools must return successful, nonempty fixture results, including a cited
query. Runtime import containment, exact tool membership, package version, credential
redaction and process/fixture/database cleanup are asserted. Missing infrastructure
or any cleanup failure fails the gate.

A developer can use `MCP_PACKAGE_LOCAL=1` with the same harness on macOS. This still
checks runtime import containment but is not the container isolation evidence required
for publication. Set `MCP_PACKAGE_ARTIFACT`, `MCP_BRAIN_DIR`, `MCP_BRAIN_SHA` and
`MCP_EVIDENCE_DIR`, then run `node test/support/mcp-tier-safety.mjs`.
Without `MCP_PACKAGE_ARTIFACT`, the independent authorization baseline and two mutation
controls run as before.

## Publication

After merge, dispatch `mcp-package-acceptance.yml` at the intended clean release
commit. Download `mcp-candidate` and all three evidence artifacts from that successful
run. Record their artifact digests against the release issue. Tag that same commit
`mcp-v<version>`; the root toolkit version and its `v<version>` tags are independent.

For subsequent OIDC releases, dispatch `publish-npm.yml` at that exact tag with
`package=mcp`, the exact version, and `acceptance_run_id`. The release verifier
requires a successful post-merge dispatch from this repository and workflow, exact
commit/tag/version alignment, all three isolated live cells, and unchanged SHA-256
and SHA-512 tarball bytes. It publishes that tarball without rebuilding it, then
checks the registry integrity.

The first publication requires the package to exist before npm Trusted Publishing
can be configured. Finish every acceptance/review gate first, then publish the
verified tarball using the account's existing WebAuthn/passkey flow. Do not request
a TOTP code for this account. Verify registry version and integrity and perform a
fresh registry installation before completing the issue. Configure the package's
Trusted Publisher as GitHub organization `aiosbrain`, repository `aios-workspace`,
workflow `publish-npm.yml` for subsequent releases.

## Credential source contract

The installed command accepts a private `~/.aios/credentials.json` document:

```json
{"version":1,"default":{"brain_url":"https://brain.example.com","api_key":"REDACTED","team_id":"example"}}
```

The file must be a regular, owner-only file in an owner-controlled real directory.
POSIX ownership/mode checks and Windows ACL checks fail closed. Unknown fields,
malformed JSON, oversized files and a path replaced while reading are rejected.
The tuple binds its key to one normalized Brain origin. Complete explicit environment
credentials override the file. The legacy workspace `.env` and `aios.yaml` path
remains available; a workspace key is not reused for a conflicting environment URL.
Without explicit credentials, the default global tuple takes precedence over local
workspace configuration. The reader never borrows a global URL for an unrelated
explicit environment key.

The host installer that writes this shared file is a separate AIO-1112 release.
Do not advertise installer availability until the toolkit artifact ships.
