# PRD — AIOS-managed GitHub execution gateway pilot

**Status:** Contract-first pilot; production implementation blocked on AIO-400 and AIO-409
**Last updated:** 2026-07-14 · **Owner:** John
**Linear:** [AIO-399](https://linear.app/je4light/issue/AIO-399/aios-managed-github-execution-gateway-pilot),
[AIO-400](https://linear.app/je4light/issue/AIO-400/close-executor-docker-spike-and-replace-gateway-documentation),
[AIO-409](https://linear.app/je4light/issue/AIO-409/prove-the-aios-github-plugin-architecture-on-executor-v1533)
**Architecture:**
[`architecture/executor-credential-gateway.md`](./architecture/executor-credential-gateway.md)

## Summary

Ship a central, self-hosted, read-only GitHub gateway for AIOS teams. Executor `v1.5.33`
remains the pinned, unmodified MCP/tool runtime. Team Brain owns member/team identity, managed
fine-grained PAT custody, exact-call authorization, durable approval/resume, correlation, and
strict audit. A separately versioned companion plugin owns exactly seven curated GET tools and
uses an opaque one-use lease so Executor never persists or exposes a PAT.

The previous AIO-242 PRD described a generic per-workspace aggregation layer, local dotenvx PAT
custody, broad GitHub/Jira/Notion gatewaying, and stale `scaffold-project.sh` splice points. That
design is replaced, not completed. There is no shipped generic Executor gateway in this repo.

## Problem

GitHub appears in the workspace catalog, but managed GitHub execution does not exist. A local PAT
would duplicate custody across workspaces, weaken revocation, and make member/team authorization
impossible to enforce centrally. Executor's credential provider receives an opaque provider item
ID; only its public `invokeTool` seam sees the exact selected tool and arguments. Therefore Brain
authorization must happen at invocation, not credential resolution.

The pilot must prove that separation without a private import, Executor fork, runtime patch,
credential fallback, or wider tool surface.

## Goals

- A member connects one member-owned fine-grained GitHub PAT to Brain and can validate, inspect
  status, discover accessible repositories, and disconnect without the PAT entering workspace or
  Executor persistence.
- Executor exposes one streamable HTTP endpoint scoped by member self-minted API key and toolkit.
- Brain rebinds team/member/Executor subject/connection and authorizes exact normalized arguments
  for every call.
- Block and approval make zero GitHub requests. Allow makes one expected GET. Brain-owned resume
  survives a full Executor restart and concurrent replay has one winner.
- Every decision and outcome is correlated and audited without secret or response content.
- Direct connectors remain available and unchanged during the pilot.

## Non-goals

- GitHub writes, workflow dispatch, repository administration, GraphQL, search, archives, arbitrary
  REST paths/methods, or exactly-once external writes.
- Jira, Notion, Slack, or a generic multi-provider gateway.
- Executor Cloud, an Executor fork, or a core/runtime source modification.
- A team-shared PAT, production PAT in tests, local dotenvx PAT, plaintext file, process-environment
  fallback, or silent migration of a direct connector.

## Fixed boundaries

The pilot is **read-only**, has exactly **seven** fixed operations, uses a **one-use lease**, and
requires **Brain-owned resume**. It uses **no Executor Cloud** and **no fork**. Executor is pinned
to `v1.5.33`, commit `0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b`.
The sole managed toolkit identifier is `aios-github-readonly`; the callable resume tool is exactly
`aios_gateway.resume`. No client-visible or client-persisted resume claim token exists.

| Tool | Bound operation |
|---|---|
| `github.repository.get` | repository metadata |
| `github.contents.get` | file/directory contents at explicit ref, response capped at 1 MiB |
| `github.issues.list` | list issues |
| `github.issue.get` | get one issue |
| `github.pull_requests.list` | list pull requests |
| `github.pull_request.get` | get one pull request |
| `github.pull_request.files.list` | list files on one pull request |

The GitHub fine-grained repository permissions are Metadata: read, Contents: read, Issues: read,
and Pull requests: read. The current labels and mappings were revalidated on 2026-07-14 against
GitHub REST API `2026-03-10` at the primary endpoint pages for
[repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[contents](https://docs.github.com/en/rest/repos/contents#get-repository-content),
[list issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[get issue](https://docs.github.com/en/rest/issues/issues#get-an-issue),
[list pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests),
[get pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), and
[list pull request files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).
GitHub permits Get a pull request with either Pull requests: read or Contents: read; the pilot
chooses Pull requests: read consistently for every pull-request handler. No Actions, Workflows,
Administration, Deployments, Commit statuses, or write permission is in scope.

## Architecture and request lifecycle

### Connect and validate

1. An authenticated team-tier member submits a fine-grained PAT to Brain over TLS. Brain rejects
   external/admin tier, cross-team/member identity, or an invalid permission/repository selection
   before gateway binding.
2. Brain encrypts the PAT with its server-side credential key and binds it to the active team,
   member, Executor subject, provider, and opaque connection reference. The PAT is never returned.
3. Brain validates through a bounded read-only GitHub request and returns identity, repository
   scope, permission labels, expiry/validation time, and non-secret status.
4. Workspace registers only the opaque managed connection and member-owned Executor endpoint/key.

### Resolve and invoke

1. Executor's public `CredentialProvider.get(id)` maps the opaque connection reference to a
   hashed-at-rest, one-use 30-second Brain lease. The lease contains opaque IDs, audience, nonce,
   and expiry, not a GitHub PAT.
2. The companion's public `invokeTool` receives owner, tool row, exact arguments, and lease. It
   normalizes the arguments for the fixed handler and submits their exact value and hash with
   toolkit, tool, subject, correlation, and idempotency IDs to Brain.
3. Brain rebinds identity and tier, evaluates deterministic default-deny policy, and commits strict
   audit. Block/approval returns no credential and causes zero GitHub requests.
4. Allow returns only an opaque authenticated `sealedCredential` AEAD envelope bound to the
   execution and authenticated gateway service identity. Only the host companion opens it
   request-locally immediately before forming one GitHub Authorization header and performing the
   fixed GET; it immediately destroys the plaintext and envelope reference, then records a
   non-secret outcome.

Member connect requests never supply trusted Executor tenant/subject/owner identifiers. Brain
looks up and attests the active member's self-host Executor key/subject binding against the
authenticated gateway service and environment. A missing, ambiguous, stale, cross-member, or
mismatched binding fails closed before PAT validation or persistence.

### Approval and resume

Approval stores the encrypted normalized request envelope and state in Brain for at most 15
minutes. No approval payload or credential is stored in Executor. `aios_gateway.resume` claims the
execution from Brain after approval, including after a full Executor restart. Transactional claim
and idempotency keys make concurrent resumes single-winner; the loser returns a safe settled
result and neither redeems nor calls GitHub.

Executor policy is defense in depth and may only narrow access. Brain exact-call authorization is
authoritative.

## Managed workspace behavior

The versioned public contract is in [`brain-api.md`](./brain-api.md), v1.10. The user-visible
operations are:

| Operation | Success | Typed failures |
|---|---|---|
| connect | `201`, opaque connection + non-secret validation summary | invalid token/permissions, already connected, tier denial |
| validate | `200`, current identity/scope/permission summary | not connected, revoked/expired/upstream failure, tier denial |
| status | `200`, connected/degraded/revoked/disabled status, never PAT | tier denial |
| disconnect | `200`, revoked connection/lease/approval counts | not connected is idempotent success; tier denial |
| discovery | `200`, paginated accessible repository metadata only | not connected, upstream/rate-limit, tier denial |

Every external/admin or tier-elevation attempt returns HTTP `422 forbidden_tier` before credential
lookup. A client speaking v1.10 to an older Brain treats `404` on the managed endpoints as
`managed_gateway_unavailable`, makes no local credential fallback, leaves direct connector state
unchanged, and tells the user that a Brain upgrade is required.

## Policy, audit, and failures

Policy precedence is hard boundary/revocation checks, most-specific rule, priority, then
`block > require_approval > allow`; no match blocks. Team/member/subject/provider/toolkit/tool and
normalized argument hash are rebound on every invoke and resume.

The immutable audit allowlist contains only identifiers, bindings, tool/toolkit, arguments hash,
policy version/rule/decision, correlation/idempotency, timing, upstream status class/byte count,
and non-secret outcome. It excludes PAT, lease, Authorization header, request envelope plaintext,
raw arguments, response body, repository content, and issue/PR content. Audit failure before a
call fails closed.

Resolver, authorization, audit, credential, DNS/TLS/network, GitHub rate-limit/5xx, oversized
response, stale policy/version, revocation, expiry, replay, and outcome-recording errors remain
distinct typed classes. There is no fallback between classes. Executor's private-network SSRF
rejection is expected policy behavior, not credential failure; see the
[wrong-key matrix](./evidence/executor-credential-gateway/docker-wrong-key-matrix.md).

## Security and tier invariants

- Gateway administration and PAT custody are admin operations; execution is team-scoped;
  external-tier principals cannot use the pilot.
- Missing tier is default-deny. Cross-team/member/subject/provider and tier elevation fail before
  secret lookup.
- A PAT never enters files, environment, Executor/plugin persistence, sandbox payloads, MCP output,
  logs, errors, audit metadata, screenshots, traces, fixtures, or evidence.
- Member removal, disconnect, feature disable, service-identity rotation, or PAT rotation/revocation
  invalidates outstanding leases, approvals, and resumable executions.
- Contents requires an explicit ref and caps decoded response bytes at 1 MiB.

## Packaging, deployment, and rollback

The companion is independently versioned and installed into a derived image through public SDK
imports and plugin configuration only. A scripted overlay diff against the pinned commit fails for
any Executor core/runtime source change. Images are built, scanned, signed, and deployed by digest
to self-hosted infrastructure with outbound access limited to Brain and GitHub API.

Cold start refuses Executor, companion, Brain-contract, or policy-version mismatch. Rollout is by
team feature flag after AIO-409 executable proof and independent review. Rollback disables managed
connect, revokes service identities/leases, stops the derived image, and restores the prior signed
digest. Direct connectors remain untouched; additive schema and immutable audit are retained; no
PAT is exported to a workspace.

## Delivery sequence

1. **AIO-400:** close pinned-image Docker evidence and freeze this PRD, architecture, and v1.10
   Brain contract.
2. **AIO-409:** disposable public-SDK proof for lease, exact-call handler, policy, member key,
   toolkit, restart/resume, mock GitHub isolation, and derived image.
3. Brain schema/audit, service routes, policy/approval, companion, image, workspace CLI/GUI, staging,
   and live least-privilege release gate proceed only after both predecessors pass.

The stale AIO-242 phase table and scaffold line references are intentionally removed. Documentation
does not mark the managed gateway Done. Production consumers remain blocked until the executable
proof and their own issue gates pass.

## Pilot acceptance

- Pinned image wrong-key, recovery, no-fallback, SSRF classification, sanitization, and named
  cleanup evidence pass.
- AIO-409 proves all required public SDK seams without a private import, fork, core patch, real PAT,
  or GitHub network call.
- Companion isolation tests prove block/approval zero requests, allow exactly one expected GET,
  restart-safe concurrent resume one claim/one GET, and zero canary leakage.
- Brain tests prove tier/member/team isolation, policy precedence, strict-audit failure behavior,
  lease/replay/revocation/expiry, rotation, and idempotent disconnect.
- Workspace tests prove no local PAT, one central Executor registration, member-key/toolkit scope,
  older-Brain refusal, and unchanged direct connectors.
- Exact-head CI, staging, live least-privilege PAT validation, revocation, cleanup, and retained-
  evidence scans all pass before the pilot is called complete.

## References

- [`docs/architecture/executor-credential-gateway.md`](./architecture/executor-credential-gateway.md)
- [`docs/brain-api.md`](./brain-api.md)
- [`docs/evidence/executor-credential-gateway/docker-wrong-key-matrix.md`](./evidence/executor-credential-gateway/docker-wrong-key-matrix.md)
- Executor `v1.5.33`, commit `0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b`
- GitHub REST API endpoint permission references linked in **Fixed boundaries**, API version
  `2026-03-10`, retrieved 2026-07-14
