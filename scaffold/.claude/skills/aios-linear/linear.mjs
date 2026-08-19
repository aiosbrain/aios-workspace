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
//                             refetch description and compare CONTENT (not bytes) to a file
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
//   remove-relation <ISSUE_A> <ISSUE_B> <blocks|related>
//                             remove exactly one relation; `blocks` is directional (A blocks B)
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
//                             optionally prepends a configured origin block (see SKILL.md);
//                             --desc is ignored when --template is set
//   users <TEAMKEY>           list assignable users
//   assign <IDENT> <name-or-email>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  applyDescriptionPatch,
  describeContentDrift,
  findIndentedTables,
  resolveLinearTemplate,
} from "./linear-template.mjs";
import {
  DEFAULT_TEAM_KEY,
  findExactRelation,
  findIssue,
  findLabel,
  findTeamId,
  findTeamState,
  findUser,
  formatIssue,
  getRelations,
  gql,
  hasRelatedRelation,
  listTeamIssues,
  listTeamMembers,
  parseCreateArgs,
  parsePriority,
  printFullIssue,
  relatedIssues,
} from "./linear-core.mjs";

const argv = process.argv.slice(2);
/**
 * Warn about markdown Linear is known to corrupt on write (AIO-942). A table indented
 * under a list item comes back with leading characters stripped from every cell after the
 * first column — silent content loss, so it is worth refusing to be quiet about.
 */
function lintDescription(md) {
  const indented = findIndentedTables(md);
  if (!indented.length) return;
  console.error(
    `warning: ${indented.length} indented table row(s) — Linear corrupts tables nested under a list item,`
  );
  console.error("         stripping leading characters from cells. Move the table to column 0.");
  for (const hit of indented.slice(0, 6)) console.error(`         line ${hit.line}: ${hit.text}`);
  if (indented.length > 6) console.error(`         ... ${indented.length - 6} more`);
}

/**
 * Re-read what Linear actually stored and compare it to what we sent, ignoring Linear's
 * cosmetic rewrites (yaml fence, emphasis re-bracketing, table delimiter restyling).
 * A byte-compare cannot do this — it fails on every write, which is why it stopped being
 * a usable gate. Returns true when the stored content matches.
 */
async function confirmStored(issue, sent) {
  const check = await gql(`query($id:String!){ issue(id:$id){ description } }`, { id: issue.id });
  const stored = check.issue.description || "";
  const drift = describeContentDrift(sent, stored);
  if (!drift) return true;
  console.error(`ERROR: ${issue.identifier} did not store what was sent - content differs.`);
  console.error(`  first divergence at normalised offset ${drift.at}`);
  console.error(`  sent  : ${JSON.stringify(drift.local)}`);
  console.error(`  stored: ${JSON.stringify(drift.remote)}`);
  console.error("  This is content loss, not reformatting. Check for a table indented under a list.");
  return false;
}

const cmd = argv[0];

