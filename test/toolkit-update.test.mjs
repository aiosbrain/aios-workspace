import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";
import {
  CI_WORKFLOW_MANAGED_PATHS,
  MANAGED_PATHS,
  PERSONAL_PATHS,
  SEED_IF_ABSENT,
  managedPathsForConfig,
  pmToolOf,
  pmToolPrunable,
  PM_TOOL_DEFAULT,
} from "../scripts/toolkit-manifest.mjs";
import { dirtyManagedPaths, mergeManaged, missingSeedPaths } from "../scripts/update.mjs";

// The overlay/merge mechanics live in toolkit-merge.test.mjs; this file covers the
// manifest invariants and the uncommitted-edit guard.

test("MANAGED_PATHS never overlaps PERSONAL_PATHS (no managed path is personal)", () => {
  const personal = new Set(PERSONAL_PATHS);
  for (const e of MANAGED_PATHS) {
    const top = e.dest.split("/")[0];
    // .claude is shared: managed .claude/* subpaths are fine, but never .claude/memory.
    assert.notEqual(e.dest, ".claude/memory");
    if (top !== ".claude" && top !== "scripts" && top !== "bin") {
      assert.ok(!personal.has(e.dest), `${e.dest} must not be a personal path`);
    }
  }
  // The CLI must be synced as the SHIM file, never the whole scripts/ dir.
  assert.ok(MANAGED_PATHS.some((e) => e.dest === "scripts/aios.mjs" && e.kind === "file"));
  assert.ok(!MANAGED_PATHS.some((e) => e.dest === "scripts" && e.kind === "dir"));
});

