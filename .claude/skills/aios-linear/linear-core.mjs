import { readFileSync } from "node:fs";

import { resolveLinearTemplate } from "./linear-template.mjs";

const API = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;

export const DEFAULT_TEAM_KEY = process.env.AIOS_LINEAR_TEAM_KEY || "AIO";

function fail(message) {
  console.error(message);
  process.exit(1);
}

export async function gql(query, variables) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    fail(
      "LINEAR_API_KEY not set — run via: node scripts/linear.mjs ... " +
        "(from a sibling repo: node <path-to-aios-workspace>/scripts/linear.mjs ...). " +
        "Do not dotenvx-run the whole toolkit .env; that decrypts unrelated secrets (AIO-790)."
    );
  }
  let response;
  try {
    response = await fetch(API, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`Linear request failed: ${error.message}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.errors) {
    fail(
      "Linear error: " +
        (payload?.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`)
    );
  }
  return payload.data;
}

export async function findIssue(identifier) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(identifier || ""));
  if (!match) fail(`invalid issue identifier "${identifier}" — expected TEAMKEY-<number>`);
  const data = await gql(
    `query($id:String!){ issue(id:$id){ id identifier title state{ name } } }`,
    { id: `${match[1].toUpperCase()}-${match[2]}` }
  );
  if (!data.issue) fail(`${identifier} not found`);
  return data.issue;
}

export async function printFullIssue(issueId) {
  const data = await gql(
    `query($id:String!){
      issue(id:$id){
        identifier title state{ name } priorityLabel url description createdAt updatedAt
        completedAt canceledAt project{ id name } labels{ nodes{ name } }
        parent{ identifier title } children(first:50){ nodes{ identifier title state{ name } } }
        comments(first:50){ nodes{ body user{ name } } }
      }
    }`,
    { id: issueId }
  );
  const issue = data.issue;
  const parent = issue.parent ? `${issue.parent.identifier} ${issue.parent.title}` : "(none)";
  const children = issue.children.nodes.length
    ? issue.children.nodes
        .map((child) => `${child.identifier} [${child.state?.name}] ${child.title}`)
        .join("\n")
    : "(none)";
  const parts = [
    `${issue.identifier}  ${issue.title}  [${issue.state?.name}]  priority=${issue.priorityLabel}`,
    issue.url,
    `created: ${issue.createdAt}`,
    `updated: ${issue.updatedAt}`,
    `completed: ${issue.completedAt || "(none)"}`,
    `canceled: ${issue.canceledAt || "(none)"}`,
    `project: ${issue.project?.name || "(none)"}`,
    `labels: ${issue.labels.nodes.map((label) => label.name).join(", ") || "(none)"}`,
    `parent: ${parent}`,
    `children:\n${children}`,
    "",
    issue.description || "(no description)",
  ];
  const comments = (issue.comments?.nodes ?? []).filter((comment) =>
    String(comment.body ?? "").trim()
  );
  if (comments.length) {
    parts.push("", "## Issue comments", "");
    for (const comment of comments) {
      parts.push(`### ${comment.user?.name ?? "comment"}`, "", String(comment.body).trim(), "");
    }
  }
  console.log(parts.join("\n"));
}

export async function listTeamIssues(teamKey) {
  if (!teamKey) fail("list requires <TEAMKEY>");
  const issues = [];
  let after = null;
  const seenCursors = new Set();
  do {
    const data = await gql(
      `query($k:String!,$after:String){
        issues(first:250, after:$after, filter:{ team:{ key:{ eq:$k } } }){
          nodes{ identifier title state{ name type } labels(first:250){ nodes{ name } } }
          pageInfo{ hasNextPage endCursor }
        }
      }`,
      { k: teamKey, after }
    );
    issues.push(...data.issues.nodes);
    const page = data.issues.pageInfo;
    if (!page.hasNextPage) break;
    if (!page.endCursor || seenCursors.has(page.endCursor)) {
      fail(`Linear issue pagination stalled for team ${teamKey}`);
    }
    seenCursors.add(page.endCursor);
    after = page.endCursor;
  } while (true);
  return issues;
}

/* ── list filtering (AIO-999) — label taxonomy queries; vocabulary: aios docs/finding-taxonomy.md ── */

// Linear workflow-state types that count as "open" for --open.
const OPEN_STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started"]);

