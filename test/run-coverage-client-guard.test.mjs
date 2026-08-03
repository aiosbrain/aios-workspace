import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clientWorkspaceStatus,
  hasClientWorkspace,
  main,
  matchesWorkspacePatterns,
} from "../scripts/run-coverage.mjs";

/**
 * AIO-612. `gui/` is being cut to aiosbrain/aios-workspace-gui. `runFull` and `runMerge` both call
 * `npm run test:coverage --workspace gui/client`; once that workspace is gone the call exits 1 and
 * no coverage artifact is written.
 *
 * The asymmetry that makes this worth real tests: CI's coverage job runs `--merge 3`, so an
 * unguarded MERGE breaks red. Nothing in CI runs the no-flag mode except scan-on-merge.yml, under
 * `|| true` — an unguarded FULL is silently swallowed and the scanner publishes
 * `test_coverage_pct: null`. So the suite has to prove BOTH modes skip, at the real call sites.
 */

const METRIC = { total: 10, covered: 8, skipped: 0, pct: 80 };
const SUMMARY = JSON.stringify({
  "scripts/a.mjs": { lines: METRIC },
  total: { lines: METRIC, statements: METRIC, functions: METRIC, branches: METRIC },
});

/** A fixture repo root: shard data for `--merge 1`, and optionally a gui/client workspace. */
function makeRoot({ manifest = false, registered = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "run-cov-guard-"));
  mkdirSync(path.join(root, "coverage", "shard-1"), { recursive: true });
  writeFileSync(path.join(root, "coverage", "shard-1", "coverage-1.json"), "{}");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      workspaces: registered ? ["gui/server", "gui/client"] : ["gui/server"],
    })
  );
  if (manifest) {
    mkdirSync(path.join(root, "gui", "client"), { recursive: true });
    writeFileSync(path.join(root, "gui", "client", "package.json"), '{"name":"client"}');
  }
  return root;
}

/**
 * Stand-in for the real spawn. Records every command the mode issues, and writes the summary
 * merge-coverage.mjs would write so `--merge` can finish. An UNGUARDED call site reaches this the
 * same way a guarded one does, so the recording is what proves the wiring.
 */
function recorder(root) {
  const calls = [];
  return {
    calls,
    clientRuns: () =>
      calls.filter((c) => c.command === "npm" && c.args.includes("gui/client")).length,
    exec: async (command, args) => {
      calls.push({ command, args });
      if (args.some((a) => String(a).endsWith("merge-coverage.mjs"))) {
        mkdirSync(path.join(root, "coverage"), { recursive: true });
        writeFileSync(path.join(root, "coverage", "coverage-summary.json"), SUMMARY);
      }
    },
  };
}

test("matchesWorkspacePatterns handles exact, glob and normalized workspace entries", () => {
  const m = (patterns, target = "gui/client") => matchesWorkspacePatterns(patterns, target);
  assert.equal(m(["gui/client"]), true);
  assert.equal(m(["./gui/client/"]), true);
  assert.equal(m(["gui/*"]), true);
  assert.equal(m(["gui/**"]), true);
  assert.equal(m(["packages/*"]), false);
  assert.equal(m(["gui/clientx"]), false);
  assert.equal(m([]), false);
  // `*` must not cross a path separator, or `packages/*` would swallow `packages/a/b`.
  assert.equal(m(["gui/*"], "gui/client/sub"), false);
  // `**` spans zero segments, so `gui/**/client` covers `gui/client` — npm agrees.
  assert.equal(m(["gui/**/client"]), true);
  assert.equal(m(["gui/**/client"], "gui/a/b/client"), true);
  // `?` is one non-separator character; `[...]` is a character class.
  assert.equal(m(["gui/clien?"]), true);
  assert.equal(m(["gui/clien[t]"]), true);
  assert.equal(m(["gui/clien[!t]"]), false);
  assert.equal(m(["gui/?"]), false);
  // A literal `.` must not act as a regex wildcard: `gui/client.` is not `gui/client`.
  assert.equal(m(["gui/client."]), false);
});

