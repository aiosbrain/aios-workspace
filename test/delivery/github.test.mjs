// test/delivery/github.test.mjs — GitHub PR fetch + check-rollup aggregation. `aggregateChecks`
// is pure and tested against FIXTURES (no network). `fetchPullRequests` is tested against a
// fake `gh` binary on PATH that prints a canned fixture — this proves the argv shape and JSON
// parsing without ever calling the real GitHub API.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchPullRequests, aggregateChecks } from "../../scripts/delivery/github.mjs";

// ── aggregateChecks — pure, fixture-driven ──────────────────────────────────────────────────

test("aggregateChecks: no checks reported → 'none'", () => {
  assert.equal(aggregateChecks({ statusCheckRollup: [] }), "none");
  assert.equal(aggregateChecks({}), "none");
});

test("aggregateChecks: all green CheckRuns → 'pass'", () => {
  const pr = {
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS" },
      { __typename: "CheckRun", conclusion: "SUCCESS" },
    ],
  };
  assert.equal(aggregateChecks(pr), "pass");
});

test("aggregateChecks: one FAILURE among green → 'fail' (fail wins over pass)", () => {
  const pr = {
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS" },
      { __typename: "CheckRun", conclusion: "FAILURE" },
    ],
  };
  assert.equal(aggregateChecks(pr), "fail");
});

test("aggregateChecks: a pending check among green → 'pending'", () => {
  const pr = {
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "IN_PROGRESS" },
    ],
  };
  assert.equal(aggregateChecks(pr), "pending");
});

test("aggregateChecks: fail wins over pending when both are present", () => {
  // Partially-failed fixture: one job already failed, another is still running. The board is
  // red regardless of what's still pending.
  const pr = {
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "FAILURE" },
      { __typename: "CheckRun", status: "QUEUED" },
    ],
  };
  assert.equal(aggregateChecks(pr), "fail");
});

test("aggregateChecks: a StatusContext entry uses its `state` field, not `conclusion`", () => {
  const pr = { statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }] };
  assert.equal(aggregateChecks(pr), "fail");
});

// ── fetchPullRequests — argv shape + JSON parsing, via a fake `gh` on PATH ──────────────────

function withFakeGh(fixtureJson, fn) {
  const bin = mkdtempSync(path.join(tmpdir(), "delivery-fakegh-fetch-"));
  const record = path.join(bin, "record.log");
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2)) + '\\n');",
      `process.stdout.write(${JSON.stringify(JSON.stringify(fixtureJson))});`,
    ].join("\n")
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const originalPath = process.env.PATH;
  const originalRecord = process.env.RECORD;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.RECORD = record;
  try {
    return fn(() =>
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalRecord === undefined) delete process.env.RECORD;
    else process.env.RECORD = originalRecord;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("fetchPullRequests parses the fixture and builds the expected argv", () => {
  const fixture = [{ number: 1, title: "x", headRefName: "feat/x", state: "OPEN" }];
  withFakeGh(fixture, (readRecords) => {
    const result = fetchPullRequests("acme/repo", { state: "open", limit: 10 });
    assert.deepEqual(result, fixture);
    const [argv] = readRecords();
    assert.deepEqual(argv.slice(0, 6), ["pr", "list", "--repo", "acme/repo", "--state", "open"]);
    assert.ok(argv.includes("--limit"));
    assert.equal(argv[argv.indexOf("--limit") + 1], "10");
    assert.ok(argv.includes("--json"));
    const jsonFields = argv[argv.indexOf("--json") + 1];
    for (const field of ["number", "title", "headRefName", "headRefOid", "statusCheckRollup"]) {
      assert.ok(jsonFields.includes(field), `--json fields missing '${field}'`);
    }
  });
});

test("fetchPullRequests defaults to state=all and limit=50", () => {
  withFakeGh([], (readRecords) => {
    fetchPullRequests("acme/repo");
    const [argv] = readRecords();
    assert.equal(argv[argv.indexOf("--state") + 1], "all");
    assert.equal(argv[argv.indexOf("--limit") + 1], "50");
  });
});
