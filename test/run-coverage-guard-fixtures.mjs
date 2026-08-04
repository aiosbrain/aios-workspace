import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Fixture builders for the AIO-742 client-coverage ownership tests
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
 * `registered` controls the root `workspaces` array independently from `manifest`, so tests can
 * prove that a present client stays coverage-owned through workspace deregistration.
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
      JSON.stringify({
        name: "@fixture/client",
        version: "1.0.0",
        scripts: { "test:coverage": "" },
      })
    );
  }
  return root;
}

/**
 * Stand-in for the real spawn. Records every command the mode issues, and writes the summary
 * merge-coverage.mjs would write so `--merge` can finish. An UNGUARDED call site reaches this the
 * same way a guarded one does, so the recording is what proves the wiring.
 */
export const LCOV = "TN:\nSF:scripts/a.mjs\nLF:10\nLH:8\nend_of_record\n";

export function recorder(root) {
  const calls = [];
  return {
    calls,
    clientRuns: () =>
      calls.filter((c) => c.command === "npm" && c.args.includes("gui/client")).length,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (!args.some((a) => String(a).endsWith("merge-coverage.mjs"))) return;
      // Model the real merge-coverage.mjs: it writes BOTH outputs, and it writes them wherever
      // `--out-dir` says. run-coverage points that at the staging directory, because the
      // canonical names mean "a run completed" — see scripts/coverage-outputs.mjs.
      const flag = args.indexOf("--out-dir");
      const outDir = flag === -1 ? path.join(root, "coverage") : String(args[flag + 1]);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "coverage-summary.json"), SUMMARY);
      writeFileSync(path.join(outDir, "lcov.info"), LCOV);
    },
  };
}
