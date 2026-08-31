// test/linear-desc-roundtrip.test.mjs — description round-trip integrity (AIO-942)
//
// Linear re-serialises every description it stores. Most of that is cosmetic; one case is
// not. A markdown table INDENTED under a list item comes back with leading characters
// stripped from every cell after the first column — silent content loss, observed on
// VIB-348 on 2026-08-19. These tests pin the real payload from that incident.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  describeContentDrift,
  findIndentedTables,
  normalizeForCompare,
} from "../scaffold/.claude/skills/aios-linear/linear-template.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scaffold/.claude/skills/aios-linear/linear.mjs");

function runDescriptionCli(args, cwd, { initialDescription = "", postWriteDescription } = {}) {
  const supportDir = mkdtempSync(path.join(tmpdir(), "linear-desc-roundtrip-"));
  const preload = path.join(supportDir, "mock-fetch.mjs");
  const mutationLog = path.join(supportDir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
let stored = process.env.INITIAL_DESCRIPTION || "";
let mutationCount = 0;
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("issue(id:$id){ id identifier")) {
    data = { issue: { id: "issue-1", identifier: "AIO-1", title: "test", state: { name: "Backlog" } } };
  } else if (query.includes("issueUpdate")) {
    stored = variables.d;
    mutationCount++;
    appendFileSync(process.env.MUTATION_LOG, "issueUpdate\\n");
    data = { issueUpdate: { success: true } };
  } else if (query.includes("issue(id:$id){ description }")) {
    data = {
      issue: {
        description:
          mutationCount > 0 && process.env.POST_WRITE_DESCRIPTION !== undefined
            ? process.env.POST_WRITE_DESCRIPTION
            : stored,
      },
    };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), { status: 200 });
};
`,
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LINEAR_API_KEY: "offline-test",
      MUTATION_LOG: mutationLog,
      INITIAL_DESCRIPTION: initialDescription,
      ...(postWriteDescription === undefined
        ? {}
        : { POST_WRITE_DESCRIPTION: postWriteDescription }),
    },
  });
  const mutations = readFileSync(mutationLog, { encoding: "utf8", flag: "a+" });
  rmSync(supportDir, { recursive: true, force: true });
  return { ...result, mutations };
}

// Mock for the `create` write path (AIO-1026): team + state lookups, ONE issueCreate
// mutation (logged, optionally with a lost response), and the post-create readback.
function runCreateCli(args, cwd, { postWriteDescription, loseCreateResponse = false } = {}) {
  const supportDir = mkdtempSync(path.join(tmpdir(), "linear-create-guard-"));
  const preload = path.join(supportDir, "mock-fetch.mjs");
  const mutationLog = path.join(supportDir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
let stored = "";
let created = false;
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("team(id:$key){ id }")) {
    data = { team: { id: "team-1" } };
  } else if (query.includes("states(first:250")) {
    data = { team: { states: {
      nodes: [{ id: "state-1", name: "Backlog" }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } };
  } else if (query.includes("issueCreate")) {
    appendFileSync(process.env.MUTATION_LOG, "issueCreate\\n");
    if (process.env.LOSE_CREATE_RESPONSE) throw new Error("socket hang up");
    stored = variables.input.description || "";
    created = true;
    data = { issueCreate: { success: true, issue: {
      id: "issue-9", identifier: "AIO-9", title: variables.input.title,
      url: "https://linear.app/x/AIO-9", branchName: "aio-9"
    } } };
  } else if (query.includes("issue(id:$id){ description }")) {
    data = { issue: { description:
      created && process.env.POST_WRITE_DESCRIPTION !== undefined
        ? process.env.POST_WRITE_DESCRIPTION
        : stored } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), { status: 200 });
};
`,
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LINEAR_API_KEY: "offline-test",
      MUTATION_LOG: mutationLog,
      AIOS_LINEAR_TEAM_KEY: "",
      AIOS_LINEAR_ORIGIN_LABEL: "",
      ...(loseCreateResponse ? { LOSE_CREATE_RESPONSE: "1" } : {}),
      ...(postWriteDescription === undefined
        ? {}
        : { POST_WRITE_DESCRIPTION: postWriteDescription }),
    },
  });
  const mutations = readFileSync(mutationLog, { encoding: "utf8", flag: "a+" });
  rmSync(supportDir, { recursive: true, force: true });
  return { ...result, mutations };
}

