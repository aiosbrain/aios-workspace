// Project commands for the built-in Linear adapter (AIO-942), extracted to keep the
// dispatch file under the file-size gate. Dispatch stays in connectors/linear/index.mjs;
// the behaviour lives here.
import { readFileSync } from "node:fs";
import {
  canonicalizeProjectName,
  DEFAULT_TEAM_KEY,
  findProjects,
  findTeamId,
  gql,
} from "./core.mjs";

export async function cmdProjects(argv) {
  const projects = await findProjects(argv[1] || null);
  if (!projects.length) {
    console.log("no projects");
  } else {
    // status.name is the human-readable status ("Backlog", "In Progress"); Project.state
    // (the old flat string this printed) is deprecated upstream in favour of status.
    for (const p of projects) console.log(`${p.name}\t[${p.status?.name}]\t${p.url}`);
  }
}

export async function cmdCreateProject(argv) {
  const name = argv[1];
  if (!name) {
    console.error('create-project requires "<name>" [--desc <file>] [--team KEY]');
    process.exit(1);
  }
  const canonical = canonicalizeProjectName(name);
  if (!canonical) {
    console.error("create-project requires a name with at least one non-whitespace character");
    process.exit(1);
  }
  let descFile = null;
  let teamKey = DEFAULT_TEAM_KEY;
  for (let i = 2; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--desc" || option === "--team") {
      const value = argv[++i];
      if (!value) {
        console.error(`${option} requires a value`);
        process.exit(1);
      }
      if (option === "--desc") descFile = value;
      else teamKey = value;
    } else {
      console.error(`unknown create-project option "${option}"`);
      process.exit(1);
    }
  }
  // Fail closed on an existing name — Linear happily creates duplicates, and a duplicate
  // makes every later set-project call ambiguous. The comparison is canonical (NFKC,
  // collapsed Unicode whitespace, trimmed, case-folded) so a trailing space, an NBSP, an
  // NFD decomposition, or a case-only difference cannot smuggle a second project past this
  // guard. It is still an EQUALITY check, not a substring one: "Ultraharden v2" is a
  // legitimately distinct name and must remain creatable.
  //
  // Queried UNFILTERED: server-side containsIgnoreCase cannot see through an NBSP or an NFD
  // decomposition, so a canonical-equal project would be absent from a filtered result.
  const existing = (await findProjects()).filter(
    (p) => canonicalizeProjectName(p.name) === canonical
  );
  if (existing.length) {
    console.error(`project "${existing[0].name}" already exists: ${existing[0].url}`);
    process.exit(1);
  }
  const teamId = await findTeamId(teamKey);
  const input = { name, teamIds: [teamId] };
  if (descFile) input.description = readFileSync(descFile, "utf8");
  const d = await gql(
    `mutation($input:ProjectCreateInput!){ projectCreate(input:$input){ success project{ id name url } } }`,
    { input }
  );
  if (!d.projectCreate?.success) {
    console.error("projectCreate returned success=false");
    process.exit(1);
  }
  const pr = d.projectCreate.project;
  console.log(`created project "${pr.name}"\n${pr.url}`);
}
