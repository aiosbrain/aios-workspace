// test/scanner-ignored-trees.test.mjs — AIO-517.
//
// Every tree scanner (OGR03 secrets, the confidentiality leak gate, OGR02 frontmatter,
// OGR14 file governance) must enumerate its targets VIA GIT — tracked files plus
// untracked-but-not-ignored files — so gitignored build trees are structurally
// invisible. The failure that motivated this was NOT a false finding: a 1.6 GB
// gitignored `src-tauri/target` (35k files, re-grepped once per secret pattern)
// exhausted a preflight secret scan's window, so the gate never finished. A security
// gate that fails by hanging is indistinguishable from a broken one.
//
// The assertions here are structural, never wall-clock:
//   1. a planted secret inside a gitignored tree is NOT reported (the scanner never
//      opened it) — a filesystem walk would report it and exit non-zero;
//   2. the same secret in a TRACKED file blocks;
//   3. the same secret in an UNTRACKED, NON-IGNORED file blocks;
//   4. the enumeration contract itself lists nothing under the ignored tree.
//
// Every secret-shaped and NDA-shaped string is assembled at runtime by concatenation,
// so this committed file never contains a literal that the scanners would flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SECRETS = path.join(REPO, "validation", "check-secrets.sh");
const LEAK_GATE = path.join(REPO, "scripts", "leak-gate.sh");
const CHECK_FRONTMATTER = path.join(REPO, "validation", "check-frontmatter.sh");
const CHECK_GOVERNANCE = path.join(REPO, "validation", "check-file-governance.mjs");

// Assembled at runtime — never a literal in this committed file.
const AWS_KEY = "AKIA" + "Q".repeat(16);
const NDA_TERM = "wonka" + "-" + "group";
// A generous but finite budget: the point is that a hung scan fails the test instead of
// stalling the suite. It is NOT a performance assertion — the structural assertions below
// are what prove the ignored tree was skipped.
const RUN_TIMEOUT_MS = 120_000;

