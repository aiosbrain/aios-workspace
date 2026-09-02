/**
 * update-stamp-v2.test.mjs — AIO-635 Decisions 1 & 5: stamp format 2, the
 * content-addressed base store, the registry-root vendor flow, and rollback.
 *
 * The registry flow is exercised IN-PROCESS through vendorFromRegistry against a fake
 * installed package (marker-complete non-git dir + build.json), with a PATH `git` spy
 * proving zero git invocations ever name the source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  chmodSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { stampBody, readStamp, readStampBaseSha, STAMP_FORMAT } from "../scripts/update/stamp.mjs";
import {
  readBaseIndex,
  baseFromStore,
  writeBaseStore,
  manifestDigest,
  sha256hex,
  BASE_STORE_DIR,
} from "../scripts/update/base-store.mjs";
import {
  vendorFromRegistry,
  recordRollbackIfUpgrading,
  rollbackFromRecord,
  ROLLBACK_FILE,
} from "../scripts/update/registry-root.mjs";

const discard = { recursive: true, force: true };
const BUILD_SHA = "b".repeat(40);
const NOOP_IO = { log: () => {}, warn: () => {} };

// The fixtures ship a minimal managed surface (the shim file entry + the .claude/rules
// dir entry); vendorFromRegistry walks the REAL manifest and skips absent srcs.

function fakeRegistryRoot({ version = "2.0.0", sha = BUILD_SHA, rules = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "regroot-"));
  mkdirSync(path.join(dir, "scaffold", "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "scaffold", ".claude", "rules"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "toolkit-manifest.mjs"), "// marker\n");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@aiosbrain/aios", version })
  );
  writeFileSync(path.join(dir, "build.json"), JSON.stringify({ sha, version }));
  writeFileSync(path.join(dir, "scaffold", "scripts", "aios.mjs"), "// shim v2\n");
  const allRules = { "one.md": "rule one v1\nshared tail\n", ...rules };
  for (const [name, content] of Object.entries(allRules)) {
    writeFileSync(path.join(dir, "scaffold", ".claude", "rules", name), content);
  }
  // docs/brain-api.md so toolkitMeta can read a brain-api version.
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "brain-api.md"), "**API version:** 1.24\n");
  return { dir, root: { dir, kind: "registry", version, sha } };
}

function fakeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "regws-"));
  writeFileSync(path.join(dir, "aios.yaml"), "owner: t\npm_tool: none\n");
  return dir;
}

const vendorArgs = [];
const cfg = { pm_tool: "none" };

async function vendor(repo, root) {
  return vendorFromRegistry(repo, cfg, vendorArgs, root.root ?? root, NOOP_IO);
}

/** Hash the workspace tree with the stamp's synced-at line masked. */
function treeHash(repo) {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        let content = readFileSync(abs, "utf8");
        if (name === ".aios-toolkit-version")
          content = content.replace(/^synced-at .+$/m, "synced-at MASKED");
        if (name === "rollback.json")
          content = content.replace(/"recordedAt": ".+"/, '"recordedAt": "MASKED"');
        h.update(path.relative(repo, abs)).update("\0").update(content).update("\0");
      }
    }
  };
  walk(repo);
  return h.digest("hex");
}

test("stampBody v2 round-trips and stays v1-readable; the ratchet always writes format 2", () => {
  const meta = { version: "2.0.0", brainApi: "1.24", label: "v2.0.0" };
  const body = stampBody("c".repeat(40), meta, "pkg:@aiosbrain/aios@2.0.0", {
    manifestDigest: "sha256:deadbeef",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "stamp-"));
  try {
    writeFileSync(path.join(dir, ".aios-toolkit-version"), body);
    // v1 reader contract: line 1 is the full sha.
    assert.equal(readStampBaseSha(dir), "c".repeat(40));
    const s = readStamp(dir);
    assert.equal(s.format, STAMP_FORMAT);
    assert.equal(s.package, "@aiosbrain/aios");
    assert.equal(s.packageVersion, "2.0.0");
    assert.equal(s.packageIntegrity, "unverified");
    assert.equal(s.manifestDigest, "sha256:deadbeef");
    assert.equal(s.baseStore, ".aios/toolkit-bases");
    assert.equal(s.source, "pkg:@aiosbrain/aios@2.0.0");
    // A v1-shaped stamp (no v2 arg) parses as format 1 — the compat read path.
    writeFileSync(path.join(dir, ".aios-toolkit-version"), stampBody("d".repeat(40), meta, "/x"));
    assert.equal(readStamp(dir).format, 1);
  } finally {
    rmSync(dir, discard);
  }
});

