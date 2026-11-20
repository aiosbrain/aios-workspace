// `create` command: argument parsing plus the guarded one-shot issueCreate write (AIO-1026).
// The description runs the SAME two guards as set-desc/patch-desc: lintDescription before
// any network traffic, confirmStored (bound to the returned identifier) after the write.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveLinearTemplate } from "./template.mjs";
import { confirmStored, lintDescription } from "./desc-guard.mjs";
import {
  DEFAULT_TEAM_KEY,
  fail,
  findIssue,
  findLabel,
  findTeamId,
  findTeamState,
  findUser,
  gql,
  paginate,
  parsePriority,
  resolveProject,
} from "./core.mjs";

export function parseCreateArgs(args, baseDir) {
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
  let team = null;
  let force = false;
  const setters = {
    "--desc": (value) => (descFile = value),
    "--template": (value) => (template = value),
    "--label": (value) => labels.push(value),
    "--state": (value) => (state = value),
    "--parent": (value) => (parent = value),
    "--assignee": (value) => (assignee = value),
    "--project": (value) => (project = value),
    "--priority": (value) => (priority = parsePriority(value)),
    "--team": (value) => (team = value.toUpperCase()),
  };
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (option === "--force") {
      // Boolean flag: downgrades the description lint (indented-table refusal) to a warning,
      // mirroring set-desc/patch-desc. It takes no value.
      force = true;
    } else if (Object.hasOwn(setters, option)) {
      const value = args[++index];
      // A following flag means the value was forgotten — consuming it would silently
      // swallow both this option's value and the next flag (e.g. `--desc --force` would
      // treat --force as the desc filename). Mirrors parseListArgs.
      if (!value || value.startsWith("--")) fail(`${option} requires a value`);
      setters[option](value);
    } else {
      fail(`unknown create option "${option}"`);
    }
  }
  let description = descFile ? readFileSync(descFile, "utf8") : "";
  if (template) {
    const body = resolveLinearTemplate(template, baseDir);
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
    team,
    force,
  };
}

// The team prefix of an issue identifier ("VIB-527" -> "VIB"). Linear identifiers are always
// TEAMKEY-<number>, so the parent's team is known without a network call.
export function teamKeyOfIdentifier(identifier) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(String(identifier || ""));
  return match ? match[1].toUpperCase() : null;
}

// Which team a new issue is created in. Order: explicit --team; the --parent's team; the
// --project's team when the project belongs to exactly one team; the configured default
// (AIOS_LINEAR_TEAM_KEY, else AIO). Every conflict fails BEFORE the mutation is sent:
// Linear rejects a parent or project from another team ("project not in same team as
// issue"), and a create that reaches issueCreate is never retried. `projectTeamKeys` is
// null when no --project was given.
function pickTeamKey({ team, parentKey, project, keys }, defaultTeamKey) {
  if (team) return team;
  if (parentKey) return parentKey;
  if (project && keys.length > 1) {
    fail(`project "${project}" belongs to several teams (${keys.join(", ")}); pass --team`);
  }
  if (project && keys.length === 1) return keys[0];
  return defaultTeamKey;
}

export function resolveCreateTeamKey(
  { team = null, parent = null, project = null, projectTeamKeys = null },
  defaultTeamKey = DEFAULT_TEAM_KEY
) {
  const parentKey = parent ? teamKeyOfIdentifier(parent) : null;
  if (parent && !parentKey) fail(`invalid --parent "${parent}": expected TEAMKEY-<number>`);
  if (team && parentKey && parentKey !== team) {
    fail(`--team ${team} conflicts with --parent ${parent} (team ${parentKey})`);
  }
  const keys = (projectTeamKeys || []).map((key) => key.toUpperCase());
  const chosen = pickTeamKey({ team, parentKey, project, keys }, defaultTeamKey);
  if (project && keys.length && !keys.includes(chosen)) {
    fail(`project "${project}" is not in team ${chosen} (its teams: ${keys.join(", ")})`);
  }
  return chosen;
}

