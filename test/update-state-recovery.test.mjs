import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fakeRegistryRoot, fakeWorkspace, BUILD_SHA } from "./update-registry-fixtures.mjs";
import { prepareV2State, commitV2State, writeV2State } from "../scripts/update/state-plan.mjs";
import { writeBaseStore, verifiedBaseIndex } from "../scripts/update/base-store.mjs";
import { readStamp, stampBody } from "../scripts/update/stamp.mjs";
import { vendorFromRegistry, chooseBaseResolver } from "../scripts/update/registry-root.mjs";
import { rollbackFromRecord, recordRollbackIfUpgrading } from "../scripts/update/rollback.mjs";
import { withUpdateLock } from "../scripts/update/lock.mjs";
import { runMigration, resolveUserConfigPath } from "../scripts/cli.mjs";
import { managedPathsForConfig } from "../scripts/toolkit-manifest.mjs";

const cfg = { pm_tool: "none" };
const io = { log: () => {}, warn: () => {} };
const discard = { recursive: true, force: true };
const stampFile = (repo) => path.join(repo, ".aios-toolkit-version");
const options = (root) => ({
  srcDir: root.dir,
  sha: root.sha,
  meta: { version: root.version, brainApi: "1.24" },
  stampSource: `pkg:@aiosbrain/aios@${root.version}`,
  managedPaths: managedPathsForConfig(cfg),
  packageVersion: root.version,
});
const vendor = (repo, root) => vendorFromRegistry(repo, cfg, [], root, io);

for (const state of ["discovered", "snapshotted", "staged", "validated", "committed"]) {
  test(`workspace migration resumes a matching ${state} transition and retains exact bases`, async () => {
    const old = fakeRegistryRoot({ version: "0.12.0" });
    const next = fakeRegistryRoot();
    const repo = fakeWorkspace();
    try {
      const before = stampBody("a".repeat(40), { version: "0.12.0" }, old.dir);
      writeFileSync(stampFile(repo), before);
      await recordRollbackIfUpgrading(repo);
      const plan = prepareV2State(repo, options(next.root));
      await writeBaseStore(repo, plan.files, { packageVersion: "2.0.0", prune: false });
      await assert.rejects(
        runMigration({
          configPath: stampFile(repo),
          packageRecord: { name: "@aiosbrain/aios", version: "2.0.0" },
          stage: () => plan.body,
          validate: () => {},
          interrupt: (at) => {
            if (at === state) throw new Error("power loss");
          },
        })
      );
      if (state !== "committed") assert.equal(readFileSync(stampFile(repo), "utf8"), before);
      const result = await vendor(repo, next.root);
      assert.equal(result.exitStatus, 0);
      assert.equal(readStamp(repo).format, 2);
      verifiedBaseIndex(repo, readStamp(repo));
      assert.equal(existsSync(`${stampFile(repo)}.migration.json`), false);
      const after = readFileSync(stampFile(repo), "utf8");
      await vendor(repo, next.root);
      assert.equal(readFileSync(stampFile(repo), "utf8"), after);
    } finally {
      for (const p of [old.dir, next.dir, repo]) rmSync(p, discard);
    }
  });
}

test("index publication cannot replace the bases named by the old live stamp", async () => {
  const first = fakeRegistryRoot();
  const second = fakeRegistryRoot({
    version: "2.0.1",
    sha: "c".repeat(40),
    rules: { "one.md": "new rule\n" },
  });
  const repo = fakeWorkspace();
  try {
    await vendor(repo, first.root);
    const oldStamp = readStamp(repo);
    const oldIndex = verifiedBaseIndex(repo, oldStamp);
    const plan = prepareV2State(repo, options(second.root));
    await writeBaseStore(repo, plan.files, { packageVersion: "2.0.1", prune: false });
    assert.deepEqual(verifiedBaseIndex(repo, oldStamp), oldIndex);
    assert.equal(
      chooseBaseResolver(repo, second.dir, oldStamp.baseSha, { registry: true }).base(
        "scaffold/.claude/rules/one.md",
        ".claude/rules/one.md"
      ),
      "rule one v1\nshared tail\n"
    );
    // A concurrent/external state change is terminal and is never caught and retried.
    writeFileSync(stampFile(repo), oldStamp.raw.replace("synced-at ", "synced-at changed-"));
    const changed = readFileSync(stampFile(repo), "utf8");
    await assert.rejects(commitV2State(plan), /state changed after preflight/);
    assert.equal(readFileSync(stampFile(repo), "utf8"), changed);
  } finally {
    for (const p of [first.dir, second.dir, repo]) rmSync(p, discard);
  }
});

test("missing or corrupt v2 bases refuse before managed writes", async () => {
  const first = fakeRegistryRoot();
  const second = fakeRegistryRoot({ version: "2.0.1", rules: { "added.md": "must not appear\n" } });
  const repo = fakeWorkspace();
  try {
    await vendor(repo, first.root);
    const stamp = readStamp(repo);
    const index = verifiedBaseIndex(repo, stamp);
    const entry = Object.values(index.entries)[0];
    rmSync(path.join(repo, ".aios/toolkit-bases", entry.hash));
    await assert.rejects(vendor(repo, second.root), /Missing or corrupt merge base/);
    assert.equal(readFileSync(stampFile(repo), "utf8"), stamp.raw);
    assert.equal(existsSync(path.join(repo, ".claude/rules/added.md")), false);
  } finally {
    for (const p of [first.dir, second.dir, repo]) rmSync(p, discard);
  }
});