test("base store: write, resolve by dest, verify content hash, prune unreferenced blobs", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "store-"));
  try {
    const files = [
      { destRel: "a.md", srcRel: "scaffold/a.md", content: "alpha\n" },
      { destRel: "b.md", srcRel: "scaffold/b.md", content: "beta\n" },
    ];
    await writeBaseStore(repo, files, { packageVersion: "2.0.0" });
    const index = readBaseIndex(repo);
    assert.equal(Object.keys(index.entries).length, 2);
    assert.equal(baseFromStore(repo, index, "a.md"), "alpha\n");
    assert.equal(baseFromStore(repo, index, "missing.md"), undefined);
    // Corrupt a blob: hash mismatch must read as NO base (fallback), never wrong bytes.
    writeFileSync(path.join(repo, BASE_STORE_DIR, index.entries["a.md"].hash), "tampered\n");
    assert.equal(baseFromStore(repo, index, "a.md"), undefined);
    // Re-write with only b.md — a's blob is pruned.
    await writeBaseStore(repo, [files[1]], { packageVersion: "2.0.1" });
    assert.ok(!existsSync(path.join(repo, BASE_STORE_DIR, index.entries["a.md"].hash)));
    // digest is order-independent.
    assert.equal(manifestDigest(files), manifestDigest([...files].reverse()));
  } finally {
    rmSync(repo, discard);
  }
});

