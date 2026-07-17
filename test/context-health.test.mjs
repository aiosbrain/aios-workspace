import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { computeContextHealth } from "../scripts/context-health.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, "test", "fixtures", "fake-workspace");
const checkContextScript = path.join(repoRoot, "scripts", "check-context.mjs");

/** Copy the fixture into a fresh tmpdir so a test can mutate it without touching the checked-in fixture. */
function copyFixture(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function findCheck(result, id) {
  return result.checks.find((c) => c.id === id);
}

/**
 * toolkit-staleness and missing-seeds opportunistically compare against a *local* toolkit
 * checkout (env var, else ~/Projects/aios/aios-workspace) — which may or may not exist on
 * the machine running these tests. Pointing HOME at a directory with no such checkout (and
 * clearing the env override) makes both report `value: null` deterministically, so the
 * banding assertions below don't depend on what's on disk outside this repo.
 */
function withNoLocalToolkit(fn) {
  const prevHome = process.env.HOME;
  const prevToolkitDir = process.env.AIOS_TOOLKIT_DIR;
  const noToolkitHome = mkdtempSync(path.join(tmpdir(), "context-health-no-toolkit-home-"));
  process.env.HOME = noToolkitHome;
  delete process.env.AIOS_TOOLKIT_DIR;
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
    if (prevToolkitDir === undefined) delete process.env.AIOS_TOOLKIT_DIR;
    else process.env.AIOS_TOOLKIT_DIR = prevToolkitDir;
    rmSync(noToolkitHome, { recursive: true, force: true });
  }
}

// Remove both deliberate defects from a copied fixture dir in place.
function fixDefects(dir) {
  const agentsPath = path.join(dir, "AGENTS.md");
  writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace("{{OWNER}}", "sample-owner"));
  const indexPath = path.join(dir, "0-context", "index.md");
  writeFileSync(
    indexPath,
    readFileSync(indexPath, "utf8").replace(
      "See [[broken-link-target]] for more — deliberately broken, no such file exists.",
      "See [the work note](../2-work/note.md) for more."
    )
  );
}

test("workspace mode: fixture is detected as a stamped workspace", () => {
  const result = computeContextHealth(fixtureDir);
  assert.equal(result.mode, "workspace");
});

test("workspace mode: placeholder-residue and broken-links hard-fail on the raw fixture (score 0)", () => {
  const result = computeContextHealth(fixtureDir);
  const placeholder = findCheck(result, "placeholder-residue");
  const brokenLinks = findCheck(result, "broken-links");
  assert.equal(placeholder.ok, false);
  assert.equal(placeholder.kind, "hard");
  assert.equal(brokenLinks.ok, false);
  assert.equal(brokenLinks.kind, "hard");
  assert.equal(result.hardFailures, 2);
  assert.equal(result.score, 0);
});

