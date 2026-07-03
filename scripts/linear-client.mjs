/**
 * linear-client.mjs — zero-dep Linear GraphQL client for `aios ship` / `aios roadmap-run`.
 *
 * The network seam is a single injectable `fetchFn`, so tests replay fixtures and record the
 * request without ever hitting Linear. The personal API key is sent RAW in the Authorization
 * header (no `Bearer` prefix) and is NEVER interpolated into any thrown message or log line.
 *
 * Also home to two pure helpers that operate on UNTRUSTED Linear issue text:
 *   - extractRepoFileRefs — the tracked-only, deny-listed file-reference extractor (recon
 *     reads ONLY what survives it, so issue text can never exfiltrate env / aios / absolute /
 *     parent-traversal paths).
 *   - normalizeBlockedBy   — the proven `blockedBy` direction (inverseRelations + type "blocks").
 *
 * Zero runtime deps; ESM only; Node stdlib + globalThis.fetch.
 */

import path from "node:path";
import { loadDotEnv } from "./brain-config.mjs";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

export class LinearError extends Error {}

// process.env wins (npm run aios runs under dotenvx → LINEAR_API_KEY injected); fall back to
// the repo's existing plaintext .env reader (brain-config.loadDotEnv). NEVER a second parser.
// Returns null when unresolved so the caller decides (e.g. dry-run degrades gracefully).
export function resolveLinearApiKey(repo) {
  const fromEnv = process.env.LINEAR_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const dot = repo ? loadDotEnv(repo) : {};
  return dot.LINEAR_API_KEY?.trim() || null;
}

// ── proven blockedBy direction (verified against Linear's IssueRelationType) ────────────────
// IssueRelationType has NO `blocked_by` value. Blocking is a single directional record —
// `issue` BLOCKS `relatedIssue`, type: "blocks". "Blocked by" is only the inverse view, which
// Linear exposes on inverseRelations (relation.issue is the blocker of THIS issue). Therefore
// the blockers of THIS issue are the "blocks" relations where THIS issue is the relatedIssue,
// i.e. inverseRelations with type === "blocks" (relation.issue == the blocker). The `relations`
// block (where this issue is the SOURCE) with type "blocks" means this issue blocks OTHERS —
// those are deliberately ignored for blockedBy.
export function normalizeBlockedBy(issueNode) {
  const inv = issueNode?.inverseRelations?.nodes ?? [];
  return inv
    .filter((r) => r.type === "blocks" && r.issue)
    .map((r) => ({ identifier: r.issue.identifier, stateType: r.issue.state?.type ?? null }));
}

// Normalize a raw GraphQL issue node into a flat object with a proven `blockedBy`.
function normalizeIssue(node) {
  if (!node) return null;
  return {
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    state: node.state ? { name: node.state.name, type: node.state.type } : null,
    assignee: node.assignee ? { name: node.assignee.name, id: node.assignee.id } : null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    priority: node.priority ?? null,
    createdAt: node.createdAt ?? null,
    parent: node.parent ? { identifier: node.parent.identifier } : null,
    children: (node.children?.nodes ?? []).map((c) => ({
      identifier: c.identifier,
      title: c.title,
      stateType: c.state?.type ?? null,
    })),
    comments: (node.comments?.nodes ?? []).map((c) => ({
      body: c.body,
      user: c.user?.name ?? null,
      createdAt: c.createdAt ?? null,
    })),
    attachments: (node.attachments?.nodes ?? []).map((a) => a.url),
    blockedBy: normalizeBlockedBy(node),
  };
}

// ── extractRepoFileRefs — safe, tracked-only file-reference extractor ────────────────────────
// Linear issue text is EXTERNAL, UNTRUSTED input. Recon must never let it read .env*, .aios/,
// .git/, node_modules/, other gitignored/local artifacts, absolute paths, or ../ traversal into
// model prompts or audit logs. This pure extractor enforces that — recon reads ONLY what
// survives it. `trackedFiles` is a Set the caller builds from `git ls-files`.

// Deny list applied even if — defensively — such a path were ever tracked.
const DENY_PREFIXES = [".aios/", ".git/", "node_modules/"];
const DENY_EXACT = new Set([".env"]);
function isDenied(rel) {
  if (DENY_EXACT.has(rel)) return true;
  if (/^\.env(\.|$)/.test(rel)) return true; // .env, .env.local, .env.production …
  if (/\.(key|pem)$/i.test(rel)) return true;
  return DENY_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}

// Tokenize candidate path-like strings: backtick spans + bare `\S+\.\w+` tokens.
function tokenizeCandidates(issueText) {
  const text = String(issueText ?? "");
  const out = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/\S+\.\w+/g)) out.push(m[0].trim());
  return out;
}