test("registry vendor: fresh apply writes files, store, and a format-2 stamp LAST — with zero git calls naming the source", async () => {
  const { dir: srcDir, root } = fakeRegistryRoot();
  const repo = fakeWorkspace();
  const gitSpyDir = mkdtempSync(path.join(tmpdir(), "gitspy-"));
  const gitLog = path.join(gitSpyDir, "git.log");
  writeFileSync(
    path.join(gitSpyDir, "git"),
    `#!/bin/sh\nprintf '%s ' "$@" >> ${JSON.stringify(gitLog)}\nprintf '\\n' >> ${JSON.stringify(gitLog)}\nexit 1\n`
  );
  chmodSync(path.join(gitSpyDir, "git"), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${gitSpyDir}${path.delimiter}${path.dirname(process.execPath)}`;
  process.env.AIOS_UPDATE_OFFLINE = "1";
  try {
    const r = await vendor(repo, root);
    assert.equal(r.exitStatus, 0);
    assert.ok(r.changedCount >= 2, "vendored the managed surface");
    assert.equal(readFileSync(path.join(repo, "scripts", "aios.mjs"), "utf8"), "// shim v2\n");
    const s = readStamp(repo);
    assert.equal(s.format, 2);
    assert.equal(s.baseSha, BUILD_SHA, "line 1 is the package build sha");
    assert.equal(s.source, "pkg:@aiosbrain/aios@2.0.0");
    const index = readBaseIndex(repo);
    assert.ok(index.entries["scripts/aios.mjs"]);
    assert.equal(baseFromStore(repo, index, "scripts/aios.mjs"), "// shim v2\n");
    const log = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
    assert.ok(!log.includes(srcDir), `git was invoked against the source:\n${log}`);
  } finally {
    process.env.PATH = prevPath;
    delete process.env.AIOS_UPDATE_OFFLINE;
    rmSync(srcDir, discard);
    rmSync(repo, discard);
    rmSync(gitSpyDir, discard);
  }
});

test("registry vendor: byte-stable re-entry, clean 3-way merge of a local edit, and conflict sidecars", async () => {
  process.env.AIOS_UPDATE_OFFLINE = "1";
  const first = fakeRegistryRoot();
  const repo = fakeWorkspace();
  try {
    await vendor(repo, first);
    // Repeat with the SAME root: byte-identical tree with synced-at masked.
    const h1 = treeHash(repo);
    const again = await vendor(repo, first);
    assert.equal(again.changedCount, 0);
    assert.equal(treeHash(repo), h1, "a second apply is a byte-stable no-op");

    // Local edit at the BOTTOM + upstream v2.0.1 edit at the TOP → clean merge.
    const rulePath = path.join(repo, ".claude", "rules", "one.md");
    writeFileSync(rulePath, "rule one v1\nshared tail\nlocal addition\n");
    const second = fakeRegistryRoot({
      version: "2.0.1",
      sha: "e".repeat(40),
      rules: { "one.md": "rule one v2\nshared tail\n" },
    });
    const r2 = await vendor(repo, second);
    assert.equal(r2.exitStatus, 0);
    assert.equal(
      readFileSync(rulePath, "utf8"),
      "rule one v2\nshared tail\nlocal addition\n",
      "the store base made a clean 3-way merge possible from an immutable root"
    );
    const s = readStamp(repo);
    assert.equal(s.packageVersion, "2.0.1");

    // Conflicting edits on the SAME line → sidecars, live file untouched, stamp pinned.
    writeFileSync(rulePath, "rule one LOCAL\nshared tail\nlocal addition\n");
    const third = fakeRegistryRoot({
      version: "2.0.2",
      sha: "f".repeat(40),
      rules: { "one.md": "rule one UPSTREAM\nshared tail\n" },
    });
    const r3 = await vendor(repo, third);
    assert.equal(r3.exitStatus, 0);
    assert.match(r3.reasons.join("\n"), /conflict/);
    assert.ok(existsSync(`${rulePath}.aios-incoming`), "toolkit version sidecar");
    assert.ok(existsSync(`${rulePath}.aios-merge`), "marked-up merge sidecar");
    assert.match(readFileSync(rulePath, "utf8"), /rule one LOCAL/, "live file keeps mine");
    assert.equal(readStamp(repo).packageVersion, "2.0.1", "stamp pinned until resolved");
    rmSync(second.dir, discard);
    rmSync(third.dir, discard);
  } finally {
    delete process.env.AIOS_UPDATE_OFFLINE;
    rmSync(first.dir, discard);
    rmSync(repo, discard);
  }
});

test("v1→v2 upgrade: rollback record precedes mutation; ratchet to format 2; --rollback restores exact bytes", async () => {
  process.env.AIOS_UPDATE_OFFLINE = "1";
  const { dir: srcDir, root } = fakeRegistryRoot();
  const repo = fakeWorkspace();
  try {
    // A v1 stamp recording a registry-ish history (no checkout on disk).
    const v1Stamp = `${"9".repeat(40)}\ntoolkit-version 0.12.0\nbrain-api 1.24\nsynced-at 2026-08-21T00:00:00.000Z\nsource https://github.com/aiosbrain/aios-workspace.git\n`;
    writeFileSync(path.join(repo, ".aios-toolkit-version"), v1Stamp);
    const r = await vendor(repo, root);
    assert.equal(r.exitStatus, 0);
    const record = JSON.parse(readFileSync(path.join(repo, ROLLBACK_FILE), "utf8"));
    assert.equal(record.previousPackage, "@aiosbrain/aios@0.12.0");
    assert.equal(record.stampSnapshot, v1Stamp, "the EXACT pre-upgrade stamp bytes");
    assert.match(record.reinstall.display, /npm i -g @aiosbrain\/aios@0\.12\.0/);
    assert.equal(readStamp(repo).format, 2, "one-way ratchet");
    // Journal artifacts are cleaned after the committed transition.
    assert.ok(!existsSync(path.join(repo, ".aios-toolkit-version.migration.json")));

    const rb = await rollbackFromRecord(repo, { interactive: false });
    assert.equal(rb.previousPackage, "@aiosbrain/aios@0.12.0");
    assert.equal(
      readFileSync(path.join(repo, ".aios-toolkit-version"), "utf8"),
      v1Stamp,
      "rollback restores the recorded snapshot byte-for-byte"
    );
  } finally {
    delete process.env.AIOS_UPDATE_OFFLINE;
    rmSync(srcDir, discard);
    rmSync(repo, discard);
  }
});