// The exact markdown sent to VIB-348, and the exact markdown Linear stored.
const SENT = [
  "3. **Reconcile the outcome encoding.**",
  "",
  "   | Slice | file | `dead-end` |",
  "   |---|---|---|",
  "   | I2 (#8) | `components/experiments/outcome-marker.tsx:24` | `CircleX` / `text-red` |",
  "   | I3 (#9) | `experiments-index.tsx` | plain text, no icon or colour |",
].join("\n");

const STORED = [
  "3. **Reconcile the outcome encoding.**",
  "",
  "   | Slice | file | `dead-end` |",
  "   | -- | -- | -- |",
  "   | (#8) | mponents/experiments/outcome-marker.tsx:24` | rcleX`/`text-red` |",
  "   | (#9) | periments-index.tsx` | in text, no icon or colour |",
].join("\n");

test("the VIB-348 corruption is detected as content drift", () => {
  const drift = describeContentDrift(SENT, STORED);
  assert.ok(drift, "must not report the mangled table as equivalent");
  // The divergence is the dropped row label, not somewhere incidental.
  assert.match(drift.local, /I2 \(#8\)/);
  assert.doesNotMatch(drift.remote, /I2 \(#8\)/);
});

test("a byte-compare cannot tell that corruption from routine reformatting", () => {
  // Both differ byte-wise from what was sent; only one is real loss. This is why
  // verify-desc's byte-compare stopped being an actionable gate.
  assert.notEqual(SENT, STORED);
  assert.notEqual("**not `x` icon**", "**not** `x` **icon**");
  assert.equal(describeContentDrift("**not `x` icon**", "**not** `x` **icon**"), null);
});

test("Linear's cosmetic rewrites are not reported as drift", () => {
  // emphasis re-bracketed around inline code
  assert.equal(
    describeContentDrift("**There is no `x` icon.**", "**There is no** `x` **icon.**"),
    null
  );
  // yaml frontmatter rewritten to a fence
  assert.equal(
    describeContentDrift(
      "---\neval_tier: full\n---\n\n# T",
      "```yaml\neval_tier: full\n```\n\n# T"
    ),
    null
  );
  // table delimiter row restyled
  assert.equal(
    describeContentDrift("| a | b |\n|---|---|\n| 1 | 2 |", "| a | b |\n| -- | -- |\n| 1 | 2 |"),
    null
  );
  // re-indentation and re-wrapping
  assert.equal(describeContentDrift("a\n  b\n\n\nc", "a\nb\nc"), null);
});

test("genuine content loss is still reported", () => {
  assert.ok(describeContentDrift("neutral, never red, never an X", "neutral, never red, never an"));
  assert.ok(describeContentDrift("| CircleSlash | neutral |", "| rcleSlash | neutral |"));
});

test("normalization never hides globstar loss", () => {
  assert.ok(describeContentDrift("Build src/**/*.mjs", "Build src//.mjs"));
});

test("normalization retains identifiers, globs, code stars, and math", () => {
  const literals = "foo_bar_baz src/**/*.mjs **/*.ts `a*b` 2 * 3";
  assert.equal(normalizeForCompare(literals), literals);
});

test("normalization preserves whitespace inside code", () => {
  assert.ok(describeContentDrift("Use `a  b`", "Use `a b`"));
  assert.ok(describeContentDrift("```txt\na  b\n```", "```txt\na b\n```"));
});

test("normalization preserves table delimiter structure", () => {
  assert.ok(describeContentDrift("|---|---|---|", "|---|---|"));
  assert.ok(describeContentDrift("not a table\n--- | ---", "not a table\n-- | --"));
});

test("Linear's bullet marker rewrite is cosmetic", () => {
  assert.equal(describeContentDrift("- first\n  - nested", "* first\n  * nested"), null);
});

test("findIndentedTables flags the shape Linear corrupts", () => {
  const hits = findIndentedTables(SENT);
  assert.equal(hits.length, 4, "every indented table row is reported");
  assert.equal(hits[0].line, 3);
  assert.match(hits[0].text, /\| Slice \| file \|/);
});

test("findIndentedTables ignores tables that are safe", () => {
  // column-0 tables round-trip fine and must not be flagged
  assert.deepEqual(findIndentedTables("| a | b |\n|---|---|\n| 1 | 2 |"), []);
  // a fenced example of the bug is documentation, not the bug
  assert.deepEqual(findIndentedTables("```\n   | a | b |\n   |---|---|\n```"), []);
  assert.deepEqual(findIndentedTables("~~~md\n   | a | b |\n~~~"), []);
  // prose and indented bullets are unaffected
  assert.deepEqual(findIndentedTables("- a bullet\n  - nested\n\ntext | with a pipe"), []);
});

test("findIndentedTables requires an actual delimiter row", () => {
  assert.deepEqual(findIndentedTables("  | note |\n  | another pipe-delimited prose line |"), []);
});

test("findIndentedTables catches nested tables without outer pipes", () => {
  const table = [
    "1. nested table",
    "",
    "   Slice | file",
    "   --- | ---",
    "   I2 | components/x.tsx",
  ].join("\n");
  assert.deepEqual(
    findIndentedTables(table).map(({ line }) => line),
    [3, 4, 5]
  );
});

test("findIndentedTables catches tables indented inside blockquotes", () => {
  const table = [
    "> 1. nested table",
    ">",
    ">    | Slice | file |",
    ">    |---|---|",
    ">    | I2 | components/x.tsx |",
  ].join("\n");
  assert.deepEqual(
    findIndentedTables(table).map(({ line }) => line),
    [3, 4, 5]
  );
});

test("findIndentedTables ignores escaped and code-span pipes", () => {
  assert.deepEqual(findIndentedTables("  `a|b`\n  --- | ---"), []);
  assert.deepEqual(findIndentedTables("  a \\| b\n  --- | ---"), []);
});

test("findIndentedTables honors fenced-code closing rules", () => {
  const example = ["````md", "```", "   | a | b |", "   |---|---|", "   | 1 | 2 |", "````"].join(
    "\n"
  );
  assert.deepEqual(findIndentedTables(example), []);
});

test("blockquote-looking content cannot close a top-level fence", () => {
  const example = ["```md", "> ```", "   | a | b |", "   |---|---|", "   | 1 | 2 |", "```"].join(
    "\n"
  );
  assert.deepEqual(findIndentedTables(example), []);
});

test("a file named --force is not mistaken for the lint override", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-desc-force-file-"));
  writeFileSync(path.join(cwd, "--force"), SENT, "utf8");
  const result = runDescriptionCli(["set-desc", "AIO-1", "--force"], cwd);
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "");
});

test("set-desc honors --force after the filename", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-desc-force-option-"));
  writeFileSync(path.join(cwd, "description.md"), SENT, "utf8");
  const result = runDescriptionCli(["set-desc", "AIO-1", "description.md", "--force"], cwd);
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.equal(result.mutations, "issueUpdate\n");
});

test("patch-desc does not mistake a patch named --force for the override", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-patch-force-file-"));
  const patch = `<<<<<<< SEARCH\nbefore\n=======\n${SENT}\n>>>>>>> REPLACE`;
  writeFileSync(path.join(cwd, "--force"), patch, "utf8");
  const result = runDescriptionCli(["patch-desc", "AIO-1", "--force"], cwd, {
    initialDescription: "before",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "");
});

test("patch-desc honors --force after the patch filename", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-patch-force-option-"));
  const patch = `<<<<<<< SEARCH\nbefore\n=======\n${SENT}\n>>>>>>> REPLACE`;
  writeFileSync(path.join(cwd, "patch.md"), patch, "utf8");
  const result = runDescriptionCli(["patch-desc", "AIO-1", "patch.md", "--force"], cwd, {
    initialDescription: "before",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.equal(result.mutations, "issueUpdate\n");
});

test("set-desc reports that post-write drift needs repair", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-desc-post-write-drift-"));
  writeFileSync(path.join(cwd, "description.md"), "CircleSlash", "utf8");
  const result = runDescriptionCli(["set-desc", "AIO-1", "description.md"], cwd, {
    postWriteDescription: "rcleSlash",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "issueUpdate\n");
  assert.match(result.stderr, /write already completed/i);
});

test("verify-desc passes cosmetic Linear reformatting", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-verify-cosmetic-"));
  writeFileSync(path.join(cwd, "description.md"), "**not `x` icon**", "utf8");
  const result = runDescriptionCli(["verify-desc", "AIO-1", "description.md"], cwd, {
    initialDescription: "**not** `x` **icon**",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.equal(result.mutations, "");
});

test("verify-desc fails genuine content loss", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-verify-drift-"));
  writeFileSync(path.join(cwd, "description.md"), "CircleSlash", "utf8");
  const result = runDescriptionCli(["verify-desc", "AIO-1", "description.md"], cwd, {
    initialDescription: "rcleSlash",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "");
});

test("the corruption eats identifiers, which is why the lint blocks rather than warns", () => {
  // What Linear strips is the START of each cell — in a spec that is the file path and the
  // symbol, i.e. exactly the part a builder acts on. The prose around it survives intact, so
  // a corrupted spec still READS correctly. That is why this is caught before sending rather
  // than reported after: by the time a post-write check fires, the bad description is stored.
  const cell = "| `components/experiments/outcome-marker.tsx:24` | `CircleX` |";
  const eaten = "| mponents/experiments/outcome-marker.tsx:24` | rcleX` |";
  const drift = describeContentDrift(cell, eaten);
  assert.ok(drift, "identifier loss must be reported");
  assert.match(cell, /components\/experiments/);
  assert.doesNotMatch(eaten, /components\/experiments/, "the path is what gets destroyed");
});

// --- create --desc runs the same guards as set-desc/patch-desc (AIO-1026) ---

test("create --desc refuses corrupt markdown before any mutation", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-lint-"));
  writeFileSync(path.join(cwd, "spec.md"), SENT, "utf8");
  const result = runCreateCli(["create", "New slice", "--desc", "spec.md"], cwd);
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "", "a rejected description must mean zero create calls");
  assert.match(result.stderr, /REFUSING TO SEND/);
  assert.doesNotMatch(result.stdout, /created/);
});

test("create --desc --force downgrades the lint to a warning and creates once", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-force-"));
  writeFileSync(path.join(cwd, "spec.md"), SENT, "utf8");
  const result = runCreateCli(["create", "New slice", "--desc", "spec.md", "--force"], cwd);
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.mutations, "issueCreate\n");
  assert.match(result.stderr, /warning/);
  assert.match(result.stdout, /created AIO-9/);
});

