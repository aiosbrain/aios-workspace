import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Fixture builders for the AIO-612 client-workspace guard tests
 * (`test/run-coverage-client-guard.test.mjs`).
 *
 * These live outside the test file because the guard is asserted from two directions — the
 * predicate in isolation, and the real CLI dispatcher driving both coverage modes — and both
 * need the same tree on disk.
 */

export const METRIC = { total: 10, covered: 8, skipped: 0, pct: 80 };

export const SUMMARY = JSON.stringify({
  "scripts/a.mjs": { lines: METRIC },
  total: { lines: METRIC, statements: METRIC, functions: METRIC, branches: METRIC },
});

/**
 * A fixture repo root: shard data for `--merge 1`, and optionally a gui/client workspace.
 *
 * The guard asks npm, so a fixture has to be a tree npm will actually resolve — no hand-written
 * lockfile can stand in. `registered` therefore controls the root `workspaces` array, which is
 * what npm reads. No lockfile is written at all: an earlier design read one, and the parity tests
 * cover why that was wrong.
 */
export function makeRoot({ manifest = false, registered = false } = {}) {
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
 * A gui/client + gui/server pair under `root`, each with a no-op `probe` script so the parity
 * sweeps can ask real npm `run --workspace gui/client` whether it resolves.
 */
export function makeParityMembers(root) {
  for (const member of ["client", "server"]) {
    mkdirSync(path.join(root, "gui", member), { recursive: true });
    writeFileSync(
      path.join(root, "gui", member, "package.json"),
      JSON.stringify({ name: `@fixture/${member}`, version: "1.0.0", scripts: { probe: "" } })
    );
  }
}

/**
 * Stand-in for the real spawn. Records every command the mode issues, and writes the summary
 * merge-coverage.mjs would write so `--merge` can finish. An UNGUARDED call site reaches this the
 * same way a guarded one does, so the recording is what proves the wiring.
 */
export function recorder(root) {
  const calls = [];
  return {
    calls,
    clientRuns: () =>
      calls.filter((c) => c.command === "npm" && c.args.includes("gui/client")).length,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.some((a) => String(a).endsWith("merge-coverage.mjs"))) {
        mkdirSync(path.join(root, "coverage"), { recursive: true });
        writeFileSync(path.join(root, "coverage", "coverage-summary.json"), SUMMARY);
      }
    },
  };
}

/** Generate a real lockfile: no network, no node_modules, but npm's real workspace resolution. */
export function install(root) {
  try {
    execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: root,
      stdio: "pipe",
    });
  } catch {
    /* npm may refuse to write a lockfile for an invalid registration; that is a valid state */
  }
}

/** Does real npm resolve `gui/client` as a workspace in `root`? The oracle the guard is graded against. */
export function npmResolvesClient(root) {
  try {
    execFileSync("npm", ["run", "probe", "--workspace", "gui/client"], {
      cwd: root,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