test("a stale interrupted stamp-migration journal is discarded and the apply converges", async () => {
  process.env.AIOS_UPDATE_OFFLINE = "1";
  const { dir: srcDir, root } = fakeRegistryRoot();
  const repo = fakeWorkspace();
  try {
    const v1Stamp = `${"9".repeat(40)}\ntoolkit-version 0.12.0\nsynced-at 2026-08-21T00:00:00.000Z\nsource /gone/checkout\n`;
    const stampPath = path.join(repo, ".aios-toolkit-version");
    writeFileSync(stampPath, v1Stamp);
    // A journal from a DIFFERENT interrupted transition (bogus digests, staged state).
    writeFileSync(
      `${stampPath}.migration.json`,
      JSON.stringify({
        schemaVersion: 1,
        state: "staged",
        configPath: stampPath,
        snapshotPath: `${stampPath}.last-known-good`,
        stagedPath: `${stampPath}.staged`,
        sourceSha256: "0".repeat(64),
        stagedSha256: "1".repeat(64),
      })
    );
    const r = await vendor(repo, root);
    assert.equal(r.exitStatus, 0);
    assert.equal(readStamp(repo).format, 2, "re-entry converged despite the stale journal");
    assert.ok(!existsSync(`${stampPath}.migration.json`));
  } finally {
    delete process.env.AIOS_UPDATE_OFFLINE;
    rmSync(srcDir, discard);
    rmSync(repo, discard);
  }
});

test("cmdUpdate --check accepts a marker-complete non-git copy as an immutable registry source", async () => {
  const { cmdUpdate } = await import("../scripts/update.mjs");
  const { dir: srcDir } = fakeRegistryRoot();
  const repo = fakeWorkspace();
  try {
    const r = await cmdUpdate(repo, cfg, ["--check", "--from", srcDir]);
    assert.deepEqual([r.mode, r.sourceClean, r.exitStatus], ["check", "immutable", 0]);
  } finally {
    rmSync(srcDir, discard);
    rmSync(repo, discard);
  }
});

test("base store: a symlinked store dir (or .aios parent) is a LOUD refusal — zero writes/deletes at the target", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "storelink-"));
  const target = mkdtempSync(path.join(tmpdir(), "storelink-target-"));
  try {
    writeFileSync(path.join(target, "victim"), "do not touch\n");
    mkdirSync(path.join(repo, ".aios"), { recursive: true });
    symlinkSync(target, path.join(repo, BASE_STORE_DIR));
    await assert.rejects(
      () => writeBaseStore(repo, [{ destRel: "a.md", srcRel: "s/a.md", content: "x\n" }]),
      /not a real workspace directory|symlink/,
      "a symlinked toolkit-bases dir must refuse"
    );
    assert.deepEqual(readdirSync(target), ["victim"], "nothing written at the symlink target");
    assert.equal(readFileSync(path.join(target, "victim"), "utf8"), "do not touch\n");

    // Same refusal one level up: a symlinked .aios parent.
    rmSync(path.join(repo, BASE_STORE_DIR));
    rmSync(path.join(repo, ".aios"), { recursive: true });
    symlinkSync(target, path.join(repo, ".aios"));
    await assert.rejects(
      () => writeBaseStore(repo, [{ destRel: "a.md", srcRel: "s/a.md", content: "x\n" }]),
      /not a real workspace directory|symlink/
    );
    assert.deepEqual(readdirSync(target), ["victim"]);
  } finally {
    rmSync(repo, discard);
    rmSync(target, discard);
  }
});