test("matchesWorkspacePatterns honours npm's `!` exclusions (AIO-612)", () => {
  // THE FALSE POSITIVE THIS GUARD EXISTS TO AVOID. npm resolves `workspaces` as an ordered
  // include/exclude set: ["gui/*", "!gui/client"] yields NO gui/client workspace, and
  // `npm run test:coverage --workspace gui/client` exits 1 with "No workspaces found".
  // Judging entries independently sees the `gui/*` include and wrongly answers "present";
  // the spawn then fails, and in runFull that failure is swallowed by scan-on-merge.yml's
  // `|| true`, publishing null coverage against a fully green CI.
  assert.equal(matchesWorkspacePatterns(["gui/*", "!gui/client"], "gui/client"), false);
  assert.equal(matchesWorkspacePatterns(["gui/**", "!gui/*"], "gui/client"), false);
  assert.equal(matchesWorkspacePatterns(["!gui/client", "gui/*"], "gui/client"), false);
  // An exclusion that does not cover the target leaves the include standing.
  assert.equal(matchesWorkspacePatterns(["gui/*", "!gui/server"], "gui/client"), true);
  // An exclusion alone never includes anything.
  assert.equal(matchesWorkspacePatterns(["!gui/client"], "gui/client"), false);
});

test("clientWorkspaceStatus reports a negated workspace as deregistered (AIO-612)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "run-cov-negated-"));
  try {
    mkdirSync(path.join(root, "gui", "client"), { recursive: true });
    writeFileSync(path.join(root, "gui", "client", "package.json"), '{"name":"client"}');
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["gui/*", "!gui/client"] })
    );
    // Manifest on disk, include pattern matches — and npm still resolves no workspace.
    assert.equal(clientWorkspaceStatus(root), "deregistered");
    assert.equal(hasClientWorkspace(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client workspace predicate requires the manifest AND npm registration (AIO-612)", () => {
  const gone = makeRoot();
  const bareDir = makeRoot();
  mkdirSync(path.join(bareDir, "gui", "client", "coverage"), { recursive: true });
  const deregistered = makeRoot({ manifest: true, registered: false });
  const live = makeRoot({ manifest: true, registered: true });
  try {
    assert.equal(clientWorkspaceStatus(gone), "no-manifest");
    // A leftover empty gui/client/ is not a workspace: npm resolves --workspace through the
    // manifest, so a directory-only check would pass here and then fail the spawn.
    assert.equal(clientWorkspaceStatus(bareDir), "no-manifest");
    // THE MIXED STATE. AIO-612 PR-B deregisters the workspace in package.json at one stage and
    // deletes the tree at a later one, so the repo genuinely passes through this: manifest still
    // on disk, but npm already answers "No workspaces found: --workspace=gui/client" and exits 1.
    assert.equal(clientWorkspaceStatus(deregistered), "deregistered");
    assert.equal(hasClientWorkspace(deregistered), false);
    assert.equal(clientWorkspaceStatus(live), "present");
    assert.equal(hasClientWorkspace(live), true);
  } finally {
    for (const dir of [gone, bareDir, deregistered, live]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Drives the real CLI dispatcher for BOTH modes. Guarding one call site and not the other is the
// highest-risk regression here (CI green, dashboard null), so each mode is asserted separately.
for (const [mode, argv] of [
  ["full (npm run test:coverage — no CI job runs this)", []],
  ["merge (ci.yml coverage job)", ["--merge", "1"]],
]) {
  test(`run-coverage ${mode} skips the client pass when gui/client is gone (AIO-612)`, async () => {
    const root = makeRoot();
    const rec = recorder(root);
    const log = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await main(argv, { root, exec: rec.exec });
    } finally {
      console.log = log;
    }
    try {
      assert.equal(
        rec.clientRuns(),
        0,
        `this mode still invokes the deleted workspace: ${JSON.stringify(rec.calls)}`
      );
      assert.ok(
        logs.some((line) => /skipping gui\/client coverage \(root only/.test(line)),
        `expected a skip line, got ${JSON.stringify(logs)}`
      );
      assert.ok(
        rec.calls.some((c) => c.args.some((a) => String(a).endsWith("merge-coverage.mjs"))),
        "the coverage artifact must still be produced"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`run-coverage ${mode} still runs the client pass while gui/client exists`, async () => {
    // Without this the skip assertions above would also pass against a mode that never calls the
    // client pass at all — i.e. they would not be watching the recorder.
    const root = makeRoot({ manifest: true, registered: true });
    const rec = recorder(root);
    try {
      await main(argv, { root, exec: rec.exec });
      assert.equal(rec.clientRuns(), 1, "the client coverage pass must still run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("merge mode still writes the baseline candidate when the client pass is skipped", async () => {
  const root = makeRoot();
  const rec = recorder(root);
  try {
    await main(["--merge", "1"], { root, exec: rec.exec });
    const summary = JSON.parse(
      readFileSync(path.join(root, "coverage", "coverage-summary.json"), "utf8")
    );
    assert.equal(summary.total.lines.pct, 80);
    const candidate = JSON.parse(
      readFileSync(path.join(root, "coverage", "coverage-baseline-candidate.json"), "utf8")
    );
    assert.ok(candidate, "coverage-baseline-candidate.json must still be written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
