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

// Workspace-bound resolver used by the public CLI. The ambient environment is deliberately
// excluded unless the caller opts in for an explicit CI flow: a shell inherited from another
// project must never silently select the credential used for a Linear mutation.
export function resolveWorkspaceLinearApiKey(
  repo,
  { vaultGetFn, allowEnv = false, env = process.env } = {}
) {
  if (!repo) return { apiKey: null, source: "none" };
  if (vaultGetFn) {
    const fromVault = String(vaultGetFn(repo, "LINEAR_API_KEY") || "").trim();
    if (fromVault) return { apiKey: fromVault, source: "workspace-vault" };
  }
  const dot = loadDotEnv(repo);
  const plaintext = String(dot.LINEAR_API_KEY || "").trim();
  if (plaintext) return { apiKey: plaintext, source: "workspace-plaintext" };
  if (allowEnv) {
    const ambient = String(env.LINEAR_API_KEY || "").trim();
    if (ambient) return { apiKey: ambient, source: "explicit-environment" };
  }
  return { apiKey: null, source: "none" };
}

// Backwards-compatible resolver for devtools commands historically executed under `dotenvx run`.
// New account-scoped commands must call resolveWorkspaceLinearApiKey instead.
export function resolveLinearApiKey(repo) {
  const ambient = String(process.env.LINEAR_API_KEY || "").trim();
  if (ambient) return ambient;
  return resolveWorkspaceLinearApiKey(repo).apiKey;
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
    id: node.id ?? null,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    state: node.state ? { name: node.state.name, type: node.state.type } : null,
    assignee: node.assignee ? { name: node.assignee.name, id: node.assignee.id } : null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    priority: node.priority ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    url: node.url ?? null,
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
    relations: (node.relations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      direction: "outbound",
      identifier: r.relatedIssue?.identifier ?? null,
    })),
    inverseRelations: (node.inverseRelations?.nodes ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      direction: "inbound",
      identifier: r.issue?.identifier ?? null,
    })),
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
  relations { nodes { id type relatedIssue { identifier state { name type } } } }
  inverseRelations { nodes { id type issue { identifier state { name type } } } }`;

const ISSUE_CORE_FIELDS = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  url
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

// Pagination hard cap: listIssues fetches at most this many issues (4 pages × 50). A source with
// more than this is TRUNCATED — listIssues emits a loud non-fatal warning when it stops here while
// Linear still has more pages, so a large backlog can't silently starve the candidate pool.
const LIST_PAGE_CAP = 200;

// AIO-<n> → { teamKey: "AIO", number: n }. Deterministic; avoids depending on issue(id:).
function parseIdentifier(identifier) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(identifier ?? "").trim());
  if (!m)
    throw new LinearError(`invalid Linear identifier '${identifier}' — expected TEAM-<number>.`);
  return { teamKey: m[1].toUpperCase(), number: parseInt(m[2], 10) };
}

/**
 * @param {object} o
 * @param {string} o.apiKey            raw personal API key (never logged)
 * @param {Function} [o.fetchFn]       injected fetch (default globalThis.fetch)
 * @param {number} [o.maxRetries]      bounded retries on 429/5xx (default 1)
 * @param {number} [o.timeoutMs]       per-request abort timeout (default 30s) so a hung
 *                                     connection can never block ship/roadmap-run forever.
 * @param {number} [o.retryDelayMs]    base delay for safe read retries (default 100ms)
 */
export function createLinearClient({
  apiKey,
  fetchFn = globalThis.fetch,
  maxRetries = 1,
  timeoutMs = 30_000,
  retryDelayMs = 100,
} = {}) {
  if (!fetchFn) throw new LinearError("no fetch implementation available (pass fetchFn).");

  // Redact the key from any string that might carry it (defense in depth — we never
  // interpolate it, but a body snippet could theoretically echo a header).
  const redact = (s) =>
    apiKey
      ? String(s ?? "")
          .split(apiKey)
          .join("«redacted»")
      : String(s ?? "");

  const delayFor = async (res, attempt) => {
    const retryAfter = Number(res?.headers?.get?.("retry-after"));
    const resetAt = Number(res?.headers?.get?.("x-ratelimit-requests-reset"));
    const hinted = Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter * 1000
      : Number.isFinite(resetAt) && resetAt > Date.now()
        ? resetAt - Date.now()
        : retryDelayMs * (attempt + 1);
    const bounded = Math.max(0, Math.min(2_000, hinted));
    if (bounded) await new Promise((resolve) => setTimeout(resolve, bounded));
  };

  // The single network seam. One bounded retry on HTTP 429/5xx only; no retry on 4xx. Mutations
  // pass { retryable: false }: a retry after a write that Linear accepted-but-whose-response-was-
  // lost would DUPLICATE the issue/comment, so mutations never retry (they surface the error and
  // the caller escalates instead). Every request is also bounded by an abort timeout so a hung
  // socket cannot wedge an unattended `roadmap-run`.
  async function request(query, variables = {}, { retryable = true } = {}) {
    if (!apiKey) throw new LinearError("LINEAR_API_KEY is not set — cannot call Linear.");
    const attempts = retryable ? maxRetries : 0;
    let lastErr = null;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      let res;
      // A fresh abort timeout per attempt (AbortSignal.timeout is Node 18+; degrade gracefully).
      const signal =
        typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      try {
        res = await fetchFn(LINEAR_API_URL, {
          method: "POST",
          headers: { Authorization: apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        // Network-layer failure (incl. abort timeout): retry once when retryable, then surface
        // (key never in message).
        lastErr = new LinearError(`Linear request failed: ${redact(e.message)}`);
        if (attempt < attempts) continue;
        throw lastErr;
      }
      const status = res.status;
      let raw = "";
      try {
        raw = await res.text();
      } catch (e) {
        throw new LinearError(`Linear response could not be read: ${redact(e.message)}`);
      }
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch (e) {
        if (res.ok) throw new LinearError(`Linear returned non-JSON: ${redact(e.message)}`);
      }
      const errors = Array.isArray(json?.errors) ? json.errors : [];
      const rateLimited = errors.some((error) => error?.extensions?.code === "RATELIMITED");
      if (!res.ok) {
        const bodySnippet = raw.slice(0, 300);
        if ((status === 429 || status >= 500 || rateLimited) && attempt < attempts) {
          lastErr = new LinearError(`Linear HTTP ${status}: ${redact(bodySnippet)}`);
          await delayFor(res, attempt);
          continue;
        }
        throw new LinearError(`Linear HTTP ${status}: ${redact(bodySnippet)}`);
      }
      if (errors.length) {
        if (rateLimited && attempt < attempts) {
          lastErr = new LinearError(`Linear GraphQL rate limit: ${redact(errors[0]?.message)}`);
          await delayFor(res, attempt);
          continue;
        }
        const msg = errors.map((e) => e.message).join("; ");
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
        nodes { id identifier team { id key name } }
      }
    }`;
    const data = await request(query, { key: teamKey, num: number });
    const node = data?.issues?.nodes?.[0];
    if (!node) throw new LinearError(`Linear issue not found: ${identifier}`);
    return {
      id: node.id,
      teamId: node.team?.id ?? null,
      teamKey: node.team?.key ?? null,
      teamName: node.team?.name ?? null,
    };
  }

  async function getIdentity() {
    const query = `query AiosLinearIdentity {
      viewer { id name email }
      teams(first: 100) { nodes { id key name } }
    }`;
    const data = await request(query);
    return { viewer: data?.viewer ?? null, teams: data?.teams?.nodes ?? [] };
  }

  async function listTeams() {
    return (await getIdentity()).teams;
  }

  async function resolveTeam(selector) {
    const wanted = String(selector || "").trim().toLowerCase();
    if (!wanted) throw new LinearError("a team key, name, or id is required.");
    const matches = (await listTeams()).filter((team) =>
      [team.id, team.key, team.name].some((value) => String(value || "").toLowerCase() === wanted)
    );
    if (matches.length !== 1) {
      throw new LinearError(
        matches.length ? `team selector '${selector}' is ambiguous.` : `Linear team not found: ${selector}`
      );
    }
    return matches[0];
  }

  async function listWorkflowStates(teamId) {
    const query = `query AiosLinearStates($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
        nodes { id name type }
      }
    }`;
    const data = await request(query, { teamId });
    return data?.workflowStates?.nodes ?? [];
  }

  async function resolveWorkflowState(teamId, selector) {
    const wanted = String(selector || "").trim().toLowerCase();
    const matches = (await listWorkflowStates(teamId)).filter((state) =>
      [state.id, state.name, state.type].some(
        (value) => String(value || "").toLowerCase() === wanted
      )
    );
    if (matches.length !== 1) {
      throw new LinearError(
        matches.length
          ? `workflow state '${selector}' is ambiguous.`
          : `Linear workflow state not found: ${selector}`
      );
    }
    return matches[0];
  }

  async function listUsers() {
    const query = `query AiosLinearUsers { users(first: 100) { nodes { id name displayName email } } }`;
    const data = await request(query);
    return data?.users?.nodes ?? [];
  }

  async function resolveUser(selector) {
    if (selector == null || String(selector).trim().toLowerCase() === "none") return null;
    const wanted = String(selector).trim().toLowerCase();
    const matches = (await listUsers()).filter((user) =>
      [user.id, user.name, user.displayName, user.email].some(
        (value) => String(value || "").toLowerCase() === wanted
      )
    );
    if (matches.length !== 1) {
      throw new LinearError(
        matches.length ? `assignee '${selector}' is ambiguous.` : `Linear user not found: ${selector}`
      );
    }
    return matches[0];
  }

  async function resolveProject(selector) {
    const wanted = String(selector || "").trim();
    if (!wanted) return null;
    const query = `query AiosLinearProject($name: String!) {
      projects(filter: { name: { eqIgnoreCase: $name } }, first: 10) { nodes { id name } }
    }`;
    const data = await request(query, { name: wanted });
    const matches = data?.projects?.nodes ?? [];
    if (matches.length !== 1) {
      throw new LinearError(
        matches.length ? `project '${selector}' is ambiguous.` : `Linear project not found: ${selector}`
      );
    }
    return matches[0];
  }

  async function resolveLabels(names) {
    const ids = [];
    for (const name of names || []) {
      const query = `query AiosLinearLabel($name: String!) {
        issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 10) { nodes { id name } }
      }`;
      const data = await request(query, { name });
      const matches = data?.issueLabels?.nodes ?? [];
      if (matches.length !== 1) {
        throw new LinearError(
          matches.length ? `label '${name}' is ambiguous.` : `Linear label not found: ${name}`
        );
      }
      ids.push(matches[0].id);
    }
    return ids;
  }

  async function listWorkspaceIssues({ team, state, assignee, project, label, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, LIST_PAGE_CAP));
    if (String(assignee || "").toLowerCase() === "me") {
      return listMyIssues({ state, limit: bounded });
    }
    const filter = {};
    if (team) filter.team = { key: { eq: String(team).toUpperCase() } };
    if (state) filter.state = { name: { eqIgnoreCase: state } };
    if (assignee) filter.assignee = { email: { eqIgnoreCase: assignee } };
    if (project) filter.project = { name: { eqIgnoreCase: project } };
    if (label) filter.labels = { name: { eqIgnoreCase: label } };
    const query = `query AiosLinearList($filter: IssueFilter!, $first: Int!, $after: String) {
      issues(filter: $filter, first: $first, after: $after) {
        nodes { ${ISSUE_CORE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const issues = [];
    let after = null;
    while (issues.length < bounded) {
      const first = Math.min(50, bounded - issues.length);
      const data = await request(query, { filter, first, after });
      const connection = data?.issues;
      for (const issue of connection?.nodes ?? []) issues.push(normalizeIssue(issue));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return { issues, truncated: issues.length >= bounded };
  }

  async function listMyIssues({ state, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, LIST_PAGE_CAP));
    const filter = state
      ? { state: { name: { eqIgnoreCase: state } } }
      : { state: { type: { nin: ["completed", "canceled"] } } };
    const query = `query AiosLinearMyIssues($filter: IssueFilter!, $first: Int!, $after: String) {
      viewer {
        assignedIssues(filter: $filter, first: $first, after: $after) {
          nodes { ${ISSUE_CORE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    const issues = [];
    let after = null;
    while (issues.length < bounded) {
      const first = Math.min(50, bounded - issues.length);
      const data = await request(query, { filter, first, after });
      const connection = data?.viewer?.assignedIssues;
      for (const issue of connection?.nodes ?? []) issues.push(normalizeIssue(issue));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return { issues, truncated: issues.length >= bounded };
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
      // IssueFilter.labels is an IssueLabelCollectionFilter — the label-name comparator sits
      // directly on it (implicit "some"). Wrapping it in an extra `some: { … }` is the wrong
      // shape and returns nothing, so label-based lookups silently find zero issues.
      filter = { labels: { name: { eq: label } } };
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
    let truncated = false;
    for (let page = 0; page < Math.ceil(LIST_PAGE_CAP / 50); page++) {
      const data = await request(query, { filter, after });
      const conn = data?.issues;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) out.push(normalizeIssue(n));
      if (!conn?.pageInfo?.hasNextPage || out.length >= LIST_PAGE_CAP) {
        // Stopped at the cap while Linear still reported more pages → the caller is getting a
        // TRUNCATED view of the source, not the whole thing. Flag it (surfaced loudly below).
        truncated = Boolean(conn?.pageInfo?.hasNextPage) && out.length >= LIST_PAGE_CAP;
        break;
      }
      after = conn.pageInfo.endCursor;
    }
    // Non-fatal, but LOUD: silently dropping candidates past 200 would let a large backlog quietly
    // starve the ranking pool (e.g. roadmap-run never sees the 201st issue). Name the source + cap.
    if (truncated) {
      const sel = label
        ? `label '${label}'`
        : epicIdentifier
          ? `epic '${epicIdentifier}'`
          : `project '${project}'`;
      console.error(
        `warning: Linear ${sel} has more than ${LIST_PAGE_CAP} matching issues — results capped ` +
          `at ${LIST_PAGE_CAP}; issues beyond the cap are NOT considered.`
      );
    }
    return out;
  }

  async function createIssue({ title, description, parentIdentifier, state } = {}) {
    if (!title) throw new LinearError("createIssue requires a title.");
    if (!parentIdentifier) throw new LinearError("createIssue requires a parentIdentifier.");
    const parent = await resolveIssueMeta(parentIdentifier);
    if (!parent.teamId)
      throw new LinearError(`could not resolve team for parent ${parentIdentifier}.`);
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
    // Never retry a mutation — a lost response after an accepted write would duplicate the issue.
    const data = await request(query, { input }, { retryable: false });
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
    // Never retry a mutation — a lost response after an accepted write would duplicate the comment.
    const data = await request(query, { input: { issueId: meta.id, body } }, { retryable: false });
    if (!data?.commentCreate?.success) {
      throw new LinearError(`commentCreate failed for ${identifier}.`);
    }
    return { ok: true };
  }

  async function updateIssueDescription(identifier, description) {
    if (typeof description !== "string")
      throw new LinearError("updateIssueDescription requires a string description.");
    const meta = await resolveIssueMeta(identifier);
    const query = `mutation UpdateIssueDescription($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { identifier } }
    }`;
    // Never retry an external mutation. A lost response is ambiguous and must be reconciled by a
    // fresh read, not by issuing a second write.
    const data = await request(
      query,
      { id: meta.id, input: { description } },
      { retryable: false }
    );
    const result = data?.issueUpdate;
    if (!result?.success || result?.issue?.identifier !== identifier) {
      throw new LinearError(`issueUpdate returned an ambiguous result for ${identifier}.`);
    }
    return { ok: true, identifier };
  }

  async function createWorkspaceIssue({
    team,
    title,
    description = "",
    parent,
    state,
    assignee,
    priority,
    project,
    labels = [],
  } = {}) {
    if (!title) throw new LinearError("create requires --title.");
    let teamNode = team ? await resolveTeam(team) : null;
    let parentMeta = null;
    if (parent) {
      parentMeta = await resolveIssueMeta(parent);
      if (!teamNode) teamNode = { id: parentMeta.teamId, key: parentMeta.teamKey };
    }
    if (!teamNode?.id) throw new LinearError("create requires --team unless --parent supplies it.");
    const input = { teamId: teamNode.id, title, description };
    if (parentMeta) input.parentId = parentMeta.id;
    if (state) input.stateId = (await resolveWorkflowState(teamNode.id, state)).id;
    if (assignee !== undefined) input.assigneeId = (await resolveUser(assignee))?.id ?? null;
    if (priority !== undefined) input.priority = Number(priority);
    if (project) input.projectId = (await resolveProject(project)).id;
    if (labels.length) input.labelIds = await resolveLabels(labels);
    const query = `mutation AiosLinearCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier } }
    }`;
    const data = await request(query, { input }, { retryable: false });
    const identifier = data?.issueCreate?.issue?.identifier;
    if (!data?.issueCreate?.success || !identifier) {
      throw new LinearError("Linear returned an ambiguous issueCreate result.");
    }
    const issue = await getIssue(identifier, { full: true });
    if (!issue || issue.title !== title) {
      throw new LinearError(`created ${identifier}, but readback did not match the requested title.`);
    }
    return issue;
  }

  async function updateWorkspaceIssue(
    identifier,
    { title, description, state, assignee, priority, parent, project, labels } = {}
  ) {
    const meta = await resolveIssueMeta(identifier);
    const input = {};
    if (title !== undefined) input.title = title;
    if (description !== undefined) input.description = description;
    if (state !== undefined) input.stateId = (await resolveWorkflowState(meta.teamId, state)).id;
    if (assignee !== undefined) input.assigneeId = (await resolveUser(assignee))?.id ?? null;
    if (priority !== undefined) input.priority = Number(priority);
    if (parent !== undefined) input.parentId = parent ? (await resolveIssueMeta(parent)).id : null;
    if (project !== undefined) input.projectId = project ? (await resolveProject(project)).id : null;
    if (labels !== undefined) input.labelIds = await resolveLabels(labels);
    if (!Object.keys(input).length) throw new LinearError("update requires at least one field.");
    const query = `mutation AiosLinearUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { identifier } }
    }`;
    const data = await request(query, { id: meta.id, input }, { retryable: false });
    if (!data?.issueUpdate?.success || data?.issueUpdate?.issue?.identifier !== identifier) {
      throw new LinearError(`Linear returned an ambiguous issueUpdate result for ${identifier}.`);
    }
    const issue = await getIssue(identifier, { full: true });
    if (!issue) throw new LinearError(`updated ${identifier}, but readback could not find it.`);
    if (title !== undefined && issue.title !== title) {
      throw new LinearError(`updated ${identifier}, but title readback did not match.`);
    }
    if (state !== undefined && issue.state?.name?.toLowerCase() !== String(state).toLowerCase() &&
        issue.state?.type?.toLowerCase() !== String(state).toLowerCase()) {
      throw new LinearError(`updated ${identifier}, but state readback did not match '${state}'.`);
    }
    return issue;
  }

  async function addCommentVerified(identifier, body) {
    await addComment(identifier, body);
    const issue = await getIssue(identifier, { full: true });
    if (!issue?.comments?.some((comment) => comment.body === body)) {
      throw new LinearError(`comment mutation for ${identifier} could not be verified by readback.`);
    }
    return issue;
  }

  async function listRelations(identifier) {
    const issue = await getIssue(identifier, { full: true });
    if (!issue) throw new LinearError(`Linear issue not found: ${identifier}`);
    return [...issue.relations, ...issue.inverseRelations];
  }

  async function addRelation(identifier, relatedIdentifier, type) {
    const allowed = new Set(["blocks", "duplicate", "related"]);
    if (!allowed.has(type)) throw new LinearError("relation type must be blocks, duplicate, or related.");
    const issue = await resolveIssueMeta(identifier);
    const related = await resolveIssueMeta(relatedIdentifier);
    const query = `mutation AiosLinearRelationCreate($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success issueRelation { id type } }
    }`;
    const data = await request(
      query,
      { input: { issueId: issue.id, relatedIssueId: related.id, type } },
      { retryable: false }
    );
    const relationId = data?.issueRelationCreate?.issueRelation?.id;
    if (!data?.issueRelationCreate?.success || !relationId) {
      throw new LinearError(`Linear returned an ambiguous relation create result for ${identifier}.`);
    }
    const relations = await listRelations(identifier);
    if (!relations.some((relation) => relation.id === relationId)) {
      throw new LinearError(`created relation ${relationId}, but readback did not contain it.`);
    }
    return { id: relationId, relations };
  }

  async function removeRelation(identifier, relationId) {
    const before = await listRelations(identifier);
    if (!before.some((relation) => relation.id === relationId)) {
      throw new LinearError(`relation ${relationId} is not attached to ${identifier}.`);
    }
    const query = `mutation AiosLinearRelationDelete($id: String!) {
      issueRelationDelete(id: $id) { success }
    }`;
    const data = await request(query, { id: relationId }, { retryable: false });
    if (!data?.issueRelationDelete?.success) {
      throw new LinearError(`Linear returned an ambiguous relation delete result for ${relationId}.`);
    }
    const relations = await listRelations(identifier);
    if (relations.some((relation) => relation.id === relationId)) {
      throw new LinearError(`deleted relation ${relationId}, but readback still contains it.`);
    }
    return { ok: true, relations };
  }

  return {
    request,
    getIdentity,
    listTeams,
    listUsers,
    listWorkflowStates,
    getIssue,
    listIssues,
    listWorkspaceIssues,
    listMyIssues,
    createIssue,
    createWorkspaceIssue,
    addComment,
    addCommentVerified,
    updateIssueDescription,
    updateWorkspaceIssue,
    listRelations,
    addRelation,
    removeRelation,
  };
}
