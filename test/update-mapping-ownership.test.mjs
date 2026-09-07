import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fakeRegistryRoot, fakeWorkspace } from "./update-registry-fixtures.mjs";
import { vendorFromRegistry } from "../scripts/update/registry-root.mjs";
import { prepareV2State } from "../scripts/update/state-plan.mjs";
const put = (root, rel, body) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};

test("repeat vendoring preserves exact-file ownership while deleting only untouched directory bases", async () => {
  const source = fakeRegistryRoot(),
    repo = fakeWorkspace();
  const rubric = ".claude/rubrics/spec-readiness.md";
  try {
    put(source.dir, rubric, "required rubric\n");
    for (const name of ["removed", "edited"])
      put(source.dir, `scaffold/.claude/rubrics/${name}.md`, "base\n");
    await vendorFromRegistry(repo, { pm_tool: "none" }, [], source.root, { log() {}, warn() {} });
    await vendorFromRegistry(repo, { pm_tool: "none" }, [], source.root, { log() {}, warn() {} });
    assert.equal(readFileSync(path.join(repo, rubric), "utf8"), "required rubric\n");
    put(repo, ".claude/rubrics/edited.md", "personal edit\n");
    for (const name of ["removed", "edited"])
      rmSync(path.join(source.dir, `scaffold/.claude/rubrics/${name}.md`));
    await vendorFromRegistry(repo, { pm_tool: "none" }, [], source.root, { log() {}, warn() {} });
    assert.equal(readFileSync(path.join(repo, rubric), "utf8"), "required rubric\n");
    assert.equal(existsSync(path.join(repo, ".claude/rubrics/removed.md")), false);
    assert.equal(
      readFileSync(path.join(repo, ".claude/rubrics/edited.md"), "utf8"),
      "personal edit\n"
    );
    await vendorFromRegistry(repo, { pm_tool: "none" }, [], source.root, { log() {}, warn() {} });
    assert.equal(readFileSync(path.join(repo, rubric), "utf8"), "required rubric\n");
  } finally {
    for (const p of [source.dir, repo]) rmSync(p, { recursive: true, force: true });
  }
});

test("state planning rejects ambiguous sources before any state writes", () => {
  const source = fakeRegistryRoot(),
    repo = fakeWorkspace();
  try {
    put(source.dir, "a", "same bytes");
    put(source.dir, "b", "same bytes");
    const opts = {
      srcDir: source.dir,
      sha: source.root.sha,
      meta: { version: "2.0.0" },
      stampSource: source.dir,
      managedPaths: ["a", "b"].map((src) => ({ src, dest: "target", kind: "file" })),
    };
    assert.throws(() => prepareV2State(repo, opts), /Ambiguous managed destination/);
    assert.equal(existsSync(path.join(repo, ".aios-toolkit-version")), false);
    assert.equal(existsSync(path.join(repo, ".aios/toolkit-bases")), false);
    const single = { ...opts, managedPaths: [opts.managedPaths[0]] };
    const duplicated = {
      ...single,
      managedPaths: [single.managedPaths[0], single.managedPaths[0]],
    };
    assert.equal(prepareV2State(repo, duplicated).files.length, 1);
    assert.equal(prepareV2State(repo, duplicated).digest, prepareV2State(repo, single).digest);
  } finally {
    for (const p of [source.dir, repo]) rmSync(p, { recursive: true, force: true });
  }
});
