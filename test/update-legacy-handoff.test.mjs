import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fakeRegistryRoot, fakeWorkspace } from "./update-registry-fixtures.mjs";
import { vendorFromRegistry } from "../scripts/update/registry-root.mjs";
import { cmdUpdate } from "../scripts/update.mjs";

for (const flags of [
  ["--check"],
  ["--preview"],
  ["--no-pull"],
  ["--no-pull", "--force"],
  ["--no-install"],
]) {
  test(`format-2 rejects a legacy checkout handoff ${flags.join(" ")}`, async () => {
    const current = fakeRegistryRoot();
    const legacy = fakeRegistryRoot({ version: "0.12.0" });
    const repo = fakeWorkspace();
    const marker = path.join(repo, "legacy-updater-ran");
    try {
      writeFileSync(
        path.join(legacy.dir, "scripts/aios.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`
      );
      writeFileSync(
        path.join(legacy.dir, "scripts/update.mjs"),
        "// supports --vendor-apply-only, but only stamp format 1\n"
      );
      const git = (...args) => execFileSync("git", ["-C", legacy.dir, ...args], { stdio: "pipe" });
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("add", "-A");
      git("commit", "-qm", "legacy updater");
      await vendorFromRegistry(repo, { pm_tool: "none" }, [], current.root, {
        log() {},
        warn() {},
      });
      const stamp = readFileSync(path.join(repo, ".aios-toolkit-version"), "utf8");
      const result = await cmdUpdate(repo, { pm_tool: "none" }, ["--from", legacy.dir, ...flags]);
      assert.equal(result.applyAllowed, false);
      assert.notEqual(result.exitStatus, 0);
      assert.match(result.reasons.join(" "), /format-2 workspace requires a v2-or-newer updater/);
      assert.equal(existsSync(marker), false);
      assert.equal(readFileSync(path.join(repo, ".aios-toolkit-version"), "utf8"), stamp);
      assert.equal(
        git("worktree", "list", "--porcelain").toString().split("worktree ").length - 1,
        1
      );
    } finally {
      for (const p of [current.dir, legacy.dir, repo]) rmSync(p, { recursive: true, force: true });
    }
  });
}