export function parseListArgs(args) {
  const teamKey = args[0];
  const filters = { open: false, labels: [], missingLabels: [] };
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (option === "--open") {
      filters.open = true;
    } else if (option === "--label" || option === "--missing-label") {
      const value = args[++index];
      // A following flag means the value was forgotten — consuming it would silently
      // drop both the filter and the next flag and return zero-surprise rows.
      if (!value || value.startsWith("--")) fail(`${option} requires a value`);
      if (option === "--label") {
        // Repeated --label flags AND; commas inside one flag OR.
        const group = value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (!group.length) fail(`--label "${value}" contains no label names`);
        // --label matches exact names; --missing-label matches prefixes. A prefix-shaped
        // value here would match nothing and silently return zero rows.
        const prefixShaped = group.find((name) => name.endsWith(":"));
        if (prefixShaped) {
          fail(
            `--label matches exact label names and "${prefixShaped}" looks like a prefix — ` +
              `did you mean --missing-label ${prefixShaped}?`
          );
        }
        filters.labels.push(group);
      } else {
        filters.missingLabels.push(value);
      }
    } else {
      fail(`unknown list option "${option}"`);
    }
  }
  return { teamKey, filters };
}

export function hasListFilters(filters) {
  return filters.open || filters.labels.length > 0 || filters.missingLabels.length > 0;
}

export function filterIssues(issues, filters) {
  return issues.filter((issue) => {
    if (filters.open && !OPEN_STATE_TYPES.has(issue.state?.type)) return false;
    const names = (issue.labels?.nodes ?? []).map((label) => label.name.toLowerCase());
    for (const group of filters.labels) {
      if (!group.some((want) => names.includes(want.toLowerCase()))) return false;
    }
    if (filters.missingLabels.length) {
      // Keep issues missing at least one of the listed names/prefixes (needs-triage semantics).
      const missingSome = filters.missingLabels.some(
        (prefix) => !names.some((name) => name.startsWith(prefix.toLowerCase()))
      );
      if (!missingSome) return false;
    }
    return true;
  });
}

export function parseCreateArgs(args) {
  const title = args[0];
  if (!title) fail("create requires a title");
  let descFile = null;
  let template = null;
  const labels = [];
  let state = "Backlog";
  let parent = null;
  let assignee = null;
  let project = null;
  let priority = null;
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (
      [
        "--desc",
        "--template",
        "--label",
        "--state",
        "--parent",
        "--assignee",
        "--project",
        "--priority",
      ].includes(option)
    ) {
      const value = args[++index];
      if (!value) fail(`${option} requires a value`);
      if (option === "--desc") descFile = value;
      else if (option === "--template") template = value;
      else if (option === "--label") labels.push(value);
      else if (option === "--state") state = value;
      else if (option === "--parent") parent = value;
      else if (option === "--project") project = value;
      else if (option === "--priority") priority = parsePriority(value);
      else assignee = value;
    } else {
      fail(`unknown create option "${option}"`);
    }
  }
  let description = descFile ? readFileSync(descFile, "utf8") : "";
  if (template) {
    const body = resolveLinearTemplate(template);
    if (!body) fail(`unknown template "${template}"`);
    // Function replacement: a literal-string second argument would expand `$&`/`$$`
    // sequences in the title and corrupt the stamped heading.
    description = body.replace(/^# TITLE — .*$/m, () => `# ${title}`);
    if (descFile) console.error("warning: --desc ignored when --template is set");
  }
  const originLabel = process.env.AIOS_LINEAR_ORIGIN_LABEL;
  if (originLabel && labels.includes(originLabel) && !description.startsWith("**Origin:**")) {
    const origin = process.env.AIOS_LINEAR_ORIGIN_TEXT;
    if (!origin)
      fail("AIOS_LINEAR_ORIGIN_TEXT must be set when the configured origin label is used");
    description = `**Origin:** ${origin}\n\n${description}`;
  }
  return { title, description, labels, state, parent, assignee, project, priority };
}

export async function findTeamId(teamKey = DEFAULT_TEAM_KEY) {
  const data = await gql(`query($key:String!){ team(id:$key){ id } }`, { key: teamKey });
  if (!data.team) fail(`team "${teamKey}" not found`);
  return data.team.id;
}

