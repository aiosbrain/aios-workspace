#!/usr/bin/env node
// AIOS team's canonical Linear board CLI (Plane retired 2026-06-22). Terse output by design.
// Canonical source: aios-workspace `.claude/skills/aios-linear/` (also vendored into every
// scaffolded AIOS workspace at `.claude/skills/aios-linear/` via `aios update`).
// Run so LINEAR_API_KEY is in env — dotenvx-encrypted, canonically aios-workspace's own .env:
//   dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs <cmd> ...
// From a sibling repo that doesn't carry the key itself, point -f at the aios-workspace
// checkout's .env instead, e.g.:
//   dotenvx run --quiet -f ../aios-workspace/.env -- node ../aios-workspace/.claude/skills/aios-linear/linear.mjs <cmd> ...
//
// Commands:
//   get <IDENT> [--full]      one issue (add --full for description + comments; url/priority/
//                             project/labels/parent/children too)
//   export-desc <IDENT> <file>
//                             write the exact UTF-8 issue description to a file
//   verify-desc <IDENT> <file>
//                             refetch description and byte-compare it to a UTF-8 file
//   set-desc <IDENT> <file>   replace description from a file (markdown ok)
//   patch-desc <IDENT> <patch.md>
//                             SEARCH/REPLACE blocks on description only — partial update
//   set-title <IDENT> <title> replace the issue title
//   set-state <IDENT> <name>  move issue to a workflow state (name match, case-insensitive substring)
//   set-priority <IDENT> <priority>
//                             set priority: none, urgent, high, medium, low
//   comment <IDENT> <text>    add a comment
//   comments <IDENT>          read existing comments
//   list <TEAMKEY>            all issues for a team (e.g. AIO), id-sorted
//   relations <IDENT>         show blocks / blocked-by / related relationships
//   blocks <BLOCKER> <BLOCKED>
//                             mark one issue as blocking another
//   related <ISSUE_A> <ISSUE_B>
//                             mark two issues as related (non-blocking cross-reference)
//   set-project <IDENT> <project-name-substring>
//                             move issue to a project (name match, case-insensitive substring)
//   set-parent <IDENT> <PARENT_IDENT>
//                             move issue under another parent issue
//   add-label <IDENT> <LABEL>
//                             add a team label without removing existing labels
//   template [aios]           print the pick-up-able issue scaffold
//   create "<title>" [--desc <file>] [--template aios] [--label <name>]... [--state <name>]
//          [--parent <IDENT>] [--assignee <name-or-email>]
//                             --label is repeatable; prints the Linear-generated git branch name;
//                             prepends deck-origin block when --label chetan-deck;
//                             --desc is ignored when --template is set
//   users <TEAMKEY>           list assignable users
//   assign <IDENT> <name-or-email>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyDescriptionPatch, resolveLinearTemplate } from "./linear-template.mjs";

const ORIGIN_BLOCK = "**Origin:** Chetan design deck — https://www.fluora.ai/aios\n\n";
const AIO_TEAM_ID = "7beef22a-34c2-426a-9b0c-db584870a098";

const KEY = process.env.LINEAR_API_KEY;
if (!KEY) {
  console.error(
    "LINEAR_API_KEY not set — run via: dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs ... " +
      "(or -f <path-to-aios-workspace>/.env from a sibling repo)"
  );
  process.exit(1);
}
const API = "https://api.linear.app/graphql";