export function extractRepoFileRefs(
  issueText,
  { trackedFiles, maxFiles = 12, maxBytes = 256 * 1024, statFile } = {}
) {
  const tracked = trackedFiles ?? new Set();
  const allowed = [];
  const skipped = [];
  const seen = new Set();
  let cumulativeBytes = 0;

  // Strip surrounding punctuation a path token can pick up in prose (parens, commas, quotes).
  const clean = (raw) => raw.replace(/^[('"[]+/, "").replace(/[)'".,;:\]]+$/, "");

  for (const rawToken of tokenizeCandidates(issueText)) {
    const raw = clean(rawToken);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);

    // Reject absolute paths (POSIX /…, ~…, Windows drive) outright — never read.
    if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:[\\/]/.test(raw)) {
      skipped.push({ raw, reason: "absolute-path" });
      continue;
    }
    // Reject any token with a `..` segment before normalization.
    if (raw.split(/[\\/]/).includes("..")) {
      skipped.push({ raw, reason: "parent-traversal" });
      continue;
    }
    const rel = path.posix.normalize(raw.replace(/\\/g, "/"));
    // Normalization must not escape the repo (leading ../ or absolute after normalize).
    if (rel.startsWith("..") || rel.startsWith("/")) {
      skipped.push({ raw, reason: "parent-traversal" });
      continue;
    }
    if (isDenied(rel)) {
      skipped.push({ raw, reason: "denied" });
      continue;
    }
    if (!tracked.has(rel)) {
      skipped.push({ raw, reason: "not-tracked" });
      continue;
    }
    if (allowed.length >= maxFiles) {
      skipped.push({ raw, reason: "cap-exceeded" });
      continue;
    }
    // Byte size from the caller's stat, never from issue text. A missing stat → 0 bytes.
    let size = 0;
    try {
      size = statFile ? Number(statFile(rel) ?? 0) : 0;
    } catch {
      size = 0;
    }
    if (cumulativeBytes + size > maxBytes) {
      skipped.push({ raw, reason: "cap-exceeded" });
      continue;
    }
    cumulativeBytes += size;
    allowed.push(rel);
  }

  return { allowed, skipped };
}

// ── GraphQL selection sets ────────────────────────────────────────────────────────────────
// Both `relations` and `inverseRelations` are always fetched so blockedBy is provable.
const RELATIONS_FRAGMENT = `
  relations { nodes { type relatedIssue { identifier state { name type } } } }
  inverseRelations { nodes { type issue { identifier state { name type } } } }`;

const ISSUE_CORE_FIELDS = `
  identifier
  title
  description
  priority
  createdAt
  state { name type }
  assignee { name id }
  labels { nodes { name } }
  parent { identifier }
  children { nodes { identifier title state { name type } } }
  ${RELATIONS_FRAGMENT}`;

const ISSUE_FULL_FIELDS = `
  ${ISSUE_CORE_FIELDS}
  comments { nodes { body user { name } createdAt } }
  attachments { nodes { url } }`;

// Candidate-pool fields: trimmed (no comments/attachments) but still carrying relations so
// blockedBy is provable per candidate.
const ISSUE_LIST_FIELDS = `
  identifier
  title
  priority
  createdAt
  state { name type }
  assignee { id }
  ${RELATIONS_FRAGMENT}`;

const LIST_PAGE_CAP = 200; // documented pagination cap

// AIO-<n> → { teamKey: "AIO", number: n }. Deterministic; avoids depending on issue(id:).
function parseIdentifier(identifier) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(identifier ?? "").trim());
  if (!m) throw new LinearError(`invalid Linear identifier '${identifier}' — expected TEAM-<number>.`);
  return { teamKey: m[1].toUpperCase(), number: parseInt(m[2], 10) };
}

/**
 * @param {object} o
 * @param {string} o.apiKey            raw personal API key (never logged)
 * @param {Function} [o.fetchFn]       injected fetch (default globalThis.fetch)
 * @param {number} [o.maxRetries]      bounded retries on 429/5xx (default 1)
 */