export async function findLabel(teamId, name) {
  const data = await gql(`query($id:String!){ team(id:$id){ labels{ nodes{ id name } } } }`, {
    id: teamId,
  });
  const want = String(name).toLowerCase();
  return (
    data.team.labels.nodes.find((label) => label.name.toLowerCase() === want) ||
    data.team.labels.nodes.find((label) => label.name.toLowerCase().includes(want))
  );
}

export async function findTeamState(teamId, name) {
  const data = await gql(`query($id:String!){ team(id:$id){ states{ nodes{ id name } } } }`, {
    id: teamId,
  });
  const want = String(name).toLowerCase();
  return (
    data.team.states.nodes.find((state) => state.name.toLowerCase() === want) ||
    data.team.states.nodes.find((state) => state.name.toLowerCase().includes(want))
  );
}

export async function listTeamMembers(teamKey) {
  const members = [];
  let after = null;
  do {
    const data = await gql(
      `query($key:String!,$after:String){
        team(id:$key){
          members(first:250, after:$after){
            nodes{ id name displayName email active }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`,
      { key: teamKey, after }
    );
    if (!data.team) fail(`team "${teamKey}" not found`);
    const page = data.team.members;
    members.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) {
      fail(`Linear member pagination stalled for team ${teamKey}`);
    }
    after = page.pageInfo.endCursor;
  } while (true);
  return members;
}

export async function findUser(teamKey, query) {
  const members = await listTeamMembers(teamKey);
  const want = String(query).toLowerCase();
  const exact = members.filter((member) =>
    [member.email, member.name, member.displayName].some((value) => value?.toLowerCase() === want)
  );
  if (exact.length === 1) return exact[0];
  const partial = members.filter((member) =>
    [member.email, member.name, member.displayName].some((value) =>
      value?.toLowerCase().includes(want)
    )
  );
  const candidates = (exact.length ? exact : partial)
    .slice(0, 10)
    .map((member) => `${member.name} <${member.email}>`)
    .join(", ");
  const reason = exact.length > 1 ? "ambiguous exact match" : "no unique exact match";
  fail(
    `${reason} for member "${query}" on team ${teamKey}${candidates ? `; candidates: ${candidates}` : ""}`
  );
}

export async function getRelations(issueId) {
  const relations = [];
  const inverseRelations = [];
  let relationsAfter = null;
  let inverseAfter = null;
  let relationsOpen = true;
  let inverseOpen = true;
  let identifier;
  while (relationsOpen || inverseOpen) {
    const data = await gql(
      `query($id:String!,$relationsAfter:String,$inverseAfter:String){
      issue(id:$id){
        identifier
        relations(first:250,after:$relationsAfter){ nodes{ id type issue{ id identifier title state{ name } } relatedIssue{ id identifier title state{ name } } } pageInfo{ hasNextPage endCursor } }
        inverseRelations(first:250,after:$inverseAfter){ nodes{ id type issue{ id identifier title state{ name } } relatedIssue{ id identifier title state{ name } } } pageInfo{ hasNextPage endCursor } }
      }
    }`,
      { id: issueId, relationsAfter, inverseAfter }
    );
    identifier = data.issue.identifier;
    for (const [page, nodes, isOpen, cursor] of [
      [data.issue.relations, relations, relationsOpen, relationsAfter],
      [data.issue.inverseRelations, inverseRelations, inverseOpen, inverseAfter],
    ]) {
      if (!isOpen) continue;
      nodes.push(...page.nodes);
      if (
        page.pageInfo.hasNextPage &&
        (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)
      )
        fail(`Linear relation pagination stalled for ${identifier}`);
    }
    relationsOpen = relationsOpen && data.issue.relations.pageInfo.hasNextPage;
    inverseOpen = inverseOpen && data.issue.inverseRelations.pageInfo.hasNextPage;
    if (relationsOpen) relationsAfter = data.issue.relations.pageInfo.endCursor;
    if (inverseOpen) inverseAfter = data.issue.inverseRelations.pageInfo.endCursor;
  }
  return {
    identifier,
    relations: { nodes: relations },
    inverseRelations: { nodes: inverseRelations },
  };
}

