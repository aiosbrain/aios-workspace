# AIOS-managed GitHub execution gateway architecture

**Status:** pilot contract
**Date:** 2026-07-14
**Runtime pin:** Executor `v1.5.33`, commit
`0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b`
**Related:** AIO-399, AIO-400, AIO-409

## Decision

AIOS will compose an independently versioned GitHub companion plugin into a derived,
self-hosted Executor image. Executor stays an unmodified tool runtime. Team Brain is the sole
authority for member identity, team binding, GitHub credential custody, exact-call policy,
durable approval/resume, and compliance audit. The workspace configures managed mode and holds
only its member-scoped Executor API key; it never receives or persists a GitHub PAT.

This is a read-only pilot with exactly seven tools. There is no Executor Cloud, no fork, no
private Executor import, no core/runtime patch, no shared team credential, and no plaintext or
environment credential fallback.

## Fixed tool registry and GitHub permissions

Every handler is GET-backed. Callers cannot supply an arbitrary URL, HTTP method, GraphQL query,
archive request, search expression, or workflow action. File/directory contents require an
explicit ref and have a 1 MiB response cap.

The one managed toolkit identifier is `aios-github-readonly`. The callable resume tool is exactly
`aios_gateway.resume`. Resume rebinds and claims state in Brain; there is no client-visible or
client-persisted resume claim token.

The credential boundary uses a one-use lease with Brain-owned resume; neither the workspace nor
Executor persists a GitHub credential or resumable claim token.

| Registry identifier | GitHub operation | Fine-grained PAT repository permission |
|---|---|---|
| `github.repository.get` | repository metadata | Metadata: read |
| `github.contents.get` | file or directory contents at an explicit ref | Contents: read |
| `github.issues.list` | list issues | Issues: read |
| `github.issue.get` | get one issue | Issues: read |
| `github.pull_requests.list` | list pull requests | Pull requests: read |
| `github.pull_request.get` | get one pull request | Pull requests: read |
| `github.pull_request.files.list` | list files on one pull request | Pull requests: read |

