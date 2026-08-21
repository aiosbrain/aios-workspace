import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEASURED_EMPTY_MESSAGE,
  mutationBaseSkipMessage,
  resolveMutationBase,
} from "../scripts/mutation-push-base.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "scripts", "run-mutation.mjs");
const ZEROS = "0".repeat(40);
// 40 hex chars that will never name a real commit in this repo.
const BOGUS_SHA = "deadbeef".repeat(5);

const isCommitNever = () => {
  throw new Error("isCommit must not be consulted on this path");
};

test("an explicit --base wins over every environment input", () => {
  assert.deepEqual(
    resolveMutationBase({
      baseFlag: "upstream/main",
      mutationBaseSha: ZEROS,
      githubBaseRef: "main",
      isCommit: isCommitNever,
    }),
    { base: "upstream/main" }
  );
});

test("a valid push base sha is used as the diff base", () => {
  const seen = [];
  assert.deepEqual(
    resolveMutationBase({
      baseFlag: null,
      mutationBaseSha: "a".repeat(40),
      githubBaseRef: "",
      isCommit: (sha) => {
        seen.push(sha);
        return true;
      },
    }),
    { base: "a".repeat(40) }
  );
  assert.deepEqual(seen, ["a".repeat(40)]);
});

test("an all-zeros push base skips measurement explicitly (force push / branch creation)", () => {
  const resolution = resolveMutationBase({
    baseFlag: null,
    mutationBaseSha: ZEROS,
    githubBaseRef: "",
    // Zeros must be recognized WITHOUT asking git — cat-file on the zero sha
    // would just fail, and the skip reason should name the real cause.
    isCommit: isCommitNever,
  });
  assert.equal(resolution.base, undefined);
  assert.match(resolution.skip, /force push or branch creation/);
});

test("an unfetchable push base sha skips measurement explicitly", () => {
  const resolution = resolveMutationBase({
    baseFlag: null,
    mutationBaseSha: BOGUS_SHA,
    githubBaseRef: "",
    isCommit: () => false,
  });
  assert.equal(resolution.base, undefined);
  assert.match(resolution.skip, /not a resolvable commit/);
  assert.ok(resolution.skip.includes(BOGUS_SHA), "skip reason names the sha it rejected");
});

test("PR events keep diffing against origin/<GITHUB_BASE_REF>", () => {
  assert.deepEqual(
    resolveMutationBase({
      baseFlag: null,
      mutationBaseSha: "",
      githubBaseRef: "main",
      isCommit: isCommitNever,
    }),
    { base: "origin/main" }
  );
});

test("with no inputs at all the default base stays origin/main", () => {
  assert.deepEqual(
    resolveMutationBase({
      baseFlag: null,
      mutationBaseSha: "",
      githubBaseRef: "",
      isCommit: isCommitNever,
    }),
    { base: "origin/main" }
  );
});

test("the skip message is unambiguous and distinct from the measured-empty message", () => {
  const skip = mutationBaseSkipMessage("push event.before is the all-zeros sha");
  assert.match(skip, /mutation base undeterminable for this push — skipping measurement/);
  assert.notEqual(skip, MEASURED_EMPTY_MESSAGE);
  assert.ok(
    !skip.includes("no changed critical production files"),
    "a skipped run must never read as a measured-empty run"
  );
});

function runRunner(env) {
  return spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AIOS_MUTATION_DRY_RUN: "1",
      GITHUB_BASE_REF: "",
      GITHUB_STEP_SUMMARY: "",
      MUTATION_BASE_SHA: "",
      ...env,
    },
  });
}

test("runner: all-zeros MUTATION_BASE_SHA prints the skip message, not measured-empty, and exits 0", () => {
  const summaryFile = path.join(mkdtempSync(path.join(tmpdir(), "mutation-base-")), "summary.md");
  const result = runRunner({ MUTATION_BASE_SHA: ZEROS, GITHUB_STEP_SUMMARY: summaryFile });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mutation base undeterminable for this push — skipping measurement/);
  assert.ok(
    !result.stdout.includes(MEASURED_EMPTY_MESSAGE),
    "skip must not claim a measured empty diff"
  );
  assert.match(
    readFileSync(summaryFile, "utf8"),
    /mutation base undeterminable/,
    "the skip surfaces in the step summary"
  );
});

test("runner: an unfetchable MUTATION_BASE_SHA also skips explicitly with exit 0", () => {
  const result = runRunner({ MUTATION_BASE_SHA: BOGUS_SHA });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not a resolvable commit/);
  assert.ok(!result.stdout.includes(MEASURED_EMPTY_MESSAGE));
});

test("runner: a valid MUTATION_BASE_SHA takes the measured path (HEAD vs HEAD is honestly empty)", () => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const result = runRunner({ MUTATION_BASE_SHA: head });
  assert.equal(result.status, 0, result.stderr);
  // Diffing HEAD against itself IS an empty measurement — the measured-empty
  // message is correct here, and the skip message must not appear.
  assert.ok(result.stdout.includes(MEASURED_EMPTY_MESSAGE), result.stdout);
  assert.ok(!result.stdout.includes("mutation base undeterminable"));
});
