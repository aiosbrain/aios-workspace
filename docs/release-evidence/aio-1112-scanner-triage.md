# AIO-1112 installer scanner triage

Reviewed 2026-09-10 against PR #686. This is a finding disposition, not a claim
that the external scanner checks passed or that the installer has shipped.

## Corrections

- Archive fields now find the first NUL byte directly, removing the scanner's
  backtracking-regexp concern. The archive remains integrity-pinned, decompression
  capped at 1 MiB, and restricted to an exact file allowlist.
- Tool-name membership comparison uses an explicit string comparator on both sets.
  Alphabetical sorting was intentional; no numeric ordering is involved.
- The Windows synthetic fixture now uses the same absolute system PowerShell
  resolver as production. It no longer performs a PATH executable lookup.
- Duplicate host-registry imports were consolidated and process-path normalization
  uses replaceAll.

## Reviewed non-blocking findings

The SonarCloud annotations at check 102760721170 also identify cognitive complexity,
closure placement, default-parameter ordering, nested ternaries/templates, String.raw,
indexOf/includes, and reverse placement. These are maintainability findings, not
independent demonstrations of unsafe mutation. The transaction's explicit recovery
paths are retained; changing its structure solely for a complexity threshold would
require another concurrency review. The array reversals apply to private rollback
tracking arrays after the forward transaction fails. The optional owner argument is
always supplied at the production call sites. No scanner configuration is suppressed.

Codacy check 102760561210 reports 66 findings but exposes only 50 annotations through
its GitHub check API; every exposed annotation is the same dynamic-file-path warning.
Production sites in mcp-host-files.mjs and mcp-host-atomic.mjs operate on registry-derived
host paths or installer-created sibling temporary, backup and recovery names. The
caller explicitly selects a local project/home; this is a local installer, not a
remote path-writing API. Preflight checks reject symlinks, nonregular/multiply-linked
files, foreign ownership and unsafe private directory permissions. Reads verify inode
identity; commits recheck parents, identity and bytes; OS-native exchange preserves the
displaced inode; rollback refuses changed targets. The test sites deliberately construct
paths under synthetic temporary homes to exercise these boundaries. These warnings do
not justify deleting the filesystem checks or allowing unchecked paths. Unexposed
provider findings are not claimed reviewed; the provider summary remains visible.

## Verification

Focused installer and atomic tests: 26 pass, two Windows-only cases skipped locally.
The native Windows lane must pass again on the final PR head, alongside Linux/macOS,
package acceptance, required CI and substantive current-head cloud review. Real
Claude Desktop acceptance succeeded with published MCP 0.1.1: eight tools visible,
brain_status connected, and brain_query returned source citations. Other host acceptance
and toolkit publication are tracked separately and are not implied by this document.