Permission labels were revalidated on 2026-07-14 against GitHub's current REST API version,
`2026-03-10`, using the primary endpoint references for
[Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[Get repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content),
[List repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[Get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue),
[List pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests),
[Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), and
[List pull request files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).
Metadata is selected read-only for repository metadata; Contents, Issues, and Pull requests are
selected read-only for their named handlers. GitHub currently allows **Get a pull request** with
either Pull requests: read or Contents: read; the pilot consistently chooses Pull requests: read
for all three pull-request handlers. Actions, Workflows, Administration, Deployments, Commit
statuses, and every write permission are excluded.

## Trust boundaries and credential flow

```text
workspace/agent
  | member-owned Executor API key; selected toolkit
  v
pinned self-hosted Executor + companion plugin
  | CredentialProvider.get(id) -> opaque one-use Brain lease
  | invokeTool(owner, toolkit, exact normalized arguments, lease)
  v
Team Brain gateway authority
  | rebind team + member + Executor subject + connection + tier
  | exact-call policy -> block | require_approval | allow
  | strict audit insert, then request-local redeem
  v
companion host handler --Authorization: Bearer PAT--> api.github.com
```

The `CredentialProvider` closes over the Executor owner binding. Its pinned public seam is
`CredentialProvider.get(id)`: `get` returns a hashed-at-rest, one-use Brain lease with opaque IDs,
audience, nonce, and a 30-second expiry. It never returns a PAT. A lease is not valid GitHub
authentication.

At `invokeTool`, the companion normalizes the selected registry operation's arguments and submits
the lease, Executor tenant/subject, toolkit, exact tool identifier, normalized arguments,
arguments hash, correlation ID, and idempotency key to Brain. Brain re-resolves every binding and
evaluates policy over those exact arguments. It returns no credential for block or approval.

Only an allow decision, or a single-winner approved resume claim, may redeem the PAT. Brain first
commits the immutable decision audit, then returns only an opaque authenticated `sealedCredential`
AEAD envelope bound to the execution and authenticated gateway service identity. Only the host
companion opens it request-locally immediately before forming one upstream Authorization header;
it immediately destroys the plaintext and envelope reference. Neither form is returned to
Executor, the sandbox, MCP, workspace, or evidence.

## Tier and identity isolation

Gateway administration and credential custody are admin operations. Member executions are
team-scoped. External-tier principals cannot use this pilot. Missing tier, inactive membership,
subject mismatch, connection mismatch, provider mismatch, cross-team/member access, and any tier
elevation fail closed before credential lookup. A tier violation is HTTP `422 forbidden_tier`
with non-secret metadata.

There is no team-shared fallback. Each connection binds one active team, member, Executor subject,
provider, and encrypted Brain secret reference. Revoked or expired bindings never fall through to
another member, a workspace `.env`, an Executor encrypted secret, or a process environment value.
Member connect payloads do not choose tenant, subject, owner, or connection identifiers. Brain
resolves and attests the member's self-host Executor key/subject binding against the authenticated
gateway service/environment; a missing, ambiguous, stale, or mismatched attestation fails before
PAT validation or persistence.

## Policy precedence and approval/resume

Policy is deterministic and default-deny:

1. hard boundary checks: service identity, team/member/subject/connection, tier, registry, GET-only;
2. revocation, expiry, stale policy/version, and replay checks;
3. most-specific matching rule (member > role > team; exact tool > toolkit wildcard), then priority;
4. `block` wins a same-specificity/priority conflict;
5. `require_approval` wins over `allow`;
6. absence of a matching allow is block.

Executor's `ToolPolicyProvider` is defense in depth and can only make the result stricter. Brain's
exact-call decision is authoritative.

Approval persists the encrypted normalized request envelope in Brain, never in Executor. It lasts
15 minutes. `aios_gateway.resume` claims the execution in Brain and reconstructs the call from the
Brain-owned envelope after a full Executor restart. An exclusive transactional claim plus the
execution/idempotency key makes concurrent resumes single-winner. Losers receive a safe settled
result; they do not redeem or call GitHub.

## Strict audit

An allow cannot reach GitHub until the immutable audit insert succeeds. Audit fields are limited to
IDs, team/member/subject references, toolkit/tool, normalized-argument hash, policy/rule/version,
decision, correlation/idempotency IDs, timing, upstream status class, byte count, and non-secret
failure/outcome classification. Audit never stores the PAT, lease, request envelope plaintext,
Authorization header, response body, file contents, issue/PR content, or raw tool arguments.

Outcome recording is best-effort only after a request has crossed the strict pre-call audit gate.
If outcome recording fails, the caller receives a typed audit/network outcome error and operators
reconcile by correlation ID; the credential is still destroyed request-locally.

## Failure taxonomy

| Class | Required behavior | GitHub requests |
|---|---|---:|
| unauthenticated service/member key | reject before resolution | 0 |
| cross-team/member/subject/provider or tier violation | `401`, `403`, or typed `422` before credential lookup | 0 |
| unknown tool/toolkit or widened arguments | block, no fallback | 0 |
| expired, revoked, consumed, malformed lease | typed lease failure | 0 |
| stale policy or contract/image mismatch | fail closed | 0 |
| approval required/denied/expired | durable safe result | 0 |
| strict audit insert failure | fail closed before redeem | 0 |
| Brain resolver/authorization unavailable | fail closed; bounded retry only | 0 |
| PAT redemption/decryption failure | typed credential failure; no fallback | 0 |
| GitHub timeout/DNS/TLS/rate limit/5xx | typed network/upstream error; no implicit replay | at most 1 |
| response over 1 MiB for contents | abort and classify `response_too_large` | at most 1 |
| Executor private-network SSRF rejection | expected Executor policy behavior, not credential failure | 0 |

The disposable Docker evidence in
[`docker-wrong-key-matrix.md`](../evidence/executor-credential-gateway/docker-wrong-key-matrix.md)
proves changed-key loud failure, no fallback, restored-key recovery, and the separate SSRF-policy
classification against the pinned image.

## Rotation, revocation, and disconnect

- Rotating a member PAT writes a new encrypted Brain secret version, validates it through a
  read-only call, atomically activates it, revokes the old version, and invalidates outstanding
  leases. The PAT is never exported.
- Rotating a gateway service identity supports an overlap window for the two hashed service
  credentials, followed by revocation of the old identity and lease invalidation.
- Member removal, subject unbinding, PAT revocation, feature-flag disable, or managed disconnect
  immediately revokes connections, leases, pending approvals, and resumable executions.
- Disconnect preserves immutable audit/execution records and returns only non-secret status.

## Derived image lifecycle, deployment, and rollback

The derived image starts from the signed/pinned Executor `v1.5.33` image/source commit and installs
only the independently versioned companion package plus public plugin configuration. Its overlay
diff may contain dependency, lockfile, image, and plugin-composition files only. CI fails if any
Executor core/runtime source differs from the pinned commit.

Deploy by digest to a self-hosted environment with outbound access restricted to Team Brain and
GitHub API endpoints. Configure Brain service identity through the deployment secret manager;
never bake it into the image. Health checks verify exact Executor, companion, Brain-contract, and
policy versions before enabling the team feature flag.

Rollback disables new managed connects, revokes gateway identities and active leases, stops the
derived image, and restores the last signed digest. Direct connectors remain untouched. Additive
Brain schema and immutable audit/execution records are retained. Rollback never exports a PAT to a
workspace or restores secret-bearing evidence.