test("dirtyManagedPaths detects an uncommitted edit to a managed file", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-git-"));
  const git = (...a) => execFileSync("git", ["-C", ws, ...a], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    mkdirSync(path.join(ws, "validation"), { recursive: true });
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "v1");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Clean tree → nothing dirty.
    assert.equal(dirtyManagedPaths(ws).size, 0);
    // Local uncommitted edit → flagged.
    writeFileSync(path.join(ws, "validation/secret-patterns.txt"), "v1 + my edit");
    assert.ok(dirtyManagedPaths(ws).has("validation/secret-patterns.txt"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dirtyManagedPaths returns empty set outside a git repo (no guard, no throw)", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "aios-nogit-"));
  try {
    assert.equal(dirtyManagedPaths(ws).size, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CI workflow files are unmanaged when opted out and vendored only when explicitly enabled", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-ci-optin-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-ci-optin-"));
  const workflow = CI_WORKFLOW_MANAGED_PATHS.find(
    (entry) => entry.dest === ".github/workflows/scan-on-merge.yml"
  );
  assert.ok(workflow, "scan-on-merge workflow is conditionally managed");
  try {
    mkdirSync(path.dirname(path.join(tk, workflow.src)), { recursive: true });
    mkdirSync(path.dirname(path.join(ws, workflow.dest)), { recursive: true });
    writeFileSync(path.join(tk, workflow.src), "upstream workflow\n");
    writeFileSync(path.join(ws, workflow.dest), "existing workflow\n");

    const optedOut = managedPathsForConfig({ ci_workflow: "false" });
    assert.ok(!optedOut.some((entry) => entry.dest === workflow.dest));
    assert.equal(dirtyManagedPaths(ws, optedOut).has(workflow.dest), false);
    assert.deepEqual(mergeManaged(tk, tk, ws, undefined, { managedPaths: optedOut }).updated, []);
    assert.equal(readFileSync(path.join(ws, workflow.dest), "utf8"), "existing workflow\n");

    const optedIn = managedPathsForConfig({ ci_workflow: true });
    assert.ok(optedIn.some((entry) => entry.dest === workflow.dest));
    const fresh = mkdtempSync(path.join(tmpdir(), "aios-ws-ci-optin-fresh-"));
    try {
      const result = mergeManaged(tk, tk, fresh, undefined, { managedPaths: optedIn });
      assert.ok(result.created.includes(workflow.dest));
      assert.equal(readFileSync(path.join(fresh, workflow.dest), "utf8"), "upstream workflow\n");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged creates a SEED_IF_ABSENT file when the personal destination is absent", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-seed-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-seed-"));
  const seed = SEED_IF_ABSENT.find((e) => e.dest === ".aios/comms-config.json");
  assert.ok(seed, "comms config seed is declared");
  try {
    const starter = '{"channels":{},"sender":{"channel":null}}\n';
    mkdirSync(path.dirname(path.join(tk, seed.src)), { recursive: true });
    writeFileSync(path.join(tk, seed.src), starter);

    assert.deepEqual(missingSeedPaths(tk, ws), [seed.dest]);
    const result = mergeManaged(tk, tk, ws, undefined, {});

    assert.deepEqual(result.seeded, [seed.dest]);
    assert.equal(readFileSync(path.join(ws, seed.dest), "utf8"), starter);
    assert.deepEqual(missingSeedPaths(tk, ws), []);
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged never reads, merges, or overwrites an existing seed destination, even with --force", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-seed-existing-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-seed-existing-"));
  const seed = SEED_IF_ABSENT.find((e) => e.dest === ".aios/comms-config.json");
  assert.ok(seed, "comms config seed is declared");
  try {
    mkdirSync(path.dirname(path.join(tk, seed.src)), { recursive: true });
    mkdirSync(path.dirname(path.join(ws, seed.dest)), { recursive: true });
    writeFileSync(path.join(tk, seed.src), '{"channels":{}}\n');
    const personal = '{"channels":{"#private":"admin"}}\n';
    writeFileSync(path.join(ws, seed.dest), personal);

    const result = mergeManaged(tk, tk, ws, undefined, { force: true });

    assert.deepEqual(result.seeded, []);
    assert.equal(readFileSync(path.join(ws, seed.dest), "utf8"), personal);
    assert.ok(!existsSync(path.join(ws, `${seed.dest}.aios-incoming`)));
    assert.ok(!existsSync(path.join(ws, `${seed.dest}.aios-merge`)));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged refuses a seed whose personal parent is a symlink outside the workspace", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-seed-symlink-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-seed-symlink-"));
  const outside = mkdtempSync(path.join(tmpdir(), "aios-seed-outside-"));
  const seed = SEED_IF_ABSENT.find((e) => e.dest === ".aios/comms-config.json");
  assert.ok(seed, "comms config seed is declared");
  try {
    mkdirSync(path.dirname(path.join(tk, seed.src)), { recursive: true });
    writeFileSync(path.join(tk, seed.src), '{"channels":{}}\n');
    symlinkSync(outside, path.join(ws, ".aios"), "dir");

    assert.throws(
      () => missingSeedPaths(tk, ws),
      /parent path is not a real workspace directory \(\.aios\)/
    );
    assert.throws(
      () => mergeManaged(tk, tk, ws, undefined, {}),
      /refusing to seed \.aios\/comms-config\.json/
    );
    assert.ok(!existsSync(path.join(outside, "comms-config.json")));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- dir-entry `exclude` (AIO-351 dogfood: .claude/rules/access-control.md) ----

test("mergeManaged: an excluded dir-entry file is never overlaid and never conflicts", () => {
  const rulesEntry = MANAGED_PATHS.find((e) => e.dest === ".claude/rules");
  assert.ok(rulesEntry?.exclude?.includes("access-control.md"), "sanity: exclude is configured");

  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-excl-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-excl-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  try {
    // Toolkit at base: a synced file + the excluded, stamp-templated one.
    mkdirSync(path.join(tk, "scaffold/.claude/rules"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/rules/synced.md"), "V1\n");
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v1\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // Workspace: synced.md as-shipped; access-control.md personalized at scaffold time
    // (never came from a sync, so there's no matching baseline in the workspace copy).
    mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    writeFileSync(path.join(ws, ".claude/rules/synced.md"), "V1\n");
    writeFileSync(path.join(ws, ".claude/rules/access-control.md"), "PERSONALIZED tier table\n");

    // Toolkit evolves both files upstream.
    writeFileSync(path.join(tk, "scaffold/.claude/rules/synced.md"), "V2\n");
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v2\n");
    git("add", "-A");
    git("commit", "-qm", "head");

    const r = mergeManaged(tk, tk, ws, baseSha, {});

    // The excluded file is untouched — no overlay, no conflict, no sidecar files.
    assert.equal(
      readFileSync(path.join(ws, ".claude/rules/access-control.md"), "utf8"),
      "PERSONALIZED tier table\n"
    );
    assert.ok(!r.conflicts.some((c) => c.path === ".claude/rules/access-control.md"));
    assert.ok(!r.updated.includes(".claude/rules/access-control.md"));
    assert.ok(!r.created.includes(".claude/rules/access-control.md"));
    assert.ok(!r.deleted.includes(".claude/rules/access-control.md"));
    assert.ok(!existsSync(path.join(ws, ".claude/rules/access-control.md.aios-incoming")));
    assert.ok(!existsSync(path.join(ws, ".claude/rules/access-control.md.aios-merge")));

    // Meanwhile the non-excluded sibling in the same dir entry syncs normally.
    assert.ok(r.updated.includes(".claude/rules/synced.md"));
    assert.equal(readFileSync(path.join(ws, ".claude/rules/synced.md"), "utf8"), "V2\n");
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("mergeManaged: an excluded file present at the base sha is not propagated as deleted", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-excl-del-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-excl-del-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  try {
    mkdirSync(path.join(tk, "scaffold/.claude/rules"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/rules/access-control.md"), "TEMPLATE v1\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    writeFileSync(path.join(ws, ".claude/rules/access-control.md"), "PERSONALIZED\n");

    // Toolkit later removes its own template copy — should still never delete the
    // workspace's personalized file, because it was never synced in the first place.
    rmSync(path.join(tk, "scaffold/.claude/rules/access-control.md"));
    git("add", "-A");
    git("commit", "-qm", "head");

    const r = mergeManaged(tk, tk, ws, baseSha, {});
    assert.ok(existsSync(path.join(ws, ".claude/rules/access-control.md")));
    assert.ok(!r.deleted.includes(".claude/rules/access-control.md"));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---- pm_tool gating (AIO-844) ----

/** The three Linear-specific managed destinations this seam gates. */
const LINEAR_DESTS = [
  ".claude/rules/linear-factory.md",
  ".claude/skills/aios-linear",
  "docs/agentic-ergonomics/aios-issue-template.md",
];

test("pmToolOf defaults an absent/blank pm_tool to linear and honors any explicit value", () => {
  // Back-compat is the whole point: a workspace scaffolded before pm_tool existed has no key,
  // and must NOT be read as "this team uses no PM tool" — that would strip a working harness.
  assert.equal(pmToolOf({}), "linear");
  assert.equal(pmToolOf({ pm_tool: "" }), "linear");
  assert.equal(pmToolOf({ pm_tool: "   " }), "linear");
  assert.equal(pmToolOf(), "linear");
  assert.equal(PM_TOOL_DEFAULT, "linear");

  assert.equal(pmToolOf({ pm_tool: "clickup" }), "clickup");
  assert.equal(pmToolOf({ pm_tool: "none" }), "none");
  assert.equal(pmToolOf({ pm_tool: " clickup " }), "clickup");
});

test("managedPathsForConfig ships the Linear assets only when pm_tool selects linear", () => {
  const dests = (cfg) => new Set(managedPathsForConfig(cfg).map((e) => e.dest));

  for (const cfg of [{}, { pm_tool: "linear" }]) {
    const d = dests(cfg);
    for (const dest of LINEAR_DESTS) assert.ok(d.has(dest), `${dest} missing for ${cfg.pm_tool}`);
  }

  for (const pm_tool of ["clickup", "none"]) {
    const d = dests({ pm_tool });
    for (const dest of LINEAR_DESTS) assert.ok(!d.has(dest), `${dest} leaked into ${pm_tool}`);
    // Everything else is untouched — the gate must move exactly three entries and no others,
    // so switching PM tool can never quietly stop syncing unrelated governance.
    const linear = managedPathsForConfig({ pm_tool: "linear" });
    assert.equal(managedPathsForConfig({ pm_tool }).length, linear.length - LINEAR_DESTS.length);
    for (const e of linear) {
      if (!LINEAR_DESTS.includes(e.dest)) assert.ok(d.has(e.dest), `${e.dest} lost`);
    }
  }

  // Composes with the pre-existing ci_workflow gate rather than replacing it.
  const ci = dests({ pm_tool: "clickup", ci_workflow: "true" });
  for (const e of CI_WORKFLOW_MANAGED_PATHS) assert.ok(ci.has(e.dest));
});

test("pmToolPrunable names exactly the assets this pm_tool no longer selects", () => {
  assert.deepEqual(pmToolPrunable({ pm_tool: "linear" }), []);
  assert.deepEqual(pmToolPrunable({}), []);
  for (const pm_tool of ["clickup", "none"]) {
    assert.deepEqual(
      pmToolPrunable({ pm_tool })
        .map((e) => e.dest)
        .sort(),
      [...LINEAR_DESTS].sort()
    );
  }
});

test("every managed src resolves in the toolkit tree, including the non-scaffold ones", () => {
  // Two AIO-844 entries deliberately source the canonical file rather than a scaffold/ copy
  // (no duplicate to keep byte-identical). A typo there fails silently at runtime — mergeManaged
  // skips an entry whose src is absent — so assert it here instead.
  const root = path.join(import.meta.dirname, "..");
  for (const e of [...MANAGED_PATHS, ...CI_WORKFLOW_MANAGED_PATHS]) {
    assert.ok(existsSync(path.join(root, e.src)), `MANAGED_PATHS src does not exist: ${e.src}`);
  }
  const skills = MANAGED_PATHS.find((e) => e.dest === ".claude/skills");
  assert.ok(skills?.exclude?.includes("aios-linear"), "aios-linear must be excluded by name");
  const rules = MANAGED_PATHS.find((e) => e.dest === ".claude/rules");
  assert.ok(rules?.exclude?.includes("linear-factory.md"));
  // Specific-before-dir ordering: toolkit-contribute.mjs returns on FIRST match, so a split-out
  // entry listed after its covering dir entry would be misreported as `excluded`.
  const idx = (dest) => MANAGED_PATHS.findIndex((e) => e.dest === dest);
  assert.ok(idx(".claude/skills/aios-linear") < idx(".claude/skills"));
  assert.ok(idx(".claude/rules/linear-factory.md") < idx(".claude/rules"));
  assert.ok(idx(".claude/rubrics/spec-readiness.md") < idx(".claude/rubrics"));
});

test("a dir named in `exclude` prunes its whole subtree, including files added to it later", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-dirx-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-dirx-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  const entry = {
    dest: ".claude/skills",
    src: "scaffold/.claude/skills",
    kind: "dir",
    exclude: ["gated"],
  };
  try {
    mkdirSync(path.join(tk, "scaffold/.claude/skills/gated"), { recursive: true });
    mkdirSync(path.join(tk, "scaffold/.claude/skills/kept"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/skills/gated/SKILL.md"), "GATED v1\n");
    writeFileSync(path.join(tk, "scaffold/.claude/skills/kept/SKILL.md"), "KEPT v1\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // The footgun this replaces file-by-file excludes to avoid: a file added to the excluded
    // directory AFTER the exclude was written must still be excluded, with no manifest edit.
    writeFileSync(path.join(tk, "scaffold/.claude/skills/gated/added-later.mjs"), "leak?\n");
    writeFileSync(path.join(tk, "scaffold/.claude/skills/kept/SKILL.md"), "KEPT v2\n");
    git("add", "-A");
    git("commit", "-qm", "head");

    const r = mergeManaged(tk, tk, ws, baseSha, { managedPaths: [entry] });
    assert.ok(!existsSync(path.join(ws, ".claude/skills/gated")), "excluded subtree was vendored");
    assert.ok(!existsSync(path.join(ws, ".claude/skills/gated/added-later.mjs")));
    assert.ok(r.created.includes(".claude/skills/kept/SKILL.md"));
    assert.equal(readFileSync(path.join(ws, ".claude/skills/kept/SKILL.md"), "utf8"), "KEPT v2\n");

    // And a file REMOVED from an excluded subtree is never reported as an upstream deletion.
    rmSync(path.join(tk, "scaffold/.claude/skills/gated/SKILL.md"));
    git("add", "-A");
    git("commit", "-qm", "drop");
    const r2 = mergeManaged(tk, tk, ws, baseSha, { managedPaths: [entry] });
    assert.ok(!r2.deleted.some((p) => p.startsWith(".claude/skills/gated")));
    assert.ok(!r2.conflicts.some((cf) => cf.path.startsWith(".claude/skills/gated")));
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("prune removes a de-selected asset only while it still matches the toolkit copy", () => {
  const tk = mkdtempSync(path.join(tmpdir(), "aios-tk-prune-"));
  const ws = mkdtempSync(path.join(tmpdir(), "aios-ws-prune-"));
  const git = (...a) => execFileSync("git", ["-C", tk, ...a], { encoding: "utf8" });
  const ruleEntry = {
    dest: ".claude/rules/linear-factory.md",
    src: "scaffold/.claude/rules/linear-factory.md",
    kind: "file",
    pmTool: "linear",
  };
  const skillEntry = {
    dest: ".claude/skills/aios-linear",
    src: "scaffold/.claude/skills/aios-linear",
    kind: "dir",
    pmTool: "linear",
  };
  try {
    mkdirSync(path.join(tk, "scaffold/.claude/rules"), { recursive: true });
    mkdirSync(path.join(tk, "scaffold/.claude/skills/aios-linear"), { recursive: true });
    writeFileSync(path.join(tk, "scaffold/.claude/rules/linear-factory.md"), "RULE\n");
    writeFileSync(path.join(tk, "scaffold/.claude/skills/aios-linear/SKILL.md"), "SKILL\n");
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // A workspace that previously ran with pm_tool: linear, now switched away. The rule is
    // untouched (the toolkit's to remove); the skill file has been edited (the owner's to keep).
    mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
    mkdirSync(path.join(ws, ".claude/skills/aios-linear"), { recursive: true });
    writeFileSync(path.join(ws, ".claude/rules/linear-factory.md"), "RULE\n");
    writeFileSync(path.join(ws, ".claude/skills/aios-linear/SKILL.md"), "SKILL + my notes\n");

    // dryRun first: --check/--preview must report the intent and write nothing.
    const dry = mergeManaged(tk, tk, ws, baseSha, {
      managedPaths: [],
      prunablePaths: [ruleEntry, skillEntry],
      dryRun: true,
    });
    assert.deepEqual(dry.pruned, [".claude/rules/linear-factory.md"]);
    assert.deepEqual(dry.prunedKept, [".claude/skills/aios-linear/SKILL.md"]);
    assert.ok(
      existsSync(path.join(ws, ".claude/rules/linear-factory.md")),
      "dryRun deleted a file"
    );

    const r = mergeManaged(tk, tk, ws, baseSha, {
      managedPaths: [],
      prunablePaths: [ruleEntry, skillEntry],
    });
    assert.deepEqual(r.pruned, [".claude/rules/linear-factory.md"]);
    assert.ok(!existsSync(path.join(ws, ".claude/rules/linear-factory.md")));
    // The edited file survives, is reported, and its directory is NOT swept away with it.
    assert.deepEqual(r.prunedKept, [".claude/skills/aios-linear/SKILL.md"]);
    assert.equal(
      readFileSync(path.join(ws, ".claude/skills/aios-linear/SKILL.md"), "utf8"),
      "SKILL + my notes\n"
    );
    // The rule's own parent belongs to other content — a file entry never sweeps it.
    assert.ok(existsSync(path.join(ws, ".claude/rules")));

    // Re-running is a no-op: nothing left to prune, and no phantom entries.
    const again = mergeManaged(tk, tk, ws, baseSha, {
      managedPaths: [],
      prunablePaths: [ruleEntry, skillEntry],
    });
    assert.deepEqual(again.pruned, []);
    assert.deepEqual(again.prunedKept, [".claude/skills/aios-linear/SKILL.md"]);

    // Once the owner's edit is reverted, the now-empty skill dir goes too.
    writeFileSync(path.join(ws, ".claude/skills/aios-linear/SKILL.md"), "SKILL\n");
    const last = mergeManaged(tk, tk, ws, baseSha, {
      managedPaths: [],
      prunablePaths: [ruleEntry, skillEntry],
    });
    assert.deepEqual(last.pruned, [".claude/skills/aios-linear/SKILL.md"]);
    assert.ok(!existsSync(path.join(ws, ".claude/skills/aios-linear")), "empty dir left behind");
  } finally {
    rmSync(tk, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
