# AIOS Workspace — agent guide

The operating manual for this repo lives in **[CLAUDE.md](CLAUDE.md)** — read it first.
It covers what the toolkit is, the repo map, the workspace spine + access-tier safety
boundary, the pinned `docs/brain-api.md` sync contract, and the do-not list.

## Review evidence

An independent adversarial **Codex Astra or Claude Fable** review is sufficient model
review evidence for a pull request, including safety-sensitive changes, when required
executable CI passes. Use a separate review session/agent from the implementer. Retain a
substantive report naming the model, exact base and head commits, inspected scope,
verification, findings and verdict. Re-review after a changed head; resolve every blocking
finding before an exact-head MERGE_READY attestation.

Bugbot and CodeRabbit are supplementary automated review at scale, not mandatory approval
providers. Their absence, rate limits or usage limits do not block a qualifying Astra/Fable
review. Their concrete findings still require disposition; a green check without substantive
review is not approval. Do not disable executable tests, secret/NDA checks, provenance gates,
or exact-head evidence validation. Separately specified human release sign-offs remain in
force unless the owner explicitly changes them.

Error ledger (2026-08-10): loop-model routing changes must be reviewed against the separately
published `@aiosbrain/aios-devtools` runtime; core tests alone cannot prove `spec eval`/`ship`
parity. Land and publish the devtools companion before bumping the core exact dependency pin.
