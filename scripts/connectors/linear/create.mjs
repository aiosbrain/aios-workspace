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
    force,
  };
}

// The issueCreate mutation is sent exactly once and never retried: a lost or malformed
// response does not prove the issue was not created, and a retry could file duplicates.
function reportUnconfirmedCreate(title, reason) {
  console.error(`create FAILED: ${reason}`);
  console.error("  The issueCreate mutation was sent once and is NOT retried, but Linear");
  console.error("  may have created the issue anyway. Before re-running create, check:");
  console.error(`    aios linear list ${DEFAULT_TEAM_KEY} --open   (look for "${title}")`);
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
}) {
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
  return input;
}

export async function cmdCreate(args, baseDir) {
  const parsed = parseCreateArgs(args, baseDir);
  const { title, description, force } = parsed;
  // Same pre-write guard as set-desc/patch-desc (AIO-1026): refuse markdown Linear is known
  // to corrupt BEFORE any network traffic, so a rejected description means zero mutations.
  lintDescription(description, { force });
  const input = await resolveCreateInput(parsed);
  let d;
  try {
    d = await gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier title url branchName } } }`,
      { input },
      { throwOnError: true }
    );
  } catch (error) {
    reportUnconfirmedCreate(title, error.message);
  }
  // An HTTP-success payload with missing/null data (Linear or an intermediary accepting the
  // mutation but returning no result) makes gql return undefined — that is just as
  // unconfirmed as a lost response, and must never surface as a raw TypeError instead of
  // the duplicate-prevention warning.
  const i = d?.issueCreate?.issue;
  if (!d?.issueCreate?.success || !i)
    reportUnconfirmedCreate(title, "issueCreate returned no confirmation (missing or null data).");
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