test("base store: symlinked individual blob/index entries refuse and are never followed by the prune", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "storelink2-"));
  const outside = mkdtempSync(path.join(tmpdir(), "storelink2-out-"));
  try {
    const files = [{ destRel: "a.md", srcRel: "s/a.md", content: "alpha\n" }];
    const hash = sha256hex("alpha\n");
    const storeAbs = path.join(repo, BASE_STORE_DIR);
    mkdirSync(storeAbs, { recursive: true });
    // A planted symlink AT the blob's own path: the write must refuse, not follow.
    writeFileSync(path.join(outside, "blob-target"), "outside bytes\n");
    symlinkSync(path.join(outside, "blob-target"), path.join(storeAbs, hash));
    await assert.rejects(() => writeBaseStore(repo, files), /symlink/i);
    assert.equal(readFileSync(path.join(outside, "blob-target"), "utf8"), "outside bytes\n");
    rmSync(path.join(storeAbs, hash));

    // A planted symlink at index.json refuses identically.
    writeFileSync(path.join(outside, "index-target"), "{}\n");
    symlinkSync(path.join(outside, "index-target"), path.join(storeAbs, "index.json"));
    await assert.rejects(() => writeBaseStore(repo, files), /symlink/i);
    assert.equal(readFileSync(path.join(outside, "index-target"), "utf8"), "{}\n");
    rmSync(path.join(storeAbs, "index.json"));

    // An unreferenced symlink entry in the store: the prune leaves it alone (and the
    // target untouched) rather than following or force-removing it.
    writeFileSync(path.join(outside, "stray-target"), "keep\n");
    symlinkSync(path.join(outside, "stray-target"), path.join(storeAbs, "deadbeef"));
    await writeBaseStore(repo, files);
    assert.equal(readFileSync(path.join(outside, "stray-target"), "utf8"), "keep\n");
  } finally {
    rmSync(repo, discard);
    rmSync(outside, discard);
  }
});

test("base store: a truncated/corrupted blob is REPAIRED on the next apply and resolves normally after", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "storefix-"));
  try {
    const files = [{ destRel: "a.md", srcRel: "s/a.md", content: "alpha\n" }];
    await writeBaseStore(repo, files, { packageVersion: "2.0.0" });
    const index = readBaseIndex(repo);
    const blobAbs = path.join(repo, BASE_STORE_DIR, index.entries["a.md"].hash);
    writeFileSync(blobAbs, "trunc"); // corrupt it
    assert.equal(baseFromStore(repo, index, "a.md"), undefined, "corruption is detected");
    await writeBaseStore(repo, files, { packageVersion: "2.0.0" }); // next apply
    assert.equal(readFileSync(blobAbs, "utf8"), "alpha\n", "the blob was rewritten in place");
    assert.equal(
      baseFromStore(repo, readBaseIndex(repo), "a.md"),
      "alpha\n",
      "base resolves again"
    );
  } finally {
    rmSync(repo, discard);
  }
});

test("recordRollbackIfUpgrading is a no-op once the workspace is on format 2", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "rbnoop-"));
  try {
    writeFileSync(
      path.join(repo, ".aios-toolkit-version"),
      stampBody(
        "c".repeat(40),
        { version: "2.0.0", label: "v2.0.0" },
        "pkg:@aiosbrain/aios@2.0.0",
        {
          manifestDigest: "sha256:x",
        }
      )
    );
    assert.equal(await recordRollbackIfUpgrading(repo, {}), null);
    assert.ok(!existsSync(path.join(repo, ROLLBACK_FILE)));
  } finally {
    rmSync(repo, discard);
  }
});
