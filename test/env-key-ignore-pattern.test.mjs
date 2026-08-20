// test/env-key-ignore-pattern.test.mjs
//
// Regression: a rotation/backup copy of a dotenvx key file must be gitignored.
//
// A file named `.env.keys.bak-<date>`, holding a LIVE dotenvx private key, once sat
// untracked in this repo's root and showed up in `git status` as `??` — because both
// `.gitignore` and the leak gate's skip list matched the EXACT string `.env.keys`, which
// does not match `.env.keys.bak-<date>`, `.env.keys.old`, or `.env.keys.2`. A single
// `git add -A` would have staged a private key. The scaffolded-workspace template was
// worse: it never ignored `.env.keys` at all.
//
// The fix globs the shape (`.env.*`). The second half of that bargain is that the glob
// must NOT shadow a file the repo deliberately TRACKS — an over-broad ignore that hides
// `.env.example` is a worse bug than the one being fixed — so the "nothing tracked became
// ignored" assertion below is as load-bearing as the "the backup is ignored" one.
//
// No real key material appears here: every value is an obvious placeholder built at
// runtime, so this committed file carries no secret-shaped literal.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

// Every shape a `.env.keys` rotation, backup, or numbered copy realistically takes, plus
// the sibling `.env` shapes that carry the same class of local-only secret.
const MUST_BE_IGNORED = [
  ".env",
  ".env.keys",
  ".env.keys.bak-2026-08-20",
  ".env.keys.old",
  ".env.keys.2",
  ".env.keys.backup",
  ".env.local",
  ".env.local.bak",
  ".env.bak",
  ".env.production",
];

// The one env-shaped file the repo publishes on purpose. If a widened glob ever swallows
// it, the scaffolder ships a workspace with no example env file and nobody notices.
const MUST_NOT_BE_IGNORED = [".env.example"];

/** `git check-ignore` decides purely from the ignore rules; --no-index so a tracked path still reports. */
function isIgnored(repo, rel) {
  const r = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", rel], { cwd: repo });
  assert.ok(r.status === 0 || r.status === 1, `check-ignore failed for ${rel} in ${repo}`);
  return r.status === 0;
}

function assertIgnoreContract(repo, label) {
  for (const rel of MUST_BE_IGNORED) {
    assert.equal(isIgnored(repo, rel), true, `${label}: ${rel} must be gitignored`);
  }
  for (const rel of MUST_NOT_BE_IGNORED) {
    assert.equal(isIgnored(repo, rel), false, `${label}: ${rel} must stay tracked, not ignored`);
  }
}

test("toolkit repo: every .env.keys-derived shape is gitignored", () => {
  assertIgnoreContract(ROOT, "toolkit");
  // The exact near-miss, end to end: a real file on disk must be invisible to `git add -A`.
  const bak = path.join(ROOT, ".env.keys.bak-regression-probe");
  try {
    writeFileSync(bak, `DOTENV_PRIVATE_KEY=${"placeholder-not-a-real-key"}\n`);
    const status = execFileSync("git", ["status", "--porcelain", "--", path.basename(bak)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(
      status.trim(),
      "",
      "a .env.keys backup must never appear as an untracked candidate"
    );
  } finally {
    rmSync(bak, { force: true });
  }
});

test("toolkit repo: the widened env globs shadow no tracked file", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const shadowed = tracked.filter((rel) => {
    const r = spawnSync("git", ["check-ignore", "--no-index", "-v", "--", rel], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) return false;
    // Field 3 of `-v` output is the pattern that decided it.
    const pattern = (r.stdout.split("\n")[0] || "").split("\t")[0].split(":")[2];
    return pattern === ".env" || pattern === ".env.*";
  });
  assert.deepEqual(shadowed, [], "no tracked file may be ignored by the env globs");
});

for (const context of ["consultant", "employee", "business-owner"]) {
  test(`scaffolded --context ${context} workspace inherits the env ignore contract`, () => {
    const output = mkdtempSync(path.join(tmpdir(), `env-ignore-${context}-`));
    rmSync(output, { recursive: true, force: true });
    try {
      execFileSync(
        "bash",
        [
          SCAFFOLD_SCRIPT,
          "--context",
          context,
          "--slug",
          "env-ignore-ws",
          "--stakeholder",
          "Acme",
          "--owner",
          "tester",
          "--output",
          output,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      assertIgnoreContract(output, `scaffold/${context}`);
      // The scaffolder commits the workspace; .env.example must have survived into that commit.
      execFileSync("git", ["ls-files", "--error-unmatch", "--", ".env.example"], {
        cwd: output,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}
