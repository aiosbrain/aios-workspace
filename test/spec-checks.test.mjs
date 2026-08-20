import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assessScopeFence,
  resolveRubricPath,
  runDeterministicChecks,
} from "../scripts/spec-checks.mjs";
import { coreToolkitDir } from "../scripts/devtools-dispatch.mjs";

function sr18Blocks(specText) {
  return runDeterministicChecks(specText).some(
    (finding) => finding.ruleId === "SR18" && finding.severity === "blocker"
  );
}

test("SR18 ignores a per-file leave-unchanged note inside Scope", () => {
  const perFile = [
    "# Spec",
    "## Scope",
    "- `scripts/relay.mjs` — the gate hard-codes the rubric path; leave it unchanged.",
  ].join("\n");
  assert.equal(assessScopeFence(perFile).fenced, false);
  assert.equal(sr18Blocks(perFile), false);

  const classWide = "# Spec\n## Scope\nLeave all rendered pages unchanged.";
  assert.equal(assessScopeFence(classWide).fenced, true);
  assert.equal(sr18Blocks(classWide), true);
});

test("SR18 evaluates constraints nested beneath a scope heading", () => {
  const spec = [
    "# Spec",
    "## Scope",
    "**In:** the new page.",
    "### Constraints",
    "No change to any file that `/` renders.",
  ].join("\n");
  assert.equal(assessScopeFence(spec).fenced, true);
  assert.equal(sr18Blocks(spec), true);
});

// ── rubric resolution (AIO-686, copy-ledger row 13) ─────────────────────────────────────────────
// Fallback #3 resolves through the TOOLKIT contract, not a module-relative path. The old
// `SCRIPT_DIR/../..` form named the repo root only while this file lived in aios-workspace; from an
// installed @aiosbrain/aios-devtools it named the devtools root, which ships no rubric and must not
// vendor one. Resolution must also be LAZY: `getToolkit()` throws when no toolkit can be located, so
// the two paths that never need a toolkit must not pay for one.
//
// An unlocatable AIOS_TOOLKIT_DIR is the probe: if the locator were consulted, these would throw.

const specChecksUrl = new URL("../scripts/spec-checks.mjs", import.meta.url).href;

function bareRepo() {
  return mkdtempSync(path.join(tmpdir(), "spec-checks-bare-"));
}

function withEnv(value, fn) {
  const had = Object.hasOwn(process.env, "AIOS_TOOLKIT_DIR");
  const prev = process.env.AIOS_TOOLKIT_DIR;
  process.env.AIOS_TOOLKIT_DIR = value;
  try {
    return fn();
  } finally {
    if (had) process.env.AIOS_TOOLKIT_DIR = prev;
    else delete process.env.AIOS_TOOLKIT_DIR;
  }
}

test("an explicit --rubric is honoured verbatim and never consults the toolkit locator", () => {
  withEnv("/nonexistent-toolkit", () => {
    assert.equal(
      resolveRubricPath(bareRepo(), "/tmp/explicit-rubric.md"),
      "/tmp/explicit-rubric.md"
    );
  });
});

test("a repo-local rubric wins without consulting the toolkit locator", () => {
  const repo = bareRepo();
  const local = path.join(repo, ".claude", "rubrics", "spec-readiness.md");
  mkdirSync(path.dirname(local), { recursive: true });
  writeFileSync(local, "# local\n");
  withEnv("/nonexistent-toolkit", () => {
    assert.equal(resolveRubricPath(repo), local);
  });
});

test("a rubric-less repo falls back to the resolved toolkit's rubric, which exists", () => {
  const resolved = withEnv(coreToolkitDir(), () => resolveRubricPath(bareRepo()));
  assert.equal(resolved, path.join(coreToolkitDir(), ".claude", "rubrics", "spec-readiness.md"));
  assert.ok(existsSync(resolved), "the fallback must name a rubric that is actually there");
});

// `getToolkit()` is memoized process-wide (argv + env are read once, deliberately), so this case
// needs a FRESH process — in-process it would read whichever toolkit an earlier test resolved.
test("an unlocatable toolkit is an actionable error, not a bare rubric-not-found", () => {
  const probe = `
    import { resolveRubricPath } from ${JSON.stringify(specChecksUrl)};
    try { console.log("RESOLVED:" + resolveRubricPath(process.argv[1])); }
    catch (e) { console.log("THREW:" + e.message); }
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe, bareRepo()], {
    encoding: "utf8",
    env: { ...process.env, AIOS_TOOLKIT_DIR: "/nonexistent-toolkit" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /THREW:cannot locate the AIOS toolkit/);
  assert.match(r.stdout, /AIOS_TOOLKIT_DIR/, "the error must name the env var that fixes it");
  assert.doesNotMatch(r.stdout, /rubric not found/, "must not degrade into the old bare error");
});