test("create --desc passes when the stored description is only cosmetically rewritten", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-cosmetic-"));
  writeFileSync(path.join(cwd, "spec.md"), "**not `x` icon**", "utf8");
  const result = runCreateCli(["create", "New slice", "--desc", "spec.md"], cwd, {
    postWriteDescription: "**not** `x` **icon**",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.mutations, "issueCreate\n");
  assert.match(result.stdout, /created AIO-9/);
});

test("create --desc reports post-write drift naming the created identifier", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-drift-"));
  writeFileSync(path.join(cwd, "spec.md"), "CircleSlash", "utf8");
  const result = runCreateCli(["create", "New slice", "--desc", "spec.md"], cwd, {
    postWriteDescription: "rcleSlash",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "issueCreate\n", "drift must not trigger a second create");
  assert.match(result.stdout, /created AIO-9/, "the created identifier is always named");
  assert.match(result.stderr, /AIO-9 was created but its stored description drifted/);
  assert.match(result.stderr, /set-desc AIO-9 spec\.md/, "the exact recovery command is printed");
});

test("a lost create response is reported without retrying the mutation", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-lost-"));
  writeFileSync(path.join(cwd, "spec.md"), "CircleSlash", "utf8");
  const result = runCreateCli(["create", "New slice", "--desc", "spec.md"], cwd, {
    loseCreateResponse: true,
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "issueCreate\n", "the create mutation is sent exactly once");
  assert.match(result.stderr, /NOT retried/);
  assert.match(result.stderr, /may have created the issue/);
  assert.match(result.stderr, /list AIO --open/);
});

test("a plain create without a description performs no readback query", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-plain-"));
  const result = runCreateCli(["create", "New slice"], cwd, {
    // if the CLI issued a readback here, the mock would serve this and confirmStored
    // would flag drift ("" vs "corrupted") and fail the exit code
    postWriteDescription: "corrupted",
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.mutations, "issueCreate\n");
});

test("normalizeForCompare preserves visible characters", () => {
  // normalisation must not be so aggressive that it hides loss
  const a = normalizeForCompare("**bold** `code` plain");
  assert.match(a, /bold/);
  assert.match(a, /code/);
  assert.match(a, /plain/);
});
