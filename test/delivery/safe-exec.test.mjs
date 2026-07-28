// test/delivery/safe-exec.test.mjs — the allowlist gate every `aios delivery status` subprocess
// call goes through (AIO-579). Asserts every mutating git/gh verb is refused BEFORE a process is
// ever spawned, and that the read-only verbs this feature actually uses still work.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { safeGit, safeGh } from "../../scripts/delivery/safe-exec.mjs";

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "delivery-safeexec-"));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"]);
  return dir;
}

// ── git: mutating verbs are refused, none of them ever spawn a process ─────────────────────
const GIT_MUTATING = [
  ["push"],
  ["merge", "main"],
  ["reset", "--hard"],
  ["clean", "-fd"],
  ["stash"],
  ["checkout", "-b", "x"],
  ["branch", "-D", "x"],
  ["worktree", "remove", "x"],
  ["worktree", "prune"],
  ["tag", "-d", "x"],
  ["rebase", "main"],
  ["cherry-pick", "HEAD"],
  ["commit", "--allow-empty", "-m", "x"],
  ["rm", "-rf", "x"],
];

test("safeGit refuses every mutating git verb before spawning anything", () => {
  const dir = initRepo();
  try {
    for (const argv of GIT_MUTATING) {
      assert.throws(
        () => safeGit(dir, argv),
        /refusing/,
        `expected safeGit to refuse: git ${argv.join(" ")}`
      );
    }
    // Proof the repo was untouched: still exactly one commit, clean tree.
    const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).trim();
    assert.equal(log.split("\n").length, 1);
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    assert.equal(status, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeGit allows the read-only verbs this feature uses", () => {
  const dir = initRepo();
  try {
    assert.doesNotThrow(() => safeGit(dir, ["status", "--porcelain"]));
    assert.doesNotThrow(() => safeGit(dir, ["worktree", "list", "--porcelain"]));
    assert.doesNotThrow(() =>
      safeGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    );
    assert.doesNotThrow(() => safeGit(dir, ["rev-parse", "--is-inside-work-tree"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeGit refuses an unknown top-level subcommand", () => {
  const dir = initRepo();
  try {
    assert.throws(() => safeGit(dir, ["fsck"]), /refusing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── gh: mutating commands are refused, none of them ever spawn a process ───────────────────
const GH_MUTATING = [
  ["pr", "merge", "1"],
  ["pr", "close", "1"],
  ["pr", "create"],
  ["pr", "edit", "1"],
  ["pr", "review", "1", "--approve"],
  ["release", "create", "v1"],
  ["workflow", "run", "ci.yml"],
  ["api", "repos/x/y", "-X", "POST"],
  ["api", "repos/x/y", "--method", "DELETE"],
];

test("safeGh refuses every mutating gh command before spawning anything", () => {
  for (const argv of GH_MUTATING) {
    assert.throws(
      () => safeGh(argv),
      /refusing/,
      `expected safeGh to refuse: gh ${argv.join(" ")}`
    );
  }
});

// ── gh: allowed commands actually reach execFileSync (proven via a fake `gh` on PATH) ───────
test("safeGh executes an allowlisted read-only command and a GET-method api call", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "delivery-fakegh-"));
  const record = path.join(bin, "record.log");
  writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.RECORD, process.argv.slice(2).join(' ') + '\\n');",
      "process.stdout.write('[]');",
    ].join("\n")
  );
  chmodSync(path.join(bin, "gh"), 0o755);

  const originalPath = process.env.PATH;
  // safe-exec resolves `gh` to an absolute system path (Sonar S4036), so a PATH-only
  // fake no longer intercepts it — point the named stub seam at this fake too.
  const originalGhBin = process.env.AIOS_DELIVERY_GH_BIN;
  const originalRecord = process.env.RECORD;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.AIOS_DELIVERY_GH_BIN = path.join(bin, "gh");
  process.env.RECORD = record;
  try {
    const out = safeGh(["pr", "list", "--repo", "acme/repo", "--json", "number"]);
    assert.equal(out, "[]");
    const out2 = safeGh(["api", "repos/acme/repo/pulls/1", "--method", "GET"]);
    assert.equal(out2, "[]");
    const recorded = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(recorded, [
      "pr list --repo acme/repo --json number",
      "api repos/acme/repo/pulls/1 --method GET",
    ]);
  } finally {
    process.env.PATH = originalPath;
    if (originalGhBin === undefined) delete process.env.AIOS_DELIVERY_GH_BIN;
    else process.env.AIOS_DELIVERY_GH_BIN = originalGhBin;
    if (originalRecord === undefined) delete process.env.RECORD;
    else process.env.RECORD = originalRecord;
    rmSync(bin, { recursive: true, force: true });
  }
});
