import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fakeRegistryRoot, fakeWorkspace } from "./update-registry-fixtures.mjs";
import { vendorFromRegistry } from "../scripts/update/registry-root.mjs";
import { stampBody, readStamp } from "../scripts/update/stamp.mjs";

const cfg = { pm_tool: "none" };
const io = { log() {}, warn() {} };
const put = (root, rel, content) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};

for (const mode of ["v1", "v2-before", "v2-after"]) {
  const format = mode === "v1" ? 1 : 2;
  test(`installed connector skills migrate from ${mode} while preserving local additions`, async () => {
    const old = fakeRegistryRoot({ version: format === 1 ? "0.12.0" : "2.0.0" });
    const next = fakeRegistryRoot({ version: "2.0.1", sha: "c".repeat(40) });
    const repo = fakeWorkspace();
    try {
      for (const name of ["linear-direct", "slack-personal"]) {
        const src = `scaffold/.claude/descriptors/skills/${name}`;
        put(old.dir, `${src}/SKILL.md`, "legacy route\nshared instructions\n");
        put(old.dir, `${src}/activity.mjs`, "// untouched retired client\n");
        put(next.dir, `${src}/SKILL.md`, "canonical aios route\nshared instructions\n");
      }
      if (mode === "v2-before") {
        for (const name of ["linear-direct", "slack-personal"]) {
          put(repo, `.claude/skills/${name}/SKILL.md`, "legacy route\nshared instructions\n");
          put(repo, `.claude/skills/${name}/activity.mjs`, "// untouched retired client\n");
        }
      }
      if (format === 1) {
        put(
          repo,
          ".aios-toolkit-version",
          stampBody("a".repeat(40), { version: "0.12.0" }, old.dir)
        );
      } else {
        // Connect AFTER seeding v2: installed destinations have no dedicated base yet.
        await vendorFromRegistry(repo, cfg, [], old.root, io);
      }
      for (const name of ["linear-direct", "slack-personal"]) {
        const dest = `.claude/skills/${name}`;
        put(repo, `${dest}/SKILL.md`, "legacy route\nshared instructions\n\nlocal policy\n");
        put(repo, `${dest}/activity.mjs`, "// untouched retired client\n");
        put(repo, `${dest}/personal.mjs`, "// personal client\n");
      }
      const result = await vendorFromRegistry(repo, cfg, [], next.root, io);
      assert.deepEqual(result.reasons, []);
      for (const name of ["linear-direct", "slack-personal"]) {
        const dest = `.claude/skills/${name}`;
        assert.equal(
          readFileSync(path.join(repo, dest, "SKILL.md"), "utf8"),
          "canonical aios route\nshared instructions\n\nlocal policy\n"
        );
        assert.equal(existsSync(path.join(repo, dest, "activity.mjs")), false);
        assert.equal(
          readFileSync(path.join(repo, dest, "personal.mjs"), "utf8"),
          "// personal client\n"
        );
      }
      const stamp = readStamp(repo).raw;
      await vendorFromRegistry(repo, cfg, [], next.root, io);
      assert.equal(readStamp(repo).raw, stamp);
    } finally {
      for (const p of [old.dir, next.dir, repo]) rmSync(p, { recursive: true, force: true });
    }
  });
}

test("descriptor updates do not install disconnected connector skills", async () => {
  const next = fakeRegistryRoot();
  const repo = fakeWorkspace();
  try {
    put(
      next.dir,
      "scaffold/.claude/descriptors/skills/linear-direct/SKILL.md",
      "canonical route\n"
    );
    await vendorFromRegistry(repo, cfg, [], next.root, io);
    assert.equal(existsSync(path.join(repo, ".claude/skills/linear-direct")), false);
  } finally {
    for (const p of [next.dir, repo]) rmSync(p, { recursive: true, force: true });
  }
});