async function gql(query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.errors) {
    console.error("Linear error:", j?.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`);
    process.exit(1);
  }
  return j.data;
}

// Resolve a human identifier (AIO-75) → {id, identifier, title, state} via a team-scoped lookup.
async function findIssue(ident) {
  const key = String(ident).split("-")[0];
  const d = await gql(
    `query($k:String!){ issues(first:250, filter:{ team:{ key:{ eq:$k } } }){ nodes{ id identifier title state{ name } } } }`,
    { k: key }
  );
  const n = d.issues.nodes.find((x) => x.identifier === ident);
  if (!n) {
    console.error(`${ident} not found in team ${key}`);
    process.exit(1);
  }
  return n;
}

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseCreateArgs(args) {
  const title = args[0];
  if (!title) {
    console.error("create requires a title");
    process.exit(1);
  }
  let descFile = null;
  let template = null;
  const labels = []; // --label is repeatable
  let state = "Backlog";
  let parent = null;
  let assignee = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--desc" && args[i + 1]) { descFile = args[++i]; continue; }
    if (args[i] === "--template" && args[i + 1]) { template = args[++i]; continue; }
    if (args[i] === "--label" && args[i + 1]) { labels.push(args[++i]); continue; }
    if (args[i] === "--state" && args[i + 1]) { state = args[++i]; continue; }
    if (args[i] === "--parent" && args[i + 1]) { parent = args[++i]; continue; }
    if (args[i] === "--assignee" && args[i + 1]) { assignee = args[++i]; continue; }
  }
  let description = descFile ? readFileSync(descFile, "utf8") : "";
  if (template) {
    const body = resolveLinearTemplate(template);
    if (!body) {
      console.error(`unknown template "${template}"`);
      process.exit(1);
    }
    description = body.replace(/^# TITLE — outcome-oriented slice name/m, `# ${title}`);
    if (descFile) {
      console.error("warning: --desc ignored when --template is set");
    }
  }
  if (labels.includes("chetan-deck") && !description.startsWith("**Origin:**")) {
    description = ORIGIN_BLOCK + description;
  }
  return { title, description, labels, state, parent, assignee };
}

async function findLabel(teamId, name) {
  const d = await gql(
    `query($id:String!){ team(id:$id){ labels{ nodes{ id name } } } }`,
    { id: teamId }
  );
  const want = String(name).toLowerCase();
  return d.team.labels.nodes.find((l) => l.name.toLowerCase() === want)
    || d.team.labels.nodes.find((l) => l.name.toLowerCase().includes(want));
}

async function findTeamState(teamId, name) {
  const d = await gql(
    `query($id:String!){ team(id:$id){ states{ nodes{ id name } } } }`,
    { id: teamId }
  );
  const want = String(name).toLowerCase();
  return d.team.states.nodes.find((s) => s.name.toLowerCase() === want)
    || d.team.states.nodes.find((s) => s.name.toLowerCase().includes(want));
}

async function findUser(teamKey, query) {
  const d = await gql(
    `query($k:String!){ team(id:$k){ members(first:100){ nodes{ id name displayName email } } } }`,
    { k: teamKey }
  );
  const want = query.toLowerCase();
  return d.team.members.nodes.find(
    (m) =>
      m.email?.toLowerCase() === want ||
      m.name?.toLowerCase() === want ||
      m.displayName?.toLowerCase() === want ||
      m.name?.toLowerCase().includes(want) ||
      m.displayName?.toLowerCase().includes(want)
  );
}

async function getRelations(issueId) {
  const d = await gql(
    `query($id:String!){
      issue(id:$id){
        identifier
        relations(first:50){
          nodes{
            id
            type
            issue{ identifier title state{ name } }
            relatedIssue{ identifier title state{ name } }
          }
        }
        inverseRelations(first:50){
          nodes{
            id
            type
            issue{ identifier title state{ name } }
            relatedIssue{ identifier title state{ name } }
          }
        }
      }
    }`,
    { id: issueId }
  );
  return d.issue;
}

function formatIssue(i) {
  return `${i.identifier} [${i.state?.name}] ${i.title}`;
}

function parsePriority(value) {
  const priorities = {
    none: 0,
    no: 0,
    urgent: 1,
    high: 2,
    medium: 3,
    normal: 3,
    low: 4,
  };
  const key = String(value || "").toLowerCase();
  if (key in priorities) return priorities[key];
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 4) return numeric;
  console.error("priority must be one of: none, urgent, high, medium, low");
  process.exit(1);
}

