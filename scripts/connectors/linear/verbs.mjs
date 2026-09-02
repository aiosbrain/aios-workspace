// AIOS team's canonical Linear verb implementations (Plane retired 2026-06-22). Terse
// output by design. This is the ONE provider implementation (AIO-1067): `aios linear <verb>`
// is the canonical route, and the `linear` compat bin plus the aios-linear skill delegates
// all route here through scripts/connectors/linear/index.mjs. Credential resolution happens
// in index.mjs BEFORE a verb runs; this module reads process.env.LINEAR_API_KEY only.
//
// Commands:
//   get <IDENT> [--full]      one issue (add --full for description + comments; url/priority/
//                             project/assignee/labels/parent/children too)
//   export-desc <IDENT> <file>
//                             write the exact UTF-8 issue description to a file
//   verify-desc <IDENT> <file>
//                             refetch description and compare CONTENT (not bytes) to a file
//   set-desc <IDENT> <file>   replace description from a file (markdown ok; --force to bypass
//                             the indented-table lint)
//   patch-desc <IDENT> <patch.md>
//                             SEARCH/REPLACE blocks on description only — partial update
//   set-title <IDENT> <title> replace the issue title
//   set-state <IDENT> <name>  move issue to a workflow state (name match, case-insensitive substring)
//   set-priority <IDENT> <priority>
//                             set priority: none, urgent, high, medium, low
//   comment <IDENT> <text>    add a comment
//   comments <IDENT>          read existing comments
//   list <TEAMKEY> [--open] [--label <name[,name]>]... [--missing-label <name-or-prefix>]...
//                             all issues for a team (e.g. AIO), id-sorted. --open drops
//                             Done/Canceled; repeated --label ANDs (comma inside one flag ORs);
//                             --missing-label keeps issues lacking any matching label prefix.
//                             With any filter: trailing {labels} column, `count: N` on stderr.
//                             Taxonomy queries: aios monorepo docs/finding-taxonomy.md
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
//   template [aios|finding]   print an issue scaffold (aios slice spec, or the
//                             post-merge finding shape — see docs/finding-taxonomy.md)
//   create "<title>" [--desc <file>] [--force] [--template aios] [--label <name>]... [--state <name>]
//          [--parent <IDENT>] [--assignee <name-or-email>]
//                             --label is repeatable; prints the Linear-generated git branch name;
//                             optionally prepends a configured origin block (see SKILL.md);
//                             --desc is ignored when --template is set; the description runs the
//                             same indented-table lint + post-write readback as set-desc
//                             (--force downgrades the lint to a warning)
//   users <TEAMKEY>           list assignable users
//   assign <IDENT> <name-or-email>
//   query ['<graphql>'] [--vars <json>]
//                             raw GraphQL passthrough; no query = your open assigned issues
//   activity pull [--repo PATH] [--tier admin|team|external] [--activity-path PATH] [--dry-run]
//                             assigned open issues → 1-inbox/comms/activity.jsonl (operator loop)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { applyDescriptionPatch, resolveLinearTemplate } from "./template.mjs";
import { confirmStored, describeContentDrift, lintDescription } from "./desc-guard.mjs";
import {
  findExactRelation,
  findIssue,
  findLabel,
  findTeamId,
  findUser,
  formatIssue,
  getRelations,
  gql,
  hasRelatedRelation,
  listTeamMembers,
  parsePriority,
  printFullIssue,
  relatedIssues,
  resolveProject,
} from "./core.mjs";
import { findWorkflowState, listIssueComments, listIssueLabels } from "./pagination.mjs";
import { cmdCreateProject, cmdProjects } from "./projects.mjs";
import { cmdList } from "./list.mjs";
import { cmdCreate } from "./create.mjs";