test("workspace mode: hard checks pass once both defects are removed from a tmpdir copy", () => {
  const dir = copyFixture("context-health-fixed-");
  try {
    fixDefects(dir);
    const result = computeContextHealth(dir);
    assert.equal(result.mode, "workspace");
    assert.equal(findCheck(result, "placeholder-residue").ok, true);
    assert.equal(findCheck(result, "broken-links").ok, true);
    assert.equal(result.hardFailures, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── banding: exact 4/3/2/1/0 semantics ──────────────────────────────────────

test("banding: 0 hard failures + 0 soft misses -> score 4", () => {
  withNoLocalToolkit(() => {
    const dir = copyFixture("context-health-band4-");
    try {
      fixDefects(dir);
      const result = computeContextHealth(dir);
      assert.equal(result.hardFailures, 0);
      assert.equal(result.softMisses, 0);
      assert.equal(result.score, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("banding: 0 hard failures + 1 soft miss (stale decision log) -> score 3", () => {
  withNoLocalToolkit(() => {
    const dir = copyFixture("context-health-band3-");
    try {
      fixDefects(dir);
      const logPath = path.join(dir, "3-log", "decision-log.md");
      writeFileSync(logPath, readFileSync(logPath, "utf8").replace("2026-07-15", "2026-05-01"));
      const result = computeContextHealth(dir);
      assert.equal(result.hardFailures, 0);
      assert.equal(result.softMisses, 1);
      assert.equal(findCheck(result, "decision-recency").ok, false);
      assert.equal(findCheck(result, "tier-coverage").ok, true);
      assert.equal(result.score, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("banding: 0 hard failures + 2 soft misses (stale log + low tier coverage) -> score 2", () => {
  withNoLocalToolkit(() => {
    const dir = copyFixture("context-health-band2-");
    try {
      fixDefects(dir);
      const logPath = path.join(dir, "3-log", "decision-log.md");
      writeFileSync(logPath, readFileSync(logPath, "utf8").replace("2026-07-15", "2026-05-01"));
      const notePath = path.join(dir, "2-work", "note.md");
      writeFileSync(
        notePath,
        readFileSync(notePath, "utf8").replace(/^---\naccess: team\n---\n\n/, "")
      );
      const result = computeContextHealth(dir);
      assert.equal(result.hardFailures, 0);
      assert.equal(result.softMisses, 2);
      assert.equal(findCheck(result, "decision-recency").ok, false);
      assert.equal(findCheck(result, "tier-coverage").ok, false);
      assert.equal(result.score, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("banding: 1 hard failure -> score 1 regardless of soft misses", () => {
  withNoLocalToolkit(() => {
    const dir = copyFixture("context-health-band1-");
    try {
      // Fix only the placeholder residue; leave the broken wikilink in place — exactly
      // one hard failure.
      const agentsPath = path.join(dir, "AGENTS.md");
      writeFileSync(
        agentsPath,
        readFileSync(agentsPath, "utf8").replace("{{OWNER}}", "sample-owner")
      );
      const result = computeContextHealth(dir);
      assert.equal(result.hardFailures, 1);
      assert.equal(findCheck(result, "broken-links").ok, false);
      assert.equal(findCheck(result, "placeholder-residue").ok, true);
      assert.equal(result.score, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("banding: 2 hard failures -> score 0 regardless of soft misses", () => {
  withNoLocalToolkit(() => {
    // The raw, un-fixed fixture already carries both defects.
    const result = computeContextHealth(fixtureDir);
    assert.equal(result.hardFailures, 2);
    assert.equal(result.score, 0);
  });
});

// ── context-facts hook (both modes share this check) ────────────────────────

test("context-facts: fails with value 1 when one of two needles is missing", () => {
  const dir = copyFixture("context-health-facts-");
  try {
    fixDefects(dir);
    mkdirSync(path.join(dir, ".aios"), { recursive: true });
    writeFileSync(
      path.join(dir, ".aios", "context-facts.yaml"),
      [
        "facts:",
        '  - file: "CLAUDE.md"',
        "    needles:",
        '      - "Fake Workspace"',
        '      - "THIS_NEEDLE_DOES_NOT_EXIST_ANYWHERE"',
      ].join("\n") + "\n"
    );
    const result = computeContextHealth(dir);
    const check = findCheck(result, "context-facts");
    assert.equal(check.ok, false);
    assert.equal(check.value, 1);
    assert.equal(result.hardFailures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── repo mode ────────────────────────────────────────────────────────────────

test("repo mode: this toolkit repo's own root is detected as 'repo' mode with clean hard checks", () => {
  const result = computeContextHealth(repoRoot);
  assert.equal(result.mode, "repo");
  assert.equal(result.hardFailures, 0);
});

test("null-safety: soft checks in repo mode report value null (not a throw) with no git and no repo files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "context-health-bare-"));
  try {
    assert.doesNotThrow(() => computeContextHealth(dir));
    const result = computeContextHealth(dir);
    assert.equal(result.mode, "repo");
    assert.equal(result.hardFailures, 0);
    assert.equal(result.softMisses, 0);
    assert.equal(result.score, 4);
    // Every check that DID run (because it returned an object rather than being
    // omitted for "not applicable") is `ok: true` with `value: null` — the module's
    // documented behavior for an unavailable signal.
    for (const check of result.checks) {
      assert.equal(check.ok, true);
      assert.equal(check.value, null);
    }
    assert.ok(
      result.checks.length > 0,
      "expected at least one signal-unavailable check to be reported"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── check-context.mjs exit codes ─────────────────────────────────────────────

test("check-context.mjs exits 1 for the broken fixture", () => {
  assert.throws(
    () => execFileSync("node", [checkContextScript], { cwd: fixtureDir, stdio: "pipe" }),
    (err) => err.status === 1
  );
});

test("check-context.mjs exits 0 for this repo's own root", () => {
  const out = execFileSync("node", [checkContextScript], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /Context health ok/);
});