export function relatedIssues(relations) {
  const issues = [
    ...relations.relations.nodes
      .filter((relation) => relation.type === "related")
      .map((relation) => relation.relatedIssue),
    ...relations.inverseRelations.nodes
      .filter((relation) => relation.type === "related")
      .map((relation) => relation.issue),
  ];
  return issues.filter(
    (issue, index) => issues.findIndex((candidate) => candidate.id === issue.id) === index
  );
}

export function hasRelatedRelation(relations, a, b) {
  return [...relations.relations.nodes, ...relations.inverseRelations.nodes].some(
    (relation) =>
      relation.type === "related" &&
      ((relation.issue?.id === a.id && relation.relatedIssue?.id === b.id) ||
        (relation.issue?.id === b.id && relation.relatedIssue?.id === a.id))
  );
}

export function findExactRelation(relations, a, b, type) {
  const unique = [...relations.relations.nodes, ...relations.inverseRelations.nodes].filter(
    (relation, index, all) => all.findIndex((candidate) => candidate.id === relation.id) === index
  );
  return unique.find((relation) => {
    if (relation.type !== type) return false;
    const forward = relation.issue?.id === a.id && relation.relatedIssue?.id === b.id;
    if (type === "blocks") return forward;
    return forward || (relation.issue?.id === b.id && relation.relatedIssue?.id === a.id);
  });
}

export function formatIssue(issue) {
  return `${issue.identifier} [${issue.state?.name}] ${issue.title}`;
}

// Project names are compared after canonicalization so that two names a human reads as
// identical cannot both exist. Server-side filtering cannot be trusted to see through an
// NBSP or an NFD decomposition, so the full set is paginated and canonicalized locally.
export function canonicalizeProjectName(name) {
  return (
    String(name)
      .normalize("NFKC")
      // every Unicode space separator (incl. NBSP) collapses to a single ASCII space
      .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/gu, " ")
      .trim()
      .toLowerCase()
  );
}

// Paginated: a project on page two must not be invisible to the duplicate guard or to
// ambiguity detection. Mirrors the seen-cursor guard in listTeamIssues — remembering only
// the previous cursor would loop forever on an A→B→A cycle.
export async function findProjects(nameSubstring = null) {
  const filter = nameSubstring ? { name: { containsIgnoreCase: nameSubstring } } : {};
  const projects = [];
  const seenCursors = new Set();
  let after = null;
  do {
    const d = await gql(
      `query($f:ProjectFilter,$after:String){
        projects(first:100, filter:$f, after:$after){
          nodes{ id name state url }
          pageInfo{ hasNextPage endCursor }
        }
      }`,
      { f: filter, after }
    );
    const page = d.projects;
    projects.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    if (!page.pageInfo.endCursor || seenCursors.has(page.pageInfo.endCursor)) {
      fail("Linear project pagination stalled");
    }
    seenCursors.add(page.pageInfo.endCursor);
    after = page.pageInfo.endCursor;
  } while (true);
  return projects;
}

// Resolve a project by name. The comparison is CANONICAL over the full unfiltered set:
// server-side containsIgnoreCase cannot see through an NBSP or an NFD decomposition, so a
// raw server filter would both miss an NBSP-typed exact name and let two canonical-equal
// projects slip past the ambiguity guard one at a time. Exact canonical equality wins;
// otherwise a canonical substring match. Fails closed on zero or ambiguous matches so a
// typo can never silently file into the wrong project.
export async function resolveProject(nameSubstring) {
  const want = canonicalizeProjectName(nameSubstring);
  // A whitespace-only query would substring-match every project; fail closed instead.
  if (!want) fail(`no project matching "${nameSubstring}"`);
  const all = await findProjects();
  const exact = all.filter((p) => canonicalizeProjectName(p.name) === want);
  const matches = exact.length
    ? exact
    : all.filter((p) => canonicalizeProjectName(p.name).includes(want));
  if (matches.length === 0) fail(`no project matching "${nameSubstring}"`);
  if (matches.length > 1) {
    fail(`ambiguous project match "${nameSubstring}": ${matches.map((p) => p.name).join(", ")}`);
  }
  return matches[0];
}

export function parsePriority(value) {
  const priorities = { none: 0, no: 0, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 };
  const key = String(value || "").toLowerCase();
  if (Object.hasOwn(priorities, key)) return priorities[key];
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 4) return numeric;
  fail("priority must be one of: none, urgent, high, medium, low");
}