/** A throwaway git repo with a big gitignored build tree that hides a planted secret. */
function makeRepo({ ignoredFiles = 250 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "aio517-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "AIO-517 test");
  git("config", "commit.gpgsign", "false");

  // Stand in for src-tauri/target: gitignored, many files, and one of them holds
  // material that would trip every scanner if it were ever opened.
  writeFileSync(path.join(dir, ".gitignore"), "build-out/\n");
  mkdirSync(path.join(dir, "build-out", "deps"), { recursive: true });
  const bulk = "x".repeat(4096) + "\n";
  for (let i = 0; i < ignoredFiles; i++) {
    writeFileSync(path.join(dir, "build-out", "deps", `artifact-${i}.rs`), bulk);
  }
  writeFileSync(
    path.join(dir, "build-out", "leaked.log"),
    `aws_access_key = ${AWS_KEY}\nclient: ${NDA_TERM}\n`
  );

  mkdirSync(path.join(dir, "2-work"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# sandbox\n\nnothing to see.\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

function ndaTermsFile(dir) {
  const file = path.join(dir, "terms.sh");
  writeFileSync(file, `STRONG='${NDA_TERM}'\nWORDS=''\nPATTERNS=''\n`);
  return file;
}

function run(script, args, env = {}) {
  const res = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
  assert.ok(
    res.status !== null,
    `${path.basename(script)} did not terminate (killed by ${res.signal})`
  );
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("check-secrets: a gitignored build tree is invisible — scan completes and reports clean", () => {
  const dir = makeRepo();
  try {
    const { code, out } = run(CHECK_SECRETS, [dir]);
    assert.equal(code, 0, `expected a clean scan, got:\n${out}`);
    assert.match(out, /OGR03 PASSED/);
    // The planted secret lives only under the ignored tree, so it must not surface.
    assert.ok(!out.includes("build-out"), `ignored tree was scanned:\n${out}`);
    assert.ok(!out.includes(AWS_KEY), "the scanner opened a file inside the ignored tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets: the same secret in a TRACKED file blocks", () => {
  const dir = makeRepo({ ignoredFiles: 20 });
  try {
    writeFileSync(path.join(dir, "2-work", "notes.md"), `aws_access_key = ${AWS_KEY}\n`);
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-qm", "oops"], { stdio: "ignore" });
    const { code, out } = run(CHECK_SECRETS, [dir]);
    assert.equal(code, 1, `expected a block, got:\n${out}`);
    assert.match(out, /OGR03 FAILED/);
    assert.match(out, /2-work\/notes\.md/);
    assert.match(out, /line 1: \[REDACTED\]/);
    assert.ok(!out.includes(AWS_KEY), "tracked-file diagnostics must not echo the matched secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets: the same secret in an UNTRACKED, non-ignored file blocks", () => {
  const dir = makeRepo({ ignoredFiles: 20 });
  try {
    // Never added to the index and not covered by .gitignore — still publishable.
    writeFileSync(path.join(dir, "2-work", "scratch.md"), `aws_access_key = ${AWS_KEY}\n`);
    const { code, out } = run(CHECK_SECRETS, [dir]);
    assert.equal(code, 1, `expected a block, got:\n${out}`);
    assert.match(out, /2-work\/scratch\.md/);
    assert.match(out, /line 1: \[REDACTED\]/);
    assert.ok(!out.includes(AWS_KEY), "untracked-file diagnostics must not echo the matched secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets: still scans a non-git directory (the aios build change-set dir)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio517-nogit-"));
  try {
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "changed.md"), `aws_access_key = ${AWS_KEY}\n`);
    const { code, out } = run(CHECK_SECRETS, [dir]);
    assert.equal(code, 1, `expected a block in the non-git fallback, got:\n${out}`);
    assert.match(out, /sub\/changed\.md/);
    assert.match(out, /line 1: \[REDACTED\]/);
    assert.ok(!out.includes(AWS_KEY), "non-git diagnostics must not echo the matched secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets: a TRACKED .env still blocks; a gitignored one does not", () => {
  const dir = makeRepo({ ignoredFiles: 5 });
  try {
    writeFileSync(path.join(dir, ".env"), "SOME_KEY=value\n");
    const clean = run(CHECK_SECRETS, [dir]);
    assert.equal(clean.code, 0, `untracked .env must not block:\n${clean.out}`);
    execFileSync("git", ["-C", dir, "add", "-f", ".env"], { stdio: "ignore" });
    const blocked = run(CHECK_SECRETS, [dir]);
    assert.equal(blocked.code, 1, `a tracked .env must block:\n${blocked.out}`);
    assert.match(blocked.out, /\.env file committed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leak-gate: a gitignored tree is invisible; tracked and untracked-non-ignored hits block", () => {
  const dir = makeRepo({ ignoredFiles: 50 });
  const termsDir = mkdtempSync(path.join(tmpdir(), "aio517-terms-"));
  try {
    const env = { AIOS_LEAK_TERMS_FILE: ndaTermsFile(termsDir) };

    const clean = run(LEAK_GATE, [dir], env);
    assert.equal(clean.code, 0, `expected CLEAN, got:\n${clean.out}`);
    assert.match(clean.out, /leak-gate: CLEAN/);
    assert.ok(!clean.out.includes("build-out"), `ignored tree was swept:\n${clean.out}`);

    // Untracked but not ignored → must block. The location is reported as the allowlisted
    // parent directory only: the gate never prints the matching file's path or the matched
    // text (see test/leak-gate-output-containment.test.mjs for that contract).
    writeFileSync(path.join(dir, "2-work", "draft.md"), `engagement with ${NDA_TERM}\n`);
    const untracked = run(LEAK_GATE, [dir], env);
    assert.equal(untracked.code, 1, `expected a leak block, got:\n${untracked.out}`);
    assert.match(untracked.out, /under: 2-work/);
    assert.ok(!untracked.out.includes(NDA_TERM), "the gate must not echo the matched term");

    // Tracked → must block, with the same containment.
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-qm", "leak"], { stdio: "ignore" });
    const tracked = run(LEAK_GATE, [dir], env);
    assert.equal(tracked.code, 1, `expected a leak block, got:\n${tracked.out}`);
    assert.match(tracked.out, /under: 2-work/);
    assert.ok(!tracked.out.includes(NDA_TERM), "the gate must not echo the matched term");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(termsDir, { recursive: true, force: true });
  }
});

test("leak-gate: a single file argument is still swept (aios promote)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio517-file-"));
  const termsDir = mkdtempSync(path.join(tmpdir(), "aio517-terms-"));
  try {
    const file = path.join(dir, "promoted.md");
    writeFileSync(file, `client: ${NDA_TERM}\n`);
    const { code, out } = run(LEAK_GATE, [file], { AIOS_LEAK_TERMS_FILE: ndaTermsFile(termsDir) });
    assert.equal(code, 1, `expected a leak block on a single file, got:\n${out}`);
    // A single-file target has no allowlisted parent to name, and the filename itself may
    // carry a protected identifier — so the location is withheld, not guessed at.
    assert.match(out, /location withheld/);
    assert.ok(!out.includes("promoted.md"), "the gate must not print the matching path");
    assert.ok(!out.includes(NDA_TERM), "the gate must not echo the matched term");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(termsDir, { recursive: true, force: true });
  }
});

test("check-frontmatter + OGR14 never read content out of a gitignored tree", () => {
  const dir = makeRepo({ ignoredFiles: 10 });
  try {
    // A .md with no frontmatter inside the ignored tree: warned about by a walker,
    // invisible to a git-enumerated scanner.
    writeFileSync(path.join(dir, "build-out", "generated-doc.md"), "line\nline\nline\nline\n");

    const fm = run(CHECK_FRONTMATTER, [dir]);
    assert.ok(!fm.out.includes("generated-doc.md"), `OGR02 walked the ignored tree:\n${fm.out}`);

    const gov = spawnSync("node", [CHECK_GOVERNANCE, dir], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    const govOut = `${gov.stdout ?? ""}${gov.stderr ?? ""}`;
    assert.ok(!govOut.includes("generated-doc.md"), `OGR14 walked the ignored tree:\n${govOut}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitFiles: lists tracked + untracked-non-ignored, and returns null outside a work tree", async () => {
  const { gitFiles } = await import("../scripts/git-files.mjs");
  const dir = makeRepo({ ignoredFiles: 5 });
  const plain = mkdtempSync(path.join(tmpdir(), "aio517-plain-"));
  try {
    writeFileSync(path.join(dir, "2-work", "untracked.md"), "hello\n");
    const listed = gitFiles(dir);
    assert.ok(listed.includes("README.md"), "tracked file missing");
    assert.ok(listed.includes("2-work/untracked.md"), "untracked-non-ignored file missing");
    assert.ok(!listed.some((f) => f.startsWith("build-out/")), "ignored tree leaked into the list");
    assert.equal(gitFiles(plain), null, "a non-git dir must fall back, not throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("the enumeration contract itself excludes the ignored tree", () => {
  const dir = makeRepo({ ignoredFiles: 10 });
  try {
    const listed = [
      execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8" }),
      execFileSync("git", ["-C", dir, "ls-files", "-z", "-o", "--exclude-standard"], {
        encoding: "utf8",
      }),
    ]
      .flatMap((s) => s.split("\0"))
      .filter(Boolean);
    assert.ok(listed.includes("README.md"), "tracked files must be enumerated");
    assert.ok(
      !listed.some((f) => f.startsWith("build-out/")),
      "no file under a gitignored tree may appear in the scan list"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