export function linearUsage() {
  return (
    "usage: aios linear get <IDENT> [--full] | export-desc <IDENT> <file> | verify-desc <IDENT> <file> | " +
    "set-desc <IDENT> <file> [--force] | patch-desc <IDENT> <patch.md> [--force] | " +
    "set-title <IDENT> <title> | " +
    "set-state <IDENT> <name> | set-priority <IDENT> <priority> | comment <IDENT> <text> | " +
    "comments <IDENT> | " +
    "list <TEAMKEY> [--open] [--label <name[,name]>]... [--missing-label <prefix>]... | " +
    "relations <IDENT> | blocks <BLOCKER> <BLOCKED> | " +
    "related <ISSUE_A> <ISSUE_B> | remove-relation <ISSUE_A> <ISSUE_B> <blocks|related> | " +
    "set-project <IDENT> <project> | projects [NAME] | " +
    'create-project "<name>" [--desc <file>] [--team KEY] | ' +
    "set-parent <IDENT> <PARENT_IDENT> | " +
    "add-label <IDENT> <LABEL> | template [aios|finding] | " +
    'create "<title>" [--desc <file>] [--force] [--template aios|finding] [--label <name>]... [--state Backlog] ' +
    "[--parent <IDENT>] [--assignee <name-or-email>] [--project <name>] [--priority <level>] | " +
    "users <TEAMKEY> | assign <IDENT> <name-or-email> | " +
    "query ['<graphql>'] [--vars <json>] | " +
    "activity pull [--repo PATH] [--tier admin|team|external] [--activity-path PATH] [--dry-run] | " +
    "status [--json]  (setup: aios connect linear · aios disconnect linear)"
  );
}

/**
 * Run one canonical Linear verb. Exit semantics are unchanged from the pre-AIO-1067 CLI:
 * verbs print their own diagnostics and process.exit(1) on provider/usage failures; a
 * completed verb returns 0.
 */
export async function runLinearVerb(argv, baseDir = process.cwd()) {
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
      console.error(
        "This is content loss, not reformatting. Check for a table indented under a list."
      );
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
    lintDescription(description, { force: argv.slice(3).includes("--force") });
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
    lintDescription(updated, { force: argv.slice(3).includes("--force") });
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
    const { state: st, states } = await findWorkflowState(key, arg);
    if (!st) {
      console.error(
        `state "${arg}" not found in team ${key}. states: ${states.map((s) => s.name).join(", ")}`
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
    const comments = await listIssueComments(n.id, n.identifier);
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!comments.length) console.log("(none)");
    for (const item of comments) {
      console.log(
        `--- ${item.id} ${item.createdAt} ${item.user?.name || "unknown"} ---\n${item.body}`
      );
    }
  } else if (cmd === "list") {
    await cmdList(argv);
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
    const project = await resolveProject(projectName);
    await gql(
      `mutation($id:String!,$pid:String!){ issueUpdate(id:$id, input:{ projectId:$pid }){ success } }`,
      { id: n.id, pid: project.id }
    );
    console.log(`${n.identifier} → project "${project.name}"`);
  } else if (cmd === "projects") {
    await cmdProjects(argv);
  } else if (cmd === "create-project") {
    await cmdCreateProject(argv);
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
    const currentLabels = await listIssueLabels(n.id, n.identifier);
    const labelIds = [...new Set([...currentLabels.map((item) => item.id), label.id])];
    await gql(
      `mutation($id:String!,$labels:[String!]!){ issueUpdate(id:$id, input:{ labelIds:$labels }){ success } }`,
      { id: n.id, labels: labelIds }
    );
    console.log(`${n.identifier} + label "${labelName}"`);
  } else if (cmd === "template") {
    const name = argv[1] || "aios";
    const body = resolveLinearTemplate(name, baseDir);
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
    await cmdCreate(argv.slice(1), baseDir);
  } else if (cmd === "query") {
    // Raw GraphQL passthrough (AIO-1072) — lazy: most sessions never need it.
    const { cmdQuery } = await import("./query.mjs");
    await cmdQuery(argv.slice(1));
  } else if (cmd === "activity") {
    // Operator-loop activity pull (AIO-1072) — lazy for the same reason.
    const { cmdActivity } = await import("./activity.mjs");
    await cmdActivity(argv.slice(1), baseDir);
  } else {
    console.log(linearUsage());
  }
  return 0;
}
