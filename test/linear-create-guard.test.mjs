// test/linear-create-guard.test.mjs — create-path description guards (AIO-1026)
//
// `linear create` writes a brand-new spec through one issueCreate mutation. These tests pin
// the guard contract: the indented-table lint fires BEFORE any network call, --force
// downgrades it to a warning, the mutation is sent exactly once and never retried, and the
// post-create readback recovery commands reference a saved copy of the body that was
// actually SENT (origin block / stamped template included), never the raw --desc file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts/aios.mjs");

// The corrupting shape (a table indented under a list item) — see linear-desc-roundtrip.
const SENT = [
  "3. **Reconcile the outcome encoding.**",
  "",
  "   | Slice | file | `dead-end` |",
  "   |---|---|---|",
  "   | I2 (#8) | `components/experiments/outcome-marker.tsx:24` | `CircleX` / `text-red` |",
  "   | I3 (#9) | `experiments-index.tsx` | plain text, no icon or colour |",
].join("\n");

// Mock for the `create` write path (AIO-1026): team + state lookups, ONE issueCreate
// mutation (logged, optionally with a lost response), and the post-create readback.
// Static mock-fetch preload: all behavior is driven by env vars, so it lives at module
// scope (it closes over nothing).
const PRELOAD_SOURCE = `import { appendFileSync, writeFileSync } from "node:fs";
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
  } else if (query.includes("labels(first:250")) {
    data = { team: { labels: {
      nodes: [{ id: "label-1", name: "origin-lab" }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } };
  } else if (query.includes("issueCreate")) {
    appendFileSync(process.env.MUTATION_LOG, "issueCreate\\n");
    if (process.env.LOSE_CREATE_RESPONSE) throw new Error("socket hang up");
    if (process.env.CREATE_RESPONSE_DATA !== undefined) {
      // HTTP-success payload whose data is missing/null/empty: the mutation was ACCEPTED
      // (already logged above) but nothing about it is confirmed.
      return new Response(
        JSON.stringify({ data: JSON.parse(process.env.CREATE_RESPONSE_DATA) }),
        { status: 200 }
      );
    }
    stored = variables.input.description || "";
    writeFileSync(process.env.SENT_BODY_LOG, stored);
    created = true;
    data = { issueCreate: { success: true, issue: {
      id: "issue-9", identifier: "AIO-9", title: variables.input.title,
      url: "https://linear.app/x/AIO-9", branchName: "aio-9"
    } } };
  } else if (query.includes("issue(id:$id){ description }")) {
    if (process.env.LOSE_READBACK_RESPONSE) throw new Error("socket hang up");
    data = { issue: { description:
      created && process.env.POST_WRITE_DESCRIPTION !== undefined
        ? process.env.POST_WRITE_DESCRIPTION
        : stored } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), { status: 200 });
};
`;

function runCreateCli(
  args,
  cwd,
  {
    postWriteDescription,
    loseCreateResponse = false,
    loseReadbackResponse = false,
    createResponseData,
    env = {},
  } = {}
) {
  const supportDir = mkdtempSync(path.join(tmpdir(), "linear-create-guard-"));
  const preload = path.join(supportDir, "mock-fetch.mjs");
  const mutationLog = path.join(supportDir, "mutations.log");
  const sentBodyLog = path.join(supportDir, "sent-body.md");
  writeFileSync(preload, PRELOAD_SOURCE, "utf8");
  const result = spawnSync(process.execPath, ["--import", preload, CLI, "linear", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LINEAR_API_KEY: "offline-test",
      MUTATION_LOG: mutationLog,
      SENT_BODY_LOG: sentBodyLog,
      AIOS_LINEAR_TEAM_KEY: "",
      AIOS_LINEAR_ORIGIN_LABEL: "",
      ...(loseCreateResponse ? { LOSE_CREATE_RESPONSE: "1" } : {}),
      ...(createResponseData === undefined
        ? {}
        : { CREATE_RESPONSE_DATA: JSON.stringify(createResponseData) }),
      ...(loseReadbackResponse ? { LOSE_READBACK_RESPONSE: "1" } : {}),
      ...(postWriteDescription === undefined
        ? {}
        : { POST_WRITE_DESCRIPTION: postWriteDescription }),
      ...env,
    },
  });
  const mutations = readFileSync(mutationLog, { encoding: "utf8", flag: "a+" });
  const sentBody = readFileSync(sentBodyLog, { encoding: "utf8", flag: "a+" });
  rmSync(supportDir, { recursive: true, force: true });
  return { ...result, mutations, sentBody };
}