test("a symlinked ignore file refuses before vendoring", async () => {
  const next = fakeRegistryRoot();
  const repo = fakeWorkspace();
  const external = mkdtempSync(path.join(tmpdir(), "ignore-target-"));
  try {
    const target = path.join(external, "ignore");
    writeFileSync(target, "private\n");
    symlinkSync(target, path.join(repo, ".gitignore"));
    await assert.rejects(vendor(repo, next.root), /symlink/);
    assert.equal(existsSync(path.join(repo, ".claude/rules/one.md")), false);
    assert.equal(readFileSync(target, "utf8"), "private\n");
  } finally {
    for (const p of [next.dir, repo, external]) rmSync(p, discard);
  }
});

test("dirty managed changes keep the prior stamp and merge base until committed", async () => {
  const first = fakeRegistryRoot();
  const second = fakeRegistryRoot({
    version: "2.0.1",
    sha: "c".repeat(40),
    rules: { "one.md": "rule one v2\nshared tail\n" },
  });
  const repo = fakeWorkspace();
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await vendor(repo, first.root);
    git("add", "-A");
    git("commit", "-qm", "baseline");
    const before = readStamp(repo);
    writeFileSync(
      path.join(repo, ".claude/rules/one.md"),
      "rule one v1\nshared tail\nlocal note\n"
    );
    const result = await vendor(repo, second.root);
    assert.match(result.reasons.join(" "), /skipped/);
    assert.equal(readFileSync(stampFile(repo), "utf8"), before.raw);
    git("add", "-A");
    git("commit", "-qm", "customize");
    await vendor(repo, second.root);
    assert.equal(readStamp(repo).baseSha, second.root.sha);
    assert.equal(
      readFileSync(path.join(repo, ".claude/rules/one.md"), "utf8"),
      "rule one v2\nshared tail\nlocal note\n"
    );
  } finally {
    for (const p of [first.dir, second.dir, repo]) rmSync(p, discard);
  }
});

test("an active workspace writer excludes a second update and releases its lock", async () => {
  const repo = fakeWorkspace();
  try {
    await withUpdateLock(repo, async () => {
      await assert.rejects(
        withUpdateLock(repo, () => assert.fail("second writer ran")),
        /Another workspace update/
      );
    });
    await withUpdateLock(repo, () => {});
    assert.equal(existsSync(path.join(repo, ".aios/update.lock")), false);
  } finally {
    rmSync(repo, discard);
  }
});

test("rollback refuses escaped paths and preserves newer global configuration", async () => {
  const old = fakeRegistryRoot({ version: "0.12.0" });
  const repo = fakeWorkspace();
  const configDir = mkdtempSync(path.join(tmpdir(), "rollback-config-"));
  const priorConfigDir = process.env.AIOS_CONFIG_DIR;
  process.env.AIOS_CONFIG_DIR = configDir;
  try {
    const config = resolveUserConfigPath({});
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, '{"schemaVersion":2}\n');
    writeFileSync(stampFile(repo), stampBody("a".repeat(40), { version: "0.12.0" }, old.dir));
    await recordRollbackIfUpgrading(repo);
    const recordFile = path.join(repo, ".aios/rollback.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    const original = readFileSync(stampFile(repo), "utf8");
    writeFileSync(recordFile, JSON.stringify({ ...record, stampPath: "../outside" }));
    await assert.rejects(rollbackFromRecord(repo, { interactive: false }), /invalid state paths/);
    writeFileSync(
      recordFile,
      JSON.stringify({ ...record, reinstall: { display: "safe", argv: ["sh", "-c", "exit 99"] } })
    );
    writeFileSync(config, '{"schemaVersion":2,"newSetting":true}\n');
    await assert.rejects(rollbackFromRecord(repo, { interactive: false }), /configuration changed/);
    assert.equal(readFileSync(stampFile(repo), "utf8"), original);
    assert.match(readFileSync(config, "utf8"), /newSetting/);
    writeFileSync(config, record.configSnapshot);
    const result = await rollbackFromRecord(repo, { interactive: false });
    assert.equal(result.previousPackage, "@aiosbrain/aios@0.12.0");
  } finally {
    if (priorConfigDir === undefined) delete process.env.AIOS_CONFIG_DIR;
    else process.env.AIOS_CONFIG_DIR = priorConfigDir;
    for (const p of [old.dir, repo, configDir]) rmSync(p, discard);
  }
});

for (const state of ["validated", "committed"]) {
  test(`invalid ${state} stamp transition preserves recovery evidence`, async () => {
    const { runMigration } = await import("../scripts/cli/migration.mjs");
    const { dir: srcDir } = fakeRegistryRoot();
    const repo = fakeWorkspace();
    const stampPath = path.join(repo, ".aios-toolkit-version");
    try {
      writeFileSync(stampPath, `${"a".repeat(40)}\ntoolkit-version 0.12.0\n`);
      await assert.rejects(
        runMigration({
          configPath: stampPath,
          stage: () => `${"c".repeat(40)}\nstamp-format 2\nmanifest-digest stale\n`,
          validate: () => {},
          interrupt: (at) => {
            if (at === state) throw new Error("fixture interruption");
          },
        })
      );
      const before = readFileSync(stampPath, "utf8");
      await assert.rejects(
        writeV2State(repo, {
          srcDir,
          sha: BUILD_SHA,
          meta: { version: "2.0.0", brainApi: "1.24" },
          stampSource: "pkg:@aiosbrain/aios@2.0.0",
          managedPaths: [{ src: "scaffold/.claude/rules", dest: ".claude/rules", kind: "dir" }],
        })
      );
      assert.equal(readFileSync(stampPath, "utf8"), before);
      assert.ok(existsSync(`${stampPath}.migration.json`));
    } finally {
      rmSync(srcDir, discard);
      rmSync(repo, discard);
    }
  });
}
