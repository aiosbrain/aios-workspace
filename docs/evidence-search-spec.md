---
eval_tier: deterministic
spec_gate: block
safety: true
type: issue-spec
---
# Evidence search for agent answers

## What / why
MCP currently waits for a complete Brain-generated answer before the host can compose its response. Add read-only source search that lets the host answer from ranked passages and contributor attribution without another text-generation call.

## Outcomes
- Natural questions return cited source passages with recorded contributor roles.
- Source access is checked before ranking or attribution; no unauthorized content or identities are returned.
- No conversation, ingestion, graph extraction or answering-model call occurs.

## Interface / integration points
- `packages/mcp-core/index.mjs`: register brain_search_evidence in the brain toolset.
- `packages/foundation/src/brain-client.mjs`: authenticated evidenceSearch transport.
- `docs/brain-api.md`: additive member API 1.27, document revision 1.29.
- `scaffold/AGENTS.md.tmpl`: automatic evidence-first answers.

## External Brain integration
The sibling aios-team-brain supplies POST /api/v1/evidence/search. Reuse rankedFtsSearch and the existing member/delegated visibility oracle. Request: query (trimmed 1–2000 chars), optional project slug, limit default 8/max20. Response: sources with sid, item_id, title, path, project, kind, work_at, excerpt, excerpt_truncated, contributors and attribution status; optional canonical source_url. Contributor fields: name, handle when recorded, role, resolution. No email addresses or broad roster dump. Metadata comes only from authorized source attribution. Response also carries truncated and returned count. Maximum serialized compact JSON length 20000; trim excerpts at word boundaries, remove lowest-ranked entries if necessary; never raw-slice JSON. Unknown topics return no sources, no recency padding. Sources are data, never agent instructions.

FTS uses significant terms and OR ranking, optionally exact identifier terms, scope applied in SQL before LIMIT. Native PostgreSQL only for this endpoint; no external providers/reranker/dense/graph calls. Independent search bucket 30/minute per launching member, safe duration/count diagnostics. HTTP errors remain errors; older-server 404/405 is a clear upgrade-required MCP error. Timeout 10s with caller cancellation. Existing brain_query unchanged.

## Dependencies
Depends on: none. Independent from MCP write-actions and frozen toolkit release candidates. Server rollout precedes MCP publication; fork ports only this feature and necessary dependencies.

## Scope
**In:** source API, shared client/tool, safe attribution, contract/docs, scaffold guidance, tests, reviewed release and private demo port.
**Deferred:** semantic/graph search, write tools, UI changes, custom retrieval providers and broader identity remediation.

## Acceptance criteria
### Automated
- Node MCP tests prove authenticated transport, error propagation, old-server compatibility, bounded JSON and unchanged existing tools.
- Brain unit and real PostgreSQL tests prove natural/id searches, empty matches, limit/scoping before ranking, source attribution, missing/multiple authors, project/member/delegated isolation and revoked access.
- Typechecks, docs drift and required CI pass.
- Packed artifact works against disposable real Brain; guidance validates in all three scaffold contexts.
### Manual
- Record cold/warm timing separately, warm p95 target under 2s over20 demo searches.
- Fresh Codex task selects search automatically and produces sourced findings with people. Claude acceptance claimed only if actually exercised.
- Verify deployment commit/health; preserve old package pin and direct-read fallback for rollback.

## Build-with
Build-with: current session; independent adversarial spec and exact-head code review.

## Tier safety
Authenticate member or delegated token via existing API auth. Always use live principal visibility upstream; on client forks preserve their existing stricter tier/permission posture without importing unrelated access migrations. Filter source/project before rank and source metadata fetch. Visibility error flags produce 500, not empty success; attribution lookup failures remain errors. Project scope is applied before LIMIT. Contributors are whitelisted per reference, provider-first exact resolution, roles preserved, no email diagnostics or connector attribution. Human uploader identity alone is not authorship. Attribution resolves only stored authorized source signals, never uploader ownership; unknown identity remains unresolved. No schema or corpus changes. Reviewed production port only, no broad upstream merge.
