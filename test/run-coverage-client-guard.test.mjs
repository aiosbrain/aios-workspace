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
 * The guard asks npm, so a fixture has to be a tree npm will actually resolve — no hand-written
 * lockfile can stand in. `registered` therefore controls the root `workspaces` array, which is
 * what npm reads. No lockfile is written at all: an earlier design read one, and the parity test
 * below covers why that was wrong.
 */
function makeRoot({ manifest = false, registered = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "run-cov-guard-"));
  mkdirSync(path.join(root, "coverage", "shard-1"), { recursive: true });
  writeFileSync(path.join(root, "coverage", "shard-1", "coverage-1.json"), "{}");
  mkdirSync(path.join(root, "gui", "server"), { recursive: true });
  writeFileSync(
    path.join(root, "gui", "server", "package.json"),
    JSON.stringify({ name: "@fixture/server", version: "1.0.0" })
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      private: true,
      workspaces: registered ? ["gui/server", "gui/client"] : ["gui/server"],
    })
  );
  if (manifest) {
    mkdirSync(path.join(root, "gui", "client"), { recursive: true });
    writeFileSync(
      path.join(root, "gui", "client", "package.json"),
      JSON.stringify({ name: "@fixture/client", version: "1.0.0" })
    );
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

/** Generate a real lockfile: no network, no node_modules, but npm's real workspace resolution. */
function install(root) {
  try {
    execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    /* npm may refuse to write a lockfile for an invalid registration; that is a valid state */
  }
}

test("isResolvedWorkspace answers from npm, and defaults to RUN when npm cannot answer", () => {
  const live = makeRoot({ manifest: true, registered: true });
  const dereg = makeRoot({ manifest: true, registered: false });
  const broken = makeRoot({ manifest: true, registered: true });
  writeFileSync(path.join(broken, "package.json"), "{ not json");
  try {
    assert.equal(isResolvedWorkspace(live, "gui/client"), true);
    assert.equal(isResolvedWorkspace(live, "gui/server"), true);
    assert.equal(isResolvedWorkspace(dereg, "gui/client"), false);
    // THE DIRECTION THAT MATTERS. npm cannot answer here at all. Returning false would skip the
    // client pass, and in runFull that skip is swallowed by scan-on-merge.yml's `|| true` — a
    // silent under-report. Worse, it would not even go red on the merge lane: root-only coverage
    // is 81.87% against a 79.7% floor, so the ratchet still passes. Only npm's explicit
    // "No workspaces found" is allowed to mean absence; everything else runs the real command
    // and lets the real error surface.
    assert.equal(isResolvedWorkspace(broken, "gui/client"), true);
  } finally {
    for (const d of [live, dereg, broken]) rmSync(d, { recursive: true, force: true });
  }
});

test("a STALE lockfile cannot resurrect the false positive (AIO-612)", () => {
  // The design this replaces read `package-lock.json`'s packages[] entry, on the argument that
  // `npm ci` fails when the lockfile and manifest disagree. MEASURED: it does not. Both `npm ci`
  // and `npm install` exit 0 and KEEP the stale member entry, while `npm run --workspace` exits
  // 1 — which is precisely the state AIO-612 PR-B passes through, and precisely the
  // null-coverage incident. Asking npm live is immune; this test is what keeps it that way.
  const root = makeRoot({ manifest: true, registered: true });
  try {
    execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: root,
      stdio: "pipe",
    });
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    assert.ok(lock.packages?.["gui/client"], "precondition: the lockfile records gui/client");

    // Deregister in the manifest only — no reinstall. The lockfile still lists gui/client.
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["gui/server"],
      })
    );
    const stillStale = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    assert.ok(stillStale.packages?.["gui/client"], "the stale entry is still there");

    let npmResolves;
    try {
      execFileSync("npm", ["ls", "--workspace", "gui/client", "--depth", "0"], {
        cwd: root,
        stdio: "pipe",
      });
      npmResolves = true;
    } catch {
      npmResolves = false;
    }
    assert.equal(npmResolves, false, "npm does not resolve the deregistered workspace");
    assert.equal(clientWorkspaceStatus(root), "deregistered");
    assert.equal(hasClientWorkspace(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * PARITY WITH REAL NPM — the test that keeps the guard honest.
 *
 * Two predecessors failed here, both found by adversarial review:
 *   - a hand-rolled glob matcher: read `["gui/*", "!gui/client"]` as present when npm resolves
 *     nothing (the null-coverage incident), and rejected `gui/client/**`, `gui/{client,server}`,
 *     `gui/@(client|server)`, `gui/clien?`, `gui/clien[t]`, which npm accepts (~1.9k lines
 *     silently dropped from the denominator).
 *   - reading `package-lock.json`: goes stale, and lockfile v1 has no `packages` key at all.
 *
 * So this compares against npm itself, and deliberately covers the LOCKFILE STATES the previous
 * revision's parity test missed — it regenerated a fresh v3 lockfile every time, which is exactly
 * the one state where the broken design worked.
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
        install(root);

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

/**
 * The lockfile sweep, split out from the registration sweep above.
 *
 * A valid registration must read as present in EVERY lockfile state — including the ones that
 * broke the read-the-lockfile design. The previous revision's parity test regenerated a fresh v3
 * lockfile every time, which is exactly the single state where that design worked.
 */
test(
  "clientWorkspaceStatus agrees with npm regardless of lockfile state",
  { timeout: 300_000 },
  (t) => {
    let npmVersion;
    try {
      npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return t.skip("npm is not runnable in this environment");
    }

    const LOCK_STATES = [
      ["fresh v3 lockfile", (root) => install(root)],
      ["no lockfile at all", () => {}],
      [
        "unparseable lockfile",
        (root) => writeFileSync(path.join(root, "package-lock.json"), "{ not json"),
      ],
      [
        "v1 lockfile (no packages key)",
        (root) => {
          install(root);
          const lp = path.join(root, "package-lock.json");
          const d = JSON.parse(readFileSync(lp, "utf8"));
          writeFileSync(
            lp,
            JSON.stringify({
              name: d.name,
              version: d.version,
              lockfileVersion: 1,
              dependencies: {},
            })
          );
        },
      ],
    ];

    for (const [label, prepare] of LOCK_STATES) {
      const root = mkdtempSync(path.join(tmpdir(), "run-cov-lockstate-"));
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
          JSON.stringify({
            name: "fixture",
            version: "1.0.0",
            private: true,
            workspaces: ["gui/client", "gui/server"],
          })
        );
        prepare(root);

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
          npmResolves,
          true,
          `${label}: npm should still resolve a registered workspace`
        );
        assert.equal(
          clientWorkspaceStatus(root),
          "present",
          `${label}: guard says ${clientWorkspaceStatus(root)} but npm resolves gui/client ` +
            `(npm ${npmVersion}). A predicate that reads the lockfile fails here.`
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
