import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  clientWorkspaceStatus,
  hasClientWorkspace,
  isResolvedWorkspace,
  main,
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

/**
 * A fixture repo root: shard data for `--merge 1`, and optionally a gui/client workspace.
 *
 * `registered` writes the lockfile entry npm would write, because that is what the guard reads.
 * The lockfile-vs-npm parity test below proves the shape is npm's own rather than one we invented.
 */
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
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture" },
        "gui/server": { name: "@fixture/server" },
        // npm writes BOTH a member entry keyed by path and an install-tree link keyed by
        // node_modules/<name>. Only the first means "this is a workspace".
        "node_modules/@fixture/server": { resolved: "gui/server", link: true },
        ...(registered
          ? {
              "gui/client": { name: "@fixture/client" },
              "node_modules/@fixture/client": { resolved: "gui/client", link: true },
            }
          : {}),
      },
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

test("isResolvedWorkspace reads the lockfile, and answers no when it cannot", () => {
  const live = makeRoot({ manifest: true, registered: true });
  const dereg = makeRoot({ manifest: true, registered: false });
  const noLock = makeRoot({ manifest: true, registered: true });
  rmSync(path.join(noLock, "package-lock.json"));
  const badLock = makeRoot({ manifest: true, registered: true });
  writeFileSync(path.join(badLock, "package-lock.json"), "{ not json");
  try {
    assert.equal(isResolvedWorkspace(live, "gui/client"), true);
    assert.equal(isResolvedWorkspace(live, "gui/server"), true);
    assert.equal(isResolvedWorkspace(dereg, "gui/client"), false);
    // An install-tree link is not the member entry.
    assert.equal(isResolvedWorkspace(live, "node_modules/@fixture/client"), false);
    // No lockfile / unparseable lockfile => "not a workspace". That skips the client pass and
    // shrinks the reported total, which trips the ratchet on the merge lane — loud. Defaulting
    // the other way would run a spawn that fails and, in runFull, fail silently.
    assert.equal(isResolvedWorkspace(noLock, "gui/client"), false);
    assert.equal(isResolvedWorkspace(badLock, "gui/client"), false);
  } finally {
    for (const d of [live, dereg, noLock, badLock]) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * PARITY WITH REAL NPM — the test that makes the oracle claim honest.
 *
 * A hand-rolled glob matcher stood here and was wrong in both directions: `["gui/*",
 * "!gui/client"]` read as present when npm resolves nothing (false positive → the null-coverage
 * incident), and `gui/client/**`, `gui/{client,server}`, `gui/@(client|server)`, `gui/clien?`,
 * `gui/clien[t]` all read as absent when npm accepts them (false negative → ~1.9k lines silently
 * dropped from the denominator). Both classes came out of adversarial review.
 *
 * So this asserts agreement with npm itself rather than with our reading of npm: for each
 * registration form, generate a real lockfile, then ask npm to run a script in the workspace and
 * compare its exit status with the predicate.
 */
test(
  "clientWorkspaceStatus agrees with real npm across every registration form",
  { timeout: 300_000 },
  (t) => {
    let npmVersion;
    try {
      npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return t.skip("npm is not runnable in this environment");
    }

    const CASES = [
      ["gui/client"],
      ["./gui/client/"],
      ["gui/*"],
      ["gui/**"],
      ["gui/**/client"],
      ["gui/client/**"],
      ["gui/clien?"],
      ["gui/clien[t]"],
      ["gui/{client,server}"],
      ["gui/@(client|server)"],
      ["gui/*", "!gui/client"],
      ["gui/**", "!gui/*"],
      ["!gui/client", "gui/*"],
      ["gui/*", "!gui/server"],
      ["!gui/client"],
      ["gui/client."],
      ["gui/clien[!t]"],
      ["gui/?"],
      ["packages/*"],
      [],
    ];

    for (const workspaces of CASES) {
      const root = mkdtempSync(path.join(tmpdir(), "run-cov-npm-parity-"));
      try {
        for (const member of ["client", "server"]) {
          mkdirSync(path.join(root, "gui", member), { recursive: true });
          writeFileSync(
            path.join(root, "gui", member, "package.json"),
            JSON.stringify({ name: `@fixture/${member}`, version: "1.0.0", scripts: { probe: "" } })
          );
        }
        writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "fixture", version: "1.0.0", private: true, workspaces })
        );
        // Lockfile only: no network, no node_modules, but npm's real workspace resolution.
        try {
          execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
            cwd: root,
            stdio: "pipe",
          });
        } catch {
          /* npm may refuse to write a lockfile; the predicate must then answer "not a workspace" */
        }

        let npmResolves;
        try {
          execFileSync("npm", ["run", "probe", "--workspace", "gui/client"], {
            cwd: root,
            stdio: "pipe",
          });
          npmResolves = true;
        } catch {
          npmResolves = false;
        }

        assert.equal(
          clientWorkspaceStatus(root) === "present",
          npmResolves,
          `workspaces ${JSON.stringify(workspaces)}: guard says ` +
            `${clientWorkspaceStatus(root)}, npm ${npmResolves ? "resolves" : "does NOT resolve"} ` +
            `gui/client (npm ${npmVersion})`
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
);

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