// Pull the recovery-file path a failed create printed, read the saved body, and delete the
// file (it lives in the OS tmpdir). Proves the printed command round-trips the SENT body.
function readPrintedRecoveryFile(stderr, command) {
  // The printed command must quote the path so a TMPDIR containing spaces still
  // copy-pastes as one argv token.
  const match = stderr.match(new RegExp(`linear ${command} AIO-9 "([^"]+)"`));
  assert.ok(
    match,
    `stderr must print a "${command}" recovery command with a quoted path:\n${stderr}`
  );
  const file = match[1];
  const dir = path.dirname(file);
  // The sent body can be sensitive spec content: owner-only file (0600, created
  // exclusively) inside an unpredictable owner-only mkdtemp dir (0700).
  assert.equal(statSync(file).mode & 0o777, 0o600, "recovery file must be owner-only");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "recovery dir must be owner-only");
  assert.match(path.basename(dir), /^linear-create-/, "recovery file lives in its own mkdtemp dir");
  const body = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return body;
}
// --- create --desc runs the same guards as set-desc/patch-desc (AIO-1026) ---

for (const flag of ["--desc", "--label"]) {
  test(`create ${flag} followed by another flag is a missing value, not a value`, () => {
    // Without the guard, `--force` would be consumed as the value (e.g. as the desc
    // filename) instead of being parsed as the lint override. Mirrors parseListArgs.
    const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-flagvalue-"));
    const result = runCreateCli(["create", "New slice", flag, "--force"], cwd);
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(result.status, 1);
    assert.equal(result.mutations, "", "a parse error must mean zero create calls");
    assert.match(result.stderr, new RegExp(`${flag} requires a value`));
  });
}

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
  const recovered = readPrintedRecoveryFile(result.stderr, "set-desc");
  assert.equal(recovered, result.sentBody, "the printed set-desc file holds the sent body");
});

test("drift recovery round-trips the origin block, not just the --desc file", () => {
  // parseCreateArgs prepends **Origin:** to the body AFTER reading --desc, so pointing the
  // recovery command at the original file would overwrite (and lose) the origin block.
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-origin-drift-"));
  writeFileSync(path.join(cwd, "spec.md"), "CircleSlash", "utf8");
  const result = runCreateCli(
    ["create", "New slice", "--desc", "spec.md", "--label", "origin-lab"],
    cwd,
    {
      postWriteDescription: "rcleSlash",
      env: { AIOS_LINEAR_ORIGIN_LABEL: "origin-lab", AIOS_LINEAR_ORIGIN_TEXT: "from tests" },
    }
  );
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.sentBody, "**Origin:** from tests\n\nCircleSlash");
  const recovered = readPrintedRecoveryFile(result.stderr, "set-desc");
  assert.equal(recovered, result.sentBody, "the recovery file must include the origin block");
});

test("a failed readback prints verify-desc against the sent template body", () => {
  // With --template there is no --desc file at all; the recovery command must reference a
  // file holding the stamped template that was sent, and must be the non-destructive
  // verify-desc (nothing is known about what Linear stored when the readback itself fails).
  const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-template-readback-"));
  const result = runCreateCli(["create", "My slice", "--template", "aios"], cwd, {
    loseReadbackResponse: true,
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.equal(result.mutations, "issueCreate\n", "a failed readback must not retry create");
  assert.match(result.stderr, /readback FAILED for created issue AIO-9/);
  assert.match(result.stderr, /AIO-9 EXISTS — do not re-run create/);
  assert.doesNotMatch(result.stderr, /set-desc/, "no destructive command on an unknown state");
  const recovered = readPrintedRecoveryFile(result.stderr, "verify-desc");
  assert.match(recovered, /^# My slice$/m, "the saved body is the stamped template");
  assert.equal(recovered, result.sentBody, "the verify-desc file holds exactly the sent body");
});

for (const [label, createResponseData] of [
  ["null data", null],
  ["missing issueCreate", {}],
]) {
  test(`an HTTP-success create response with ${label} routes to the unconfirmed path`, () => {
    // The mutation was accepted on the wire but nothing confirms the result — this must
    // print the duplicate-prevention warning, never a raw TypeError from d.issueCreate.
    const cwd = mkdtempSync(path.join(tmpdir(), "linear-create-nulldata-"));
    writeFileSync(path.join(cwd, "spec.md"), "CircleSlash", "utf8");
    const result = runCreateCli(["create", "New slice", "--desc", "spec.md"], cwd, {
      createResponseData,
    });
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(result.status, 1);
    assert.equal(result.mutations, "issueCreate\n", "the create mutation is sent exactly once");
    assert.match(result.stderr, /create FAILED/);
    assert.match(result.stderr, /NOT retried/);
    assert.match(result.stderr, /may have created the issue/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
  });
}

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