if (cmd === "get") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  if (arg === "--full") {
    await printFullIssue(n.id);
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
    // A byte mismatch is the NORMAL case: Linear re-serialises every description it stores
    // (yaml fence, emphasis re-bracketing, table delimiters). Failing on that made this
    // command noise. Only real content drift is worth a non-zero exit — see AIO-942.
    const localText = local.toString("utf8");
    const remoteText = remote.toString("utf8");
    const drift = describeContentDrift(localText, remoteText);
    if (!drift) {
      console.log(
        `${n.identifier} content matches; stored bytes differ only by Linear's re-serialisation ` +
          `(remote=${remote.length} local=${local.length} sha256=${sha256})`
      );
      process.exit(0);
    }
    console.error(
      `${n.identifier} CONTENT DRIFT (remote=${remote.length} bytes local=${local.length} bytes sha256=${sha256})`
    );
    console.error(`first divergence at normalised offset ${drift.at}`);
    console.error(`  local : ${JSON.stringify(drift.local)}`);
    console.error(`  remote: ${JSON.stringify(drift.remote)}`);
    console.error("This is content loss, not reformatting. Check for a table indented under a list.");
    process.exit(1);
  }
  console.log(
    `${n.identifier} description byte-identical (${remote.length} bytes sha256=${sha256})`
  );
} else if (cmd === "set-desc") {
  const ident = argv[1];
  const arg = argv[2];
  if (!ident || !arg) {
    console.error("set-desc requires <IDENT> <file>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  const description = readFileSync(arg, "utf8");
  lintDescription(description);
  await gql(
    `mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{ description:$d }){ success } }`,
    { id: n.id, d: description }
  );
  const storedOk = await confirmStored(n, description);
  console.log(
    `updated ${n.identifier} (${description.length} chars)${storedOk ? "" : " - CONTENT DRIFT"}`
  );
  if (!storedOk) process.exit(1);
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
  await gql(
    `mutation($id:String!,$d:String!){ issueUpdate(id:$id, input:{ description:$d }){ success } }`,
    {
      id: n.id,
      d: updated,
    }
  );
  const patchedOk = await confirmStored(n, updated);
  console.log(
    `patched ${n.identifier} (${original.length} → ${updated.length} chars)${patchedOk ? "" : " - CONTENT DRIFT"}`
  );
  if (!patchedOk) process.exit(1);
} else if (cmd === "set-title") {
  const ident = argv[1];
  const title = argv[2];
  if (!ident || !title) {
    console.error("set-title requires <IDENT> <title>");
    process.exit(1);
  }
  const n = await findIssue(ident);
  await gql(
    `mutation($id:String!,$t:String!){ issueUpdate(id:$id, input:{ title:$t }){ success } }`,
    { id: n.id, t: title }
  );
  console.log(`renamed ${n.identifier} → ${title}`);
} else if (cmd === "set-state") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const key = String(n.identifier).split("-")[0];
  const d = await gql(
    `query($k:String!){ workflowStates(filter:{ team:{ key:{ eq:$k } } }){ nodes{ id name } } }`,
    { k: key }
  );
  const want = String(arg).toLowerCase();
  const st =
    d.workflowStates.nodes.find((s) => s.name.toLowerCase() === want) ||
    d.workflowStates.nodes.find((s) => s.name.toLowerCase().includes(want));
  if (!st) {
    console.error(
      `state "${arg}" not found in team ${key}. states: ${d.workflowStates.nodes.map((s) => s.name).join(", ")}`
    );
    process.exit(1);
  }
  await gql(
    `mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }`,
    { id: n.id, s: st.id }
  );
  console.log(`moved ${n.identifier} → ${st.name}`);
} else if (cmd === "set-priority") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  const priority = parsePriority(arg);
  await gql(
    `mutation($id:String!,$p:Int!){ issueUpdate(id:$id, input:{ priority:$p }){ success issue{ priorityLabel } } }`,
    { id: n.id, p: priority }
  );
  console.log(`set ${n.identifier} priority`);
} else if (cmd === "comment") {
  const ident = argv[1];
  const arg = argv[2];
  const n = await findIssue(ident);
  await gql(
    `mutation($id:String!,$b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`,
    { id: n.id, b: arg }
  );
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
    console.log(
      `--- ${item.id} ${item.createdAt} ${item.user?.name || "unknown"} ---\n${item.body}`
    );
  }
} else if (cmd === "list") {
  const ident = argv[1];
  const issues = await listTeamIssues(ident);
  for (const n of issues.sort((a, b) =>
    a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  )) {
    console.log(`${n.identifier}\t[${n.state?.name}]\t${n.title}`);
  }
} else if (cmd === "relations") {
  const ident = argv[1];
  const n = await findIssue(ident);
  const i = await getRelations(n.id);
  console.log(`${i.identifier} relations`);
  const outgoing = i.relations.nodes.filter((r) => r.type === "blocks");
  const incoming = i.inverseRelations.nodes.filter((r) => r.type === "blocks");
  const related = relatedIssues(i);
  if (!outgoing.length && !incoming.length && !related.length) {
    console.log("(none)");
  }
  for (const r of outgoing) {
    console.log(`blocks     ${formatIssue(r.relatedIssue)}`);
  }
  for (const r of incoming) {
    console.log(`blocked by ${formatIssue(r.issue)}`);
  }
  for (const issue of related) {
    console.log(`related    ${formatIssue(issue)}`);
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
  const duplicate = existing.relations.nodes.find(
    (r) => r.type === "blocks" && r.relatedIssue.identifier === blocked.identifier
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
  const duplicate = hasRelatedRelation(existing, a, b);
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
} else if (cmd === "remove-relation") {
  const aIdent = argv[1];
  const bIdent = argv[2];
  const type = argv[3];
  if (!aIdent || !bIdent || !["blocks", "related"].includes(type)) {
    console.error("remove-relation requires <ISSUE_A> <ISSUE_B> <blocks|related>");
    process.exit(1);
  }
  const a = await findIssue(aIdent);
  const b = await findIssue(bIdent);
  const relation = findExactRelation(await getRelations(a.id), a, b, type);
  if (!relation) {
    console.log(`${a.identifier} has no ${type} relation to ${b.identifier}`);
  } else {
    await gql(`mutation($id:String!){ issueRelationDelete(id:$id){ success } }`, {
      id: relation.id,
    });
    console.log(`removed ${type} relation: ${a.identifier} -> ${b.identifier}`);
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
    console.error(
      `ambiguous project match "${projectName}": ${projects.map((p) => p.name).join(", ")}`
    );
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
  const teamId = await findTeamId(String(n.identifier).split("-")[0]);
  const label = await findLabel(teamId, labelName);
  if (!label) {
    console.error(`label "${labelName}" not found`);
    process.exit(1);
  }
  const current = await gql(`query($id:String!){ issue(id:$id){ labels{ nodes{ id } } } }`, {
    id: n.id,
  });
  const labelIds = [...new Set([...current.issue.labels.nodes.map((item) => item.id), label.id])];
  await gql(
    `mutation($id:String!,$labels:[String!]!){ issueUpdate(id:$id, input:{ labelIds:$labels }){ success } }`,
    { id: n.id, labels: labelIds }
  );
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
  const members = await listTeamMembers(teamKey);
  for (const u of members) {
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
  const teamKey = String(n.identifier).split("-")[0];
  const u = await findUser(teamKey, query);
  if (!u) {
    console.error(`no member matching "${query}" found on team ${teamKey}`);
    process.exit(1);
  }
  await gql(
    `mutation($id:String!,$a:String!){ issueUpdate(id:$id, input:{ assigneeId:$a }){ success } }`,
    { id: n.id, a: u.id }
  );
  console.log(`assigned ${n.identifier} → ${u.name}`);
} else if (cmd === "create") {
  const { title, description, labels, state, parent, assignee } = parseCreateArgs(argv.slice(1));
  const teamId = await findTeamId(DEFAULT_TEAM_KEY);
  const st = await findTeamState(teamId, state);
  if (!st) {
    console.error(`state "${state}" not found`);
    process.exit(1);
  }
  const input = { teamId, title, description, stateId: st.id };
  if (parent) {
    const p = await findIssue(parent);
    if (p) input.parentId = p.id;
    else console.error(`warning: parent "${parent}" not found — creating without parent`);
  }
  if (labels.length) {
    const ids = [];
    for (const name of labels) {
      const lb = await findLabel(teamId, name);
      if (lb) ids.push(lb.id);
      else console.error(`warning: label "${name}" not found — skipping that label`);
    }
    if (ids.length) input.labelIds = ids;
  }
  if (assignee) {
    const u = await findUser(DEFAULT_TEAM_KEY, assignee);
    input.assigneeId = u.id;
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
      "related <ISSUE_A> <ISSUE_B> | remove-relation <ISSUE_A> <ISSUE_B> <blocks|related> | " +
      "set-project <IDENT> <project> | set-parent <IDENT> <PARENT_IDENT> | " +
      "add-label <IDENT> <LABEL> | template [aios] | " +
      'create "<title>" [--desc <file>] [--template aios] [--label <name>]... [--state Backlog] ' +
      "[--parent <IDENT>] [--assignee <name-or-email>] | users <TEAMKEY> | assign <IDENT> <name-or-email>"
  );
}