if (cmd === "get") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  if (arg === "--full") {
    const d = await gql(
      `query($id:String!){
        issue(id:$id){
          identifier title state{ name } priorityLabel url description createdAt updatedAt
          completedAt canceledAt project{ id name } labels{ nodes{ name } }
          parent{ identifier title } children(first:50){ nodes{ identifier title state{ name } } }
          comments(first:50){ nodes{ body user{ name } } }
        }
      }`,
      { id: n.id }
    );
    const i = d.issue;
    const parent = i.parent ? `${i.parent.identifier} ${i.parent.title}` : "(none)";
    const children = i.children.nodes.length
      ? i.children.nodes.map((child) => `${child.identifier} [${child.state?.name}] ${child.title}`).join("\n")
      : "(none)";
    const parts = [
      `${i.identifier}  ${i.title}  [${i.state?.name}]  priority=${i.priorityLabel}`,
      i.url,
      `created: ${i.createdAt}`,
      `updated: ${i.updatedAt}`,
      `completed: ${i.completedAt || "(none)"}`,
      `canceled: ${i.canceledAt || "(none)"}`,
      `project: ${i.project?.name || "(none)"}`,
      `labels: ${i.labels.nodes.map((label) => label.name).join(", ") || "(none)"}`,
      `parent: ${parent}`,
      `children:\n${children}`,
      "",
      i.description || "(no description)",
    ];
    const comments = (i.comments?.nodes ?? []).filter((cm) => String(cm.body ?? "").trim());
    if (comments.length) {
      parts.push("", "## Issue comments", "");
      for (const cm of comments) {
        const who = cm.user?.name ?? "comment";
        parts.push(`### ${who}`, "", String(cm.body).trim(), "");
      }
    }
    console.log(parts.join("\n"));
  } else {
    console.log(`${n.identifier}  ${n.title}  [${n.state?.name}]  id=${n.id}`);
  }
} else if (cmd === "export-desc") {
  const ident = argv[1];
  const arg = argv[2];
  if (!ident || !arg) {
    console.error("export-desc requires <IDENT> <file>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const d = await gql(`query($id:String!){ issue(id:$id){ description } }`, { id: n.id });
  const description = d.issue.description || "";
  writeFileSync(arg, description, "utf8");
  const bytes = Buffer.byteLength(description, "utf8");
  const sha256 = createHash("sha256").update(description, "utf8").digest("hex");
  console.log(`exported ${n.identifier} (${bytes} bytes sha256=${sha256})`);
} else if (cmd === "verify-desc") {
  const ident = argv[1];
  const arg = argv[2];
  if (!ident || !arg) {
    console.error("verify-desc requires <IDENT> <file>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const d = await gql(`query($id:String!){ issue(id:$id){ description } }`, { id: n.id });
  const remote = Buffer.from(d.issue.description || "", "utf8");
  const local = readFileSync(arg);
  const sha256 = createHash("sha256").update(remote).digest("hex");
  if (!remote.equals(local)) {
    let first = 0;
    while (first < remote.length && first < local.length && remote[first] === local[first]) first++;
    const start = Math.max(0, first - 60);
    const end = first + 120;
    console.error(`${n.identifier} description mismatch (remote=${remote.length} bytes local=${local.length} bytes sha256=${sha256})`);
    console.error(`first mismatch byte ${first}; remote=${JSON.stringify(remote.subarray(start, end).toString("utf8"))}`);
    console.error(`first mismatch byte ${first}; local=${JSON.stringify(local.subarray(start, end).toString("utf8"))}`);
    process.exit(1);
  }
  console.log(`${n.identifier} description byte-identical (${remote.length} bytes sha256=${sha256})`);
} else if (cmd === "set-desc") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const description = readFileSync(arg, "utf8");
  await gql(`mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{ description:$d }){ success } }`, { id: n.id, d: description });
  console.log(`updated ${n.identifier} (${description.length} chars)`);
} else if (cmd === "patch-desc") {
  const ident = argv[1];
  const patchFile = argv[2];
  if (!ident || !patchFile) {
    console.error("patch-desc requires <IDENT> <patch.md>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const d = await gql(`query($id:String!){ issue(id:$id){ description } }`, { id: n.id });
  const original = d.issue.description || "";
  const patchText = readFileSync(patchFile, "utf8");
  let updated;
  try {
    updated = applyDescriptionPatch(original, patchText);
  } catch (e) {
    console.error(`patch failed: ${e.message}`);
    process.exit(1);
  }
  await gql(`mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{ description:$d }){ success } }`, {
    id: n.id,
    d: updated,
  });
  console.log(`patched ${n.identifier} (${original.length} → ${updated.length} chars)`);
} else if (cmd === "set-title") {
  const ident = argv[1];
  const title = argv[2];
  if (!ident || !title) {
    console.error("set-title requires <IDENT> <title>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  await gql(`mutation($id:String!,$t:String!){ issueUpdate(id:$id, input:{ title:$t }){ success } }`, { id: n.id, t: title });
  console.log(`renamed ${n.identifier} → ${title}`);
} else if (cmd === "set-state") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const key = String(ident).split("-")[0];
  const d = await gql(`query($k:String!){ workflowStates(filter:{ team:{ key:{ eq:$k } } }){ nodes{ id name } } }`, { k: key });
  const want = String(arg).toLowerCase();
  const st = d.workflowStates.nodes.find((s) => s.name.toLowerCase() === want)
    || d.workflowStates.nodes.find((s) => s.name.toLowerCase().includes(want));
  if (!st) {
    console.error(`state "${arg}" not found in team ${key}. states: ${d.workflowStates.nodes.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  await gql(`mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }`, { id: n.id, s: st.id });
  console.log(`moved ${n.identifier} → ${st.name}`);
} else if (cmd === "set-priority") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const priority = parsePriority(arg);
  await gql(`mutation($id:String!,$p:Int!){ issueUpdate(id:$id, input:{ priority:$p }){ success issue{ priorityLabel } } }`, { id: n.id, p: priority });
  console.log(`set ${n.identifier} priority`);
} else if (cmd === "comment") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  await gql(`mutation($id:String!,$b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`, { id: n.id, b: arg });
  console.log(`commented ${n.identifier}`);
} else if (cmd === "comments") {
  const ident = argv[1];
  const n = await findIssue(ident);
  const d = await gql(
    `query($id:String!){ issue(id:$id){ comments(first:50){ nodes{ id body createdAt updatedAt user{ name } } } } }`,
    { id: n.id }
  );
  const comments = d.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!comments.length) console.log("(none)");
  for (const item of comments) {
    console.log(`--- ${item.id} ${item.createdAt} ${item.user?.name || "unknown"} ---\n${item.body}`);
  }
} else if (cmd === "list") {
  const ident = argv[1];
  const d = await gql(`query($k:String!){ issues(first:250, filter:{ team:{ key:{ eq:$k } } }){ nodes{ identifier title state{ name } } } }`, { k: ident });
  for (const n of d.issues.nodes.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
    console.log(`${n.identifier}\t[${n.state?.name}]\t${n.title}`);
  }
} else if (cmd === "relations") {
  const ident = argv[1];
  const n = await findIssue(ident);
  const i = await getRelations(n.id);
  console.log(`${i.identifier} relations`);
  const outgoing = i.relations.nodes.filter((r) => r.type === "blocks");
  const incoming = i.inverseRelations.nodes.filter((r) => r.type === "blocks");
  const related = i.relations.nodes.filter((r) => r.type === "related");
  if (!outgoing.length && !incoming.length && !related.length) {
    console.log("(none)");
  }
  for (const r of outgoing) {
    console.log(`blocks     ${formatIssue(r.relatedIssue)}`);
  }
  for (const r of incoming) {
    console.log(`blocked by ${formatIssue(r.issue)}`);
  }
  for (const r of related) {
    console.log(`related    ${formatIssue(r.relatedIssue)}`);
  }
} else if (cmd === "blocks") {
  const blockerIdent = argv[1];
  const blockedIdent = argv[2];
  if (!blockerIdent || !blockedIdent) {
    console.error("blocks requires <BLOCKER> <BLOCKED>");
    process.exit(1);
  }
  const blocker = await findIssue(blockerIdent);
  const blocked = await findIssue(blockedIdent);
  const existing = await getRelations(blocker.id);
  const duplicate = existing.relations.nodes.find((r) =>
    r.type === "blocks" && r.relatedIssue.identifier === blocked.identifier
  );
  if (duplicate) {
    console.log(`${blocker.identifier} already blocks ${blocked.identifier}`);
  } else {
    await gql(
      `mutation($input:IssueRelationCreateInput!){
        issueRelationCreate(input:$input){ success issueRelation{ id } }
      }`,
      { input: { type: "blocks", issueId: blocker.id, relatedIssueId: blocked.id } }
    );
    console.log(`${blocker.identifier} now blocks ${blocked.identifier}`);
  }
} else if (cmd === "related") {
  const aIdent = argv[1];
  const bIdent = argv[2];
  if (!aIdent || !bIdent) {
    console.error("related requires <ISSUE_A> <ISSUE_B>");
    process.exit(1);
  }
  const a = await findIssue(aIdent);
  const b = await findIssue(bIdent);
  const existing = await getRelations(a.id);
  const duplicate = existing.relations.nodes.find((r) =>
    r.type === "related" && r.relatedIssue.identifier === b.identifier
  );
  if (duplicate) {
    console.log(`${a.identifier} already related to ${b.identifier}`);
  } else {
    await gql(
      `mutation($input:IssueRelationCreateInput!){
        issueRelationCreate(input:$input){ success issueRelation{ id } }
      }`,
      { input: { type: "related", issueId: a.id, relatedIssueId: b.id } }
    );
    console.log(`${a.identifier} now related to ${b.identifier}`);
  }
} else if (cmd === "set-project") {
  const ident = argv[1];
  const projectName = argv[2];
  if (!ident || !projectName) {
    console.error("set-project requires <IDENT> <project-name-substring>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const pd = await gql(
    `query($f:ProjectFilter){ projects(first:50, filter:$f){ nodes{ id name } } }`,
    { f: { name: { containsIgnoreCase: projectName } } }
  );
  const projects = pd.projects.nodes;
  if (projects.length === 0) {
    console.error(`no project matching "${projectName}"`);
    process.exit(1);
  }
  if (projects.length > 1) {
    console.error(`ambiguous project match "${projectName}": ${projects.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  await gql(
    `mutation($id:String!,$pid:String!){ issueUpdate(id:$id, input:{ projectId:$pid }){ success } }`,
    { id: n.id, pid: projects[0].id }
  );
  console.log(`${n.identifier} → project "${projects[0].name}"`);
} else if (cmd === "set-parent") {
  const ident = argv[1];
  const parentIdent = argv[2];
  if (!ident || !parentIdent) {
    console.error("set-parent requires <IDENT> <PARENT_IDENT>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const parent = await findIssue(parentIdent);
  await gql(
    `mutation($id:String!,$pid:String!){ issueUpdate(id:$id, input:{ parentId:$pid }){ success } }`,
    { id: n.id, pid: parent.id }
  );
  console.log(`${n.identifier} → parent ${parent.identifier}`);
} else if (cmd === "add-label") {
  const ident = argv[1];
  const labelName = argv[2];
  if (!ident || !labelName) {
    console.error("add-label requires <IDENT> <LABEL>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const label = await findLabel(AIO_TEAM_ID, labelName);
  if (!label) {
    console.error(`label "${labelName}" not found`);
    process.exit(1);
  }
  const current = await gql(`query($id:String!){ issue(id:$id){ labels{ nodes{ id } } } }`, { id: n.id });
  const labelIds = [...new Set([...current.issue.labels.nodes.map((item) => item.id), label.id])];
  await gql(`mutation($id:String!,$labels:[String!]!){ issueUpdate(id:$id, input:{ labelIds:$labels }){ success } }`, { id: n.id, labels: labelIds });
  console.log(`${n.identifier} + label "${labelName}"`);
} else if (cmd === "template") {
  const name = argv[1] || "aios";
  const body = resolveLinearTemplate(name);
  if (!body) {
    console.error(`template "${name}" not found`);
    process.exit(1);
  }
  process.stdout.write(body);
} else if (cmd === "users") {
  const teamKey = argv[1] || "AIO";
  const d = await gql(
    `query($k:String!){ team(id:$k){ members(first:100){ nodes{ id name displayName email active } } } }`,
    { k: teamKey }
  );
  for (const u of d.team.members.nodes) {
    console.log(`${u.name}\t${u.email}\t${u.active ? "active" : "inactive"}\tid=${u.id}`);
  }
} else if (cmd === "assign") {
  const ident = argv[1];
  const query = argv[2];
  if (!ident || !query) {
    console.error("assign requires <IDENT> <name-or-email>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const teamKey = String(ident).split("-")[0];
  const u = await findUser(teamKey, query);
  if (!u) {
    console.error(`no member matching "${query}" found on team ${teamKey}`);
    process.exit(1);
  }
  await gql(`mutation($id:String!,$a:String!){ issueUpdate(id:$id, input:{ assigneeId:$a }){ success } }`, { id: n.id, a: u.id });
  console.log(`assigned ${n.identifier} → ${u.name}`);
} else if (cmd === "create") {
  const { title, description, labels, state, parent, assignee } = parseCreateArgs(argv.slice(1));
  const st = await findTeamState(AIO_TEAM_ID, state);
  if (!st) {
    console.error(`state "${state}" not found`);
    process.exit(1);
  }
  const input = { teamId: AIO_TEAM_ID, title, description, stateId: st.id };
  if (parent) {
    const p = await findIssue(parent);
    if (p) input.parentId = p.id;
    else console.error(`warning: parent "${parent}" not found — creating without parent`);
  }
  if (labels.length) {
    const ids = [];
    for (const name of labels) {
      const lb = await findLabel(AIO_TEAM_ID, name);
      if (lb) ids.push(lb.id);
      else console.error(`warning: label "${name}" not found — skipping that label`);
    }
    if (ids.length) input.labelIds = ids;
  }
  if (assignee) {
    const u = await findUser(AIO_TEAM_ID, assignee);
    if (u) input.assigneeId = u.id;
    else console.error(`warning: assignee "${assignee}" not found — creating unassigned`);
  }
  const d = await gql(
    `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier title url branchName } } }`,
    { input }
  );
  const i = d.issueCreate.issue;
  console.log(`created ${i.identifier}  ${i.title}\n${i.url}\nbranch: ${i.branchName}`);
} else {
  console.log(
    "usage: linear.mjs get <IDENT> [--full] | export-desc <IDENT> <file> | verify-desc <IDENT> <file> | " +
      "set-desc <IDENT> <file> | patch-desc <IDENT> <patch.md> | set-title <IDENT> <title> | " +
      "set-state <IDENT> <name> | set-priority <IDENT> <priority> | comment <IDENT> <text> | " +
      "comments <IDENT> | list <TEAMKEY> | relations <IDENT> | blocks <BLOCKER> <BLOCKED> | " +
      "related <ISSUE_A> <ISSUE_B> | set-project <IDENT> <project> | set-parent <IDENT> <PARENT_IDENT> | " +
      "add-label <IDENT> <LABEL> | template [aios] | " +
      "create \"<title>\" [--desc <file>] [--template aios] [--label <name>]... [--state Backlog] " +
      "[--parent <IDENT>] [--assignee <name-or-email>] | users <TEAMKEY> | assign <IDENT> <name-or-email>"
  );
}