// Paginated like the other connection lookups: a project in more teams than one page holds
// would otherwise reject a valid --team or parent team that sits on a later page.
async function findProjectTeamKeys(projectId) {
  const teams = await paginate(async (after) => {
    const data = await gql(
      `query($id:String!,$after:String){
        project(id:$id){ teams(first:250, after:$after){ nodes{ key } pageInfo{ hasNextPage endCursor } } }
      }`,
      { id: projectId, after }
    );
    return data?.project?.teams || { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }, "Linear project-team pagination stalled");
  return teams.map((node) => node.key);
}

// The issueCreate mutation is sent exactly once and never retried: a lost or malformed
// response does not prove the issue was not created, and a retry could file duplicates.
function reportUnconfirmedCreate(title, reason, teamKey = DEFAULT_TEAM_KEY) {
  console.error(`create FAILED: ${reason}`);
  console.error("  The issueCreate mutation was sent once and is NOT retried, but Linear");
  console.error("  may have created the issue anyway. Before re-running create, check:");
  console.error(`    aios linear list ${teamKey} --open   (look for "${title}")`);
  process.exit(1);
}

// The recovery commands must reference the body that was actually SENT — the origin block
// and a stamped --template are prepended/substituted after --desc is read, so pointing at
// the original --desc file would false-report drift (verify-desc) or overwrite the
// origin/template content (set-desc). Save the exact sent body and name that file.
// The body can be sensitive spec content, so it never lands world-readable in the shared
// tmpdir: mkdtemp gives an unpredictable owner-only (0700) directory, and the file itself
// is created exclusively (wx) with 0600.
function reportDescriptionNotConfirmed({ identifier, description, force, readbackError }) {
  const sentDir = mkdtempSync(path.join(tmpdir(), "linear-create-"));
  const sentFile = path.join(sentDir, `${identifier}-sent.md`);
  writeFileSync(sentFile, description, { encoding: "utf8", mode: 0o600, flag: "wx" });
  // The path is quoted in the printed commands so a TMPDIR containing spaces still
  // copy-pastes as one argv token.
  if (readbackError) {
    console.error(`readback FAILED for created issue ${identifier}: ${readbackError.message}`);
    console.error(`  ${identifier} EXISTS — do not re-run create.`);
    console.error(`  The exact description that was sent is saved at: ${sentFile}`);
    console.error("  Verify what Linear stored:");
    console.error(`    aios linear verify-desc ${identifier} "${sentFile}"`);
  } else {
    console.error(
      `${identifier} was created but its stored description drifted from what was sent.`
    );
    console.error(`  The exact description that was sent is saved at: ${sentFile}`);
    console.error("  Repair it, then rewrite the description:");
    console.error(`    aios linear set-desc ${identifier} "${sentFile}"${force ? " --force" : ""}`);
  }
  process.exit(1);
}

async function resolveCreateInput({
  title,
  description,
  labels,
  state,
  parent,
  assignee,
  project,
  priority,
  team,
}) {
  let projectId = null;
  let projectTeamKeys = null;
  if (project) {
    projectId = (await resolveProject(project)).id;
    projectTeamKeys = await findProjectTeamKeys(projectId);
  }
  const teamKey = resolveCreateTeamKey({ team, parent, project, projectTeamKeys });
  const teamId = await findTeamId(teamKey);
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
    const u = await findUser(teamKey, assignee);
    input.assigneeId = u.id;
  }
  if (projectId) input.projectId = projectId;
  if (priority !== null) input.priority = priority;
  return { input, teamKey };
}

export async function cmdCreate(args, baseDir) {
  const parsed = parseCreateArgs(args, baseDir);
  const { title, description, force } = parsed;
  // Same pre-write guard as set-desc/patch-desc (AIO-1026): refuse markdown Linear is known
  // to corrupt BEFORE any network traffic, so a rejected description means zero mutations.
  lintDescription(description, { force });
  const { input, teamKey } = await resolveCreateInput(parsed);
  let d;
  try {
    d = await gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier title url branchName } } }`,
      { input },
      { throwOnError: true }
    );
  } catch (error) {
    reportUnconfirmedCreate(title, error.message, teamKey);
  }
  // An HTTP-success payload with missing/null data (Linear or an intermediary accepting the
  // mutation but returning no result) makes gql return undefined — that is just as
  // unconfirmed as a lost response, and must never surface as a raw TypeError instead of
  // the duplicate-prevention warning.
  const i = d?.issueCreate?.issue;
  if (!d?.issueCreate?.success || !i)
    reportUnconfirmedCreate(
      title,
      "issueCreate returned no confirmation (missing or null data).",
      teamKey
    );
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
    if (readbackError || !storedOk) {
      reportDescriptionNotConfirmed({
        identifier: i.identifier,
        description,
        force,
        readbackError,
      });
    }
  }
}