export function createLinearClient({ apiKey, fetchFn = globalThis.fetch, maxRetries = 1 } = {}) {
  if (!fetchFn) throw new LinearError("no fetch implementation available (pass fetchFn).");

  // Redact the key from any string that might carry it (defense in depth — we never
  // interpolate it, but a body snippet could theoretically echo a header).
  const redact = (s) => (apiKey ? String(s ?? "").split(apiKey).join("«redacted»") : String(s ?? ""));

  // The single network seam. One bounded retry on HTTP 429/5xx only; no retry on 4xx.
  async function request(query, variables = {}) {
    if (!apiKey) throw new LinearError("LINEAR_API_KEY is not set — cannot call Linear.");
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchFn(LINEAR_API_URL, {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        // Network-layer failure: retry once, then surface (key never in message).
        lastErr = new LinearError(`Linear request failed: ${redact(e.message)}`);
        if (attempt < maxRetries) continue;
        throw lastErr;
      }
      const status = res.status;
      if (!res.ok) {
        let bodySnippet = "";
        try {
          bodySnippet = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        // Retry only transient statuses (429 / 5xx); 4xx fails immediately.
        if ((status === 429 || status >= 500) && attempt < maxRetries) {
          lastErr = new LinearError(`Linear HTTP ${status}: ${redact(bodySnippet)}`);
          continue;
        }
        throw new LinearError(`Linear HTTP ${status}: ${redact(bodySnippet)}`);
      }
      let json;
      try {
        json = await res.json();
      } catch (e) {
        throw new LinearError(`Linear returned non-JSON: ${redact(e.message)}`);
      }
      if (Array.isArray(json.errors) && json.errors.length) {
        const msg = json.errors.map((e) => e.message).join("; ");
        throw new LinearError(`Linear GraphQL error: ${redact(msg)}`);
      }
      return json.data;
    }
    throw lastErr ?? new LinearError("Linear request failed after retries.");
  }

  async function getIssue(identifier, { full = false } = {}) {
    const { teamKey, number } = parseIdentifier(identifier);
    const fields = full ? ISSUE_FULL_FIELDS : ISSUE_CORE_FIELDS;
    const query = `query GetIssue($key: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $key } }, number: { eq: $num } }, first: 1) {
        nodes { ${fields} }
      }
    }`;
    const data = await request(query, { key: teamKey, num: number });
    const node = data?.issues?.nodes?.[0] ?? null;
    return normalizeIssue(node);
  }

  // Resolve an issue's raw UUID + team id (needed for createIssue / addComment / parent filter).
  async function resolveIssueMeta(identifier) {
    const { teamKey, number } = parseIdentifier(identifier);
    const query = `query IssueMeta($key: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $key } }, number: { eq: $num } }, first: 1) {
        nodes { id identifier team { id key } }
      }
    }`;
    const data = await request(query, { key: teamKey, num: number });
    const node = data?.issues?.nodes?.[0];
    if (!node) throw new LinearError(`Linear issue not found: ${identifier}`);
    return { id: node.id, teamId: node.team?.id ?? null };
  }

  async function listIssues({ label, epicIdentifier, project } = {}) {
    const selectors = [label, epicIdentifier, project].filter((v) => v != null && v !== "");
    if (selectors.length !== 1) {
      throw new LinearError(
        "listIssues needs exactly one selector: { label } | { epicIdentifier } | { project }."
      );
    }
    let filter;
    if (label) {
      filter = { labels: { some: { name: { eq: label } } } };
    } else if (epicIdentifier) {
      const meta = await resolveIssueMeta(epicIdentifier);
      filter = { parent: { id: { eq: meta.id } } };
    } else {
      filter = { project: { name: { eq: project } } };
    }

    const query = `query ListIssues($filter: IssueFilter!, $after: String) {
      issues(filter: $filter, first: 50, after: $after) {
        nodes { ${ISSUE_LIST_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const out = [];
    let after = null;
    for (let page = 0; page < Math.ceil(LIST_PAGE_CAP / 50); page++) {
      const data = await request(query, { filter, after });
      const conn = data?.issues;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) out.push(normalizeIssue(n));
      if (!conn?.pageInfo?.hasNextPage || out.length >= LIST_PAGE_CAP) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  async function createIssue({ title, description, parentIdentifier, state } = {}) {
    if (!title) throw new LinearError("createIssue requires a title.");
    if (!parentIdentifier) throw new LinearError("createIssue requires a parentIdentifier.");
    const parent = await resolveIssueMeta(parentIdentifier);
    if (!parent.teamId) throw new LinearError(`could not resolve team for parent ${parentIdentifier}.`);
    const input = {
      title,
      description: description ?? "",
      teamId: parent.teamId,
      parentId: parent.id,
    };
    if (state) input.stateId = state;
    const query = `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier } }
    }`;
    const data = await request(query, { input });
    const identifier = data?.issueCreate?.issue?.identifier ?? null;
    if (!data?.issueCreate?.success || !identifier) {
      throw new LinearError(`issueCreate did not return a new identifier for '${title}'.`);
    }
    return { identifier };
  }

  async function addComment(identifier, body) {
    if (!body) throw new LinearError("addComment requires a body.");
    const meta = await resolveIssueMeta(identifier);
    const query = `mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`;
    const data = await request(query, { input: { issueId: meta.id, body } });
    if (!data?.commentCreate?.success) {
      throw new LinearError(`commentCreate failed for ${identifier}.`);
    }
    return { ok: true };
  }

  return { request, getIssue, listIssues, createIssue, addComment };
}
