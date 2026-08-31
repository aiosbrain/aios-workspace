// `create` command: argument parsing plus the guarded one-shot issueCreate write (AIO-1026).
// The description runs the SAME two guards as set-desc/patch-desc: lintDescription before
// any network traffic, confirmStored (bound to the returned identifier) after the write.
import { readFileSync } from "node:fs";

import { resolveLinearTemplate } from "./linear-template.mjs";
import { confirmStored, lintDescription } from "./linear-desc-guard.mjs";
import {
  DEFAULT_TEAM_KEY,
  fail,
  findIssue,
  findLabel,
  findTeamId,
  findTeamState,
  findUser,
  gql,
  parsePriority,
  resolveProject,
} from "./linear-core.mjs";

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
  let force = false;
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (option === "--force") {
      // Boolean flag: downgrades the description lint (indented-table refusal) to a warning,
      // mirroring set-desc/patch-desc. It takes no value.
      force = true;
    } else if (
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
  return {
    title,
    description,
    descFile,
    labels,
    state,
    parent,
    assignee,
    project,
    priority,
    force,
  };
}

export async function cmdCreate(args) {
  const {
    title,
    description,
    descFile,
    labels,
    state,
    parent,
    assignee,
    project,
    priority,
    force,
  } = parseCreateArgs(args);
  // Same pre-write guard as set-desc/patch-desc (AIO-1026): refuse markdown Linear is known
  // to corrupt BEFORE any network traffic, so a rejected description means zero mutations.
  lintDescription(description, { force });
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
  if (project) input.projectId = (await resolveProject(project)).id;
  if (priority !== null) input.priority = priority;
  // The create mutation is sent exactly ONCE and never retried: a lost response does not
  // prove the issue was not created, so a retry could file duplicates. On failure, say so.
  let d;
  try {
    d = await gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier title url branchName } } }`,
      { input },
      { throwOnError: true }
    );
  } catch (error) {
    console.error(`create FAILED: ${error.message}`);
    console.error(
      "  The issueCreate mutation was sent once and is NOT retried — the response was lost, so"
    );
    console.error("  Linear may have created the issue anyway. Before re-running create, check:");
    console.error(`    linear list ${DEFAULT_TEAM_KEY} --open   (look for "${title}")`);
    process.exit(1);
  }
  const i = d.issueCreate?.issue;
  if (!d.issueCreate?.success || !i) {
    console.error("create FAILED: issueCreate returned no issue.");
    console.error(
      "  The mutation was sent once and is NOT retried — the issue may still exist. Check:"
    );
    console.error(`    linear list ${DEFAULT_TEAM_KEY} --open   (look for "${title}")`);
    process.exit(1);
  }
  console.log(`created ${i.identifier}  ${i.title}\n${i.url}\nbranch: ${i.branchName}`);
  if (description) {
    // Post-write readback bound to the issue the mutation just returned, mirroring set-desc.
    let storedOk = false;
    let readbackError = null;
    try {
      storedOk = await confirmStored({ id: i.id, identifier: i.identifier }, description, {
        throwOnError: true,
      });
    } catch (error) {
      readbackError = error;
    }
    if (readbackError) {
      console.error(`readback FAILED for created issue ${i.identifier}: ${readbackError.message}`);
      console.error(`  ${i.identifier} EXISTS — do not re-run create. Verify what it stored:`);
      console.error(`    linear verify-desc ${i.identifier} ${descFile || "<description.md>"}`);
      process.exit(1);
    }
    if (!storedOk) {
      console.error(`${i.identifier} was created but its stored description drifted. Repair it:`);
      console.error(
        `    linear set-desc ${i.identifier} ${descFile || "<fixed-description.md>"}${force ? " --force" : ""}`
      );
      process.exit(1);
    }
  }
}
