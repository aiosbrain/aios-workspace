// AIO-320 → AIO-596 — file-size gate v2 (scripts/check-file-size.mjs).
//
// AIO-596 flipped the gate from an enumerated ALLOWLIST (only files named in size-caps.json were
// capped) to DEFAULT-DENY: every `include`-matched, non-`exclude`d file is subject to `defaultCap`,
// and `grandfathered` pins the files that were already over cap at flip time as a per-file ceiling
// that only ever ratchets down. These tests run the real gate against synthetic git repos (never a
// filesystem walk — enumeration goes through scripts/git-files.mjs, AIO-517) and cover every branch
// the acceptance criteria calls out: a brand-new file over the default cap fails, a grandfathered
// file exactly at its recorded cap passes, a grandfathered file that grew past its cap fails, and
// `--ratchet` only ever lowers a grandfathered cap — never raises one.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-file-size.mjs");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** A throwaway git repo (required — the gate enumerates via `git ls-files`, never a walk). */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "sizegate-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "size-gate test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function writeConfig(dir, overrides = {}) {
  const config = {
    defaultCap: 50,
    include: ["**/*.mjs"],
    exclude: ["excluded/**"],
    grandfathered: {},
    ...overrides,
  };
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "size-caps.json"), JSON.stringify(config, null, 2));
}

function readConfig(dir) {
  return JSON.parse(readFileSync(path.join(dir, "scripts", "size-caps.json"), "utf8"));
}

function writeLines(dir, rel, n) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "line\n".repeat(n));
}

function commitAll(dir) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "wip"]);
}

function run(dir, args = []) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("passes when every included file is at/under the default cap", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir);
    writeLines(dir, "scripts/small.mjs", 50); // exactly at cap
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails and names a brand-new file that exceeds the default cap — an unarmed gate is worse than none", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir);
    writeLines(dir, "scripts/huge.mjs", 600); // new file, never grandfathered
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /scripts\/huge\.mjs/);
    assert.match(r.out, /600 lines > default cap 50/);
    assert.match(r.out, /over by 550/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new over-cap file fails even when only untracked (not yet committed)", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir);
    commitAll(dir); // commit the config with nothing else, so the repo has a HEAD
    writeLines(dir, "scripts/uncommitted.mjs", 600); // never `git add`ed
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /scripts\/uncommitted\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandfathered file exactly at its recorded cap passes", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir, { grandfathered: { "scripts/legacy.mjs": 900 } });
    writeLines(dir, "scripts/legacy.mjs", 900);
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 grandfathered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandfathered file that grew past its recorded cap fails, distinct from a default-cap miss", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir, { grandfathered: { "scripts/legacy.mjs": 900 } });
    writeLines(dir, "scripts/legacy.mjs", 905); // grew past its ceiling
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /scripts\/legacy\.mjs: 905 lines > grandfathered cap 900 \(over by 5\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ratchet lowers a grandfathered cap that has shrunk, and the lowered cap sticks", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir, { grandfathered: { "scripts/legacy.mjs": 900 } });
    writeLines(dir, "scripts/legacy.mjs", 700); // shrunk well below its 900 ceiling
    commitAll(dir);

    const ratcheted = run(dir, ["--ratchet"]);
    assert.equal(ratcheted.code, 0, ratcheted.out);
    assert.match(ratcheted.out, /ratchet: lowered 1 grandfathered cap/);
    assert.match(ratcheted.out, /scripts\/legacy\.mjs: 900 → 700/);

    const persisted = readConfig(dir);
    assert.equal(
      persisted.grandfathered["scripts/legacy.mjs"],
      700,
      "the lowered cap must persist"
    );

    // The lowered cap is now the enforced ceiling: growing back up to (but not past) the OLD
    // cap of 900 must fail, proving --ratchet actually tightened the gate rather than just
    // logging.
    writeLines(dir, "scripts/legacy.mjs", 850);
    commitAll(dir);
    const grown = run(dir);
    assert.equal(grown.code, 1, grown.out);
    assert.match(grown.out, /scripts\/legacy\.mjs: 850 lines > grandfathered cap 700/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ratchet never raises a cap: a grandfathered file over its recorded cap still fails", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir, { grandfathered: { "scripts/legacy.mjs": 900 } });
    writeLines(dir, "scripts/legacy.mjs", 950); // grew PAST its ceiling
    commitAll(dir);

    const r = run(dir, ["--ratchet"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /scripts\/legacy\.mjs: 950 lines > grandfathered cap 900/);

    const persisted = readConfig(dir);
    assert.equal(
      persisted.grandfathered["scripts/legacy.mjs"],
      900,
      "--ratchet must not raise a cap to match a violation"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exclude globs are honored: an over-cap file under an excluded path never gates", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir);
    writeLines(dir, "excluded/vendored.mjs", 600);
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes("vendored.mjs"), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("include globs are honored: an over-cap file with a non-included extension never gates", () => {
  const dir = makeRepo();
  try {
    writeConfig(dir); // include: ["**/*.mjs"]
    writeLines(dir, "docs/notes.md", 600);
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes("notes.md"), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandfathered path that no longer matches is reported as a stale advisory, not a failure", () => {
  const dir = makeRepo();
  try {
    // "scripts/gone.mjs" is grandfathered but was already deleted/extracted below cap.
    writeConfig(dir, { grandfathered: { "scripts/gone.mjs": 900 } });
    writeLines(dir, "scripts/small.mjs", 10);
    commitAll(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /scripts\/gone\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
