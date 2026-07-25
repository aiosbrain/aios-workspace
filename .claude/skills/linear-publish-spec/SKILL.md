---
name: linear-publish-spec
description: Publish or replace an AIO Linear issue description from a locally evaluated candidate. Use only when the user explicitly asks to publish and provides or approves the exact issue and candidate; never auto-trigger from review, readiness, authoring, or repair requests.
---

# Publish a spec to Linear

Treat this as a single external write with optimistic concurrency.

1. Confirm the exact `AIO-<n>` id, candidate path, final `SPEC_READY` artifact, evaluated candidate
   SHA, and evaluated repository SHA.
2. Export the current remote description immediately before mutation and compute its SHA-256.
3. Refuse if the remote hash differs from the user-approved `--expected-remote-sha`, or if any
   candidate/repository/evaluation identity is stale.
4. Invoke `aios spec publish` rather than composing API or shell writes.
5. Preserve the remote backup, candidate, request/response metadata, and hashes in the audit bundle.
6. Replace once, fetch again, and byte-verify the remote description. On mismatch or ambiguous
   response, report uncertainty and stop all later writes.
7. Report whether the write was verified. Never infer success from a transport-only response.

Never change issue state, publish from `NOT_READY` or `NOT_EVALUATED`, overwrite concurrent edits,
or retry an ambiguous mutation.
