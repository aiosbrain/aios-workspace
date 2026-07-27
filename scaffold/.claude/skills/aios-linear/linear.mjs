#!/usr/bin/env node
// AIOS Linear board CLI — Linear-only (Plane retired 2026-06-22). Terse output by design.
// Run so LINEAR_API_KEY is in env (dotenvx-encrypted workspace .env):
//   dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs <cmd> ...
//
// Commands:
//   get <IDENT> [--full]      one issue (add --full for description + url)
//   set-desc <IDENT> <file>   replace description from a file (markdown ok)
//   set-state <IDENT> <name>  move issue to a workflow state (name match, case-insensitive substring)
//   set-priority <IDENT> <priority>
//                             set priority: none, urgent, high, medium, low
//   comment <IDENT> <text>    add a comment
//   list <TEAMKEY>            all issues for a team (e.g. AIO), id-sorted
//   relations <IDENT>         show blocks / blocked-by relationships
//   blocks <BLOCKER> <BLOCKED>
//                             mark one issue as blocking another
//   create "<title>" [--desc <file>] [--template aios] [--label <name>] [--state <name>]
//   template [aios]                  print issue scaffold
//   patch-desc <IDENT> <patch.md>    SEARCH/REPLACE blocks on description only
import { readFileSync } from "node:fs";
import { applyDescriptionPatch, resolveLinearTemplate } from "./linear-template.mjs";

const ORIGIN_BLOCK = "**Origin:** Chetan design deck — https://www.fluora.ai/aios\n\n";
const AIO_TEAM_ID = "7beef22a-34c2-426a-9b0c-db584870a098";

const KEY = process.env.LINEAR_API_KEY;
if (!KEY) {
  console.error("LINEAR_API_KEY not set — run via: dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs ...");
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
  let label = null;
  let state = "Backlog";
  let parent = null;
  let template = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--desc" && args[i + 1]) { descFile = args[++i]; continue; }
    if (args[i] === "--template" && args[i + 1]) { template = args[++i]; continue; }
    if (args[i] === "--label" && args[i + 1]) { label = args[++i]; continue; }
    if (args[i] === "--state" && args[i + 1]) { state = args[++i]; continue; }
    if (args[i] === "--parent" && args[i + 1]) { parent = args[++i]; continue; }
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
  if (label === "chetan-deck" && !description.startsWith("**Origin:**")) {
    description = ORIGIN_BLOCK + description;
  }
  return { title, description, label, state, parent };
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
          identifier title state{ name } url description
          comments(first:50){ nodes{ body user{ name } } }
        }
      }`,
      { id: n.id }
    );
    const i = d.issue;
    const parts = [`${i.identifier}  ${i.title}  [${i.state?.name}]`, i.url, "", i.description || "(no description)"];
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
} else if (cmd === "set-desc") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const description = readFileSync(arg, "utf8");
  await gql(`mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{ description:$d }){ success } }`, { id: n.id, d: description });
  console.log(`updated ${n.identifier} (${description.length} chars)`);
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
  if (!outgoing.length && !incoming.length) {
    console.log("(none)");
  }
  for (const r of outgoing) {
    console.log(`blocks     ${formatIssue(r.relatedIssue)}`);
  }
  for (const r of incoming) {
    console.log(`blocked by ${formatIssue(r.issue)}`);
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
  const d = await gql(
    `query($k:String!){ team(id:$k){ members(first:100){ nodes{ id name displayName email } } } }`,
    { k: teamKey }
  );
  const want = query.toLowerCase();
  const u = d.team.members.nodes.find(
    (m) =>
      m.email?.toLowerCase() === want ||
      m.name?.toLowerCase() === want ||
      m.displayName?.toLowerCase() === want ||
      m.name?.toLowerCase().includes(want) ||
      m.displayName?.toLowerCase().includes(want)
  );
  if (!u) {
    console.error(`no member matching "${query}" found on team ${teamKey}`);
    process.exit(1);
  }
  await gql(`mutation($id:String!,$a:String!){ issueUpdate(id:$id, input:{ assigneeId:$a }){ success } }`, { id: n.id, a: u.id });
  console.log(`assigned ${n.identifier} → ${u.name}`);
} else if (cmd === "template") {
  const name = argv[1] || "aios";
  const body = resolveLinearTemplate(name);
  if (!body) {
    console.error(`template "${name}" not found`);
    process.exit(1);
  }
  process.stdout.write(body);
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
} else if (cmd === "create") {
  const { title, description, label, state, parent } = parseCreateArgs(argv.slice(1));
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
  if (label) {
    const lb = await findLabel(AIO_TEAM_ID, label);
    if (lb) input.labelIds = [lb.id];
    else console.error(`warning: label "${label}" not found — creating without label`);
  }
  const d = await gql(
    `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier title url } } }`,
    { input }
  );
  const i = d.issueCreate.issue;
  console.log(`created ${i.identifier}  ${i.title}\n${i.url}`);
} else {
  console.log("usage: linear.mjs get <IDENT> [--full] | set-desc <IDENT> <file> | patch-desc <IDENT> <patch.md> | set-state <IDENT> <name> | set-priority <IDENT> <priority> | comment <IDENT> <text> | list <TEAMKEY> | relations <IDENT> | blocks <BLOCKER> <BLOCKED> | template [aios] | create \"<title>\" [--desc <file>] [--template aios] [--label chetan-deck] [--state Backlog] [--parent <IDENT>] | users <TEAMKEY> | assign <IDENT> <name-or-email>");
}
