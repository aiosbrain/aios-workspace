#!/usr/bin/env node
// test/promote.test.mjs — `aios promote` (AIO-353): the anonymize-then-promote pipeline
// for reusable IP. Covers the pure helpers (tier/path resolution, frontmatter rewrite,
// decision-log row append) plus the end-to-end cmdPromote flow against a throwaway
// workspace dir, with the leak/secret scan mocked so the test suite stays offline and
// doesn't depend on leak-gate.sh's NDA-terms configuration.
// Run: node --test test/promote.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifySource,
  resolveDestination,
  outwardLabel,
  rewriteFrontmatter,
  appendDecisionRow,
  decisionLogPath,
  cmdPromote,
} from "../scripts/promote.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMOTE_MOD = path.join(TEST_DIR, "..", "scripts", "promote.mjs");

/** cmdPromote's failure paths call die() (process.exit(1)) — run those in a child so a
 *  failing assertion inside THIS process doesn't take the whole test file down with it. */
function runPromoteChild(repo, args, cfgOverrides = {}) {
  const cfgJson = JSON.stringify({
    context: "consultant",
    sync_include: ["2-work", "4-shared"],
    ...cfgOverrides,
  });
  const script =
    `import { cmdPromote } from ${JSON.stringify(PROMOTE_MOD)};` +
    `await cmdPromote(${JSON.stringify(repo)}, ${cfgJson}, ${JSON.stringify(args)}, ` +
    `{ resolveMember: () => "alex", scanFile: async () => ({ clean: true, findings: [] }) });`;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

function tmpWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-promote-test-"));
  mkdirSync(path.join(dir, "5-personal"), { recursive: true });
  mkdirSync(path.join(dir, "2-work"), { recursive: true });
  mkdirSync(path.join(dir, "4-shared"), { recursive: true });
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  writeFileSync(
    path.join(dir, "3-log", "decision-log.md"),
    '---\naccess: team\ntype: "Decision Log"\n---\n' +
      "# Decision Log\n\n" +
      "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
      "|---|------|----------|-----------|------------|--------|------|----------|\n" +
      "| 3 | 2026-01-01 | Some earlier decision | because | alex | nothing | 1 | team |\n"
  );
  return dir;
}

const CFG_CONSULTANT = { context: "consultant", sync_include: ["0-context", "2-work", "4-shared"] };
const CFG_EMPLOYEE = { context: "employee", sync_include: ["0-context", "2-work", "4-shared"] };

// ── classifySource ───────────────────────────────────────────────────────────
test("classifySource: 5-personal/ is always private", () => {
  const repo = "/repo";
  const r = classifySource(repo, CFG_CONSULTANT, "/repo/5-personal/foo.md");
  assert.equal(r.ok, true);
});

test("classifySource: legacy 05-personal/ is private", () => {
  const r = classifySource("/repo", CFG_CONSULTANT, "/repo/05-personal/foo.md");
  assert.equal(r.ok, true);
});

test("classifySource: a dir already in sync_include is rejected", () => {
  const r = classifySource("/repo", CFG_CONSULTANT, "/repo/2-work/foo.md");
  assert.equal(r.ok, false);
  assert.match(r.reason, /already syncs/);
});

test("classifySource: an undeclared top-level dir (e.g. 6-business) is treated as private", () => {
  const r = classifySource("/repo", CFG_CONSULTANT, "/repo/6-business/portfolio/deck.md");
  assert.equal(r.ok, true);
  assert.equal(r.top, "6-business");
});

test("classifySource: source outside the repo is rejected", () => {
  const r = classifySource("/repo", CFG_CONSULTANT, "/elsewhere/foo.md");
  assert.equal(r.ok, false);
});

// ── resolveDestination ───────────────────────────────────────────────────────
test("resolveDestination: bare '2-work' → team, basename appended", () => {
  const d = resolveDestination("2-work", "case-study.md", CFG_CONSULTANT);
  assert.equal(d.ok, true);
  assert.equal(d.destRel, path.join("2-work", "case-study.md"));
  assert.equal(d.tier, "team");
});

test("resolveDestination: 'team' alias resolves the same as '2-work'", () => {
  const d = resolveDestination("team", "case-study.md", CFG_CONSULTANT);
  assert.equal(d.destRel, path.join("2-work", "case-study.md"));
  assert.equal(d.tier, "team");
});

test("resolveDestination: '4-shared' in consultant context → client", () => {
  const d = resolveDestination("4-shared", "deck.md", CFG_CONSULTANT);
  assert.equal(d.tier, "client");
  assert.equal(d.destRel, path.join("4-shared", "deck.md"));
});

test("resolveDestination: '4-shared' in employee context → company", () => {
  const d = resolveDestination("4-shared", "deck.md", CFG_EMPLOYEE);
  assert.equal(d.tier, "company");
});

test("resolveDestination: explicit 'client'/'company' override context", () => {
  assert.equal(resolveDestination("client", "d.md", CFG_EMPLOYEE).tier, "client");
  assert.equal(resolveDestination("company", "d.md", CFG_CONSULTANT).tier, "company");
});

test("resolveDestination: a fuller path under a known root is honored", () => {
  const d = resolveDestination("2-work/case-studies/deck.md", "deck.md", CFG_CONSULTANT);
  assert.equal(d.ok, true);
  assert.equal(d.destRel, "2-work/case-studies/deck.md");
  assert.equal(d.tier, "team");
});

test("resolveDestination: unrecognized value fails without throwing/exiting", () => {
  const d = resolveDestination("1-inbox", "deck.md", CFG_CONSULTANT);
  assert.equal(d.ok, false);
  assert.match(d.reason, /must be 2-work/);
});

test("resolveDestination: empty --to returns null (caller should prompt)", () => {
  assert.equal(resolveDestination("", "d.md", CFG_CONSULTANT), null);
  assert.equal(resolveDestination(undefined, "d.md", CFG_CONSULTANT), null);
});

test("outwardLabel: consultant → client, employee → company", () => {
  assert.equal(outwardLabel(CFG_CONSULTANT), "client");
  assert.equal(outwardLabel(CFG_EMPLOYEE), "company");
  assert.equal(outwardLabel({}), "client"); // default
});

// ── rewriteFrontmatter ───────────────────────────────────────────────────────
test("rewriteFrontmatter: injects a minimal block when none exists", () => {
  const out = rewriteFrontmatter("# Just a heading\n\nbody text\n", "team", "alex");
  assert.match(out, /^---\nstatus: draft\nowner: alex\naccess: team\n---\n\n# Just a heading/);
});

test("rewriteFrontmatter: rewrites an existing access field, preserving other fields", () => {
  const src =
    '---\nstatus: final\nowner: alex\naccess: private\ntype: "Deliverable"\n---\n\n# Body\n';
  const out = rewriteFrontmatter(src, "client", "alex");
  assert.match(out, /access: client/);
  assert.doesNotMatch(out, /access: private/);
  assert.match(out, /status: final/);
  assert.match(out, /type: "Deliverable"/);
  assert.match(out, /# Body/);
});

test("rewriteFrontmatter: adds access when frontmatter exists but has no access field", () => {
  const src = "---\nstatus: draft\nowner: sam\n---\n\n# Body\n";
  const out = rewriteFrontmatter(src, "company", "sam");
  assert.match(out, /status: draft\nowner: sam\naccess: company\n---/);
});

// ── decision log: path resolution + row append ──────────────────────────────
test("decisionLogPath: prefers the canonical 3-log/ path when present", () => {
  const dir = tmpWorkspace();
  try {
    assert.equal(decisionLogPath(dir), path.join(dir, "3-log", "decision-log.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decisionLogPath: falls back to legacy 03-status/ when 3-log/ is absent", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-promote-legacy-"));
  try {
    mkdirSync(path.join(dir, "03-status"), { recursive: true });
    writeFileSync(path.join(dir, "03-status", "decision-log.md"), "# Decision Log\n");
    assert.equal(decisionLogPath(dir), path.join(dir, "03-status", "decision-log.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendDecisionRow: inserts newest-first, right after the separator row", () => {
  const content =
    "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
    "|---|------|----------|-----------|------------|--------|------|----------|\n" +
    "| 3 | 2026-01-01 | Old decision | why | alex | impact | 1 | team |\n";
  const out = appendDecisionRow(content, {
    n: 4,
    date: "2026-07-13",
    decision: "New decision",
    rationale: "reason",
    decidedBy: "sam",
    impact: "impact",
    type: 2,
    audience: "team",
  });
  const lines = out.split("\n").filter(Boolean);
  const sepIdx = lines.findIndex((l) => l.startsWith("|---"));
  assert.match(lines[sepIdx + 1], /^\| 4 \| 2026-07-13 \| New decision \|/);
  assert.match(lines[sepIdx + 2], /^\| 3 \| 2026-01-01 \| Old decision \|/);
});

test("appendDecisionRow: writes a fresh header + row when no table exists yet", () => {
  const out = appendDecisionRow("# Decision Log\n", {
    n: 1,
    date: "2026-07-13",
    decision: "First decision",
    rationale: "reason",
    decidedBy: "sam",
    impact: "impact",
    type: 1,
    audience: "team",
  });
  assert.match(out, /\| # \| Date \| Decision/);
  assert.match(out, /\| 1 \| 2026-07-13 \| First decision \|/);
});

// ── cmdPromote: end-to-end against a throwaway workspace ────────────────────
test("cmdPromote: copies, scans, rewrites frontmatter, and logs a decision", async () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(
      path.join(dir, "5-personal", "case-study.md"),
      "# Case study\n\nSome reusable content.\n"
    );
    await cmdPromote(dir, CFG_CONSULTANT, ["5-personal/case-study.md", "--to", "2-work"], {
      resolveMember: () => "alex",
      scanFile: async () => ({ clean: true, findings: [] }),
      now: () => new Date("2026-07-13T00:00:00Z"),
    });

    // Original untouched.
    assert.ok(existsSync(path.join(dir, "5-personal", "case-study.md")));
    const original = readFileSync(path.join(dir, "5-personal", "case-study.md"), "utf8");
    assert.equal(original, "# Case study\n\nSome reusable content.\n");

    // Copy exists with access: team frontmatter.
    const copied = readFileSync(path.join(dir, "2-work", "case-study.md"), "utf8");
    assert.match(copied, /access: team/);
    assert.match(copied, /owner: alex/);
    assert.match(copied, /# Case study/);

    // Decision log got a new row (#4, since the fixture seeded #3).
    const log = readFileSync(path.join(dir, "3-log", "decision-log.md"), "utf8");
    assert.match(
      log,
      /\| 4 \| 2026-07-13 \| Promoted 5-personal\/case-study\.md to 2-work\/case-study\.md/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPromote: dry-run performs no writes at all", async () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(path.join(dir, "5-personal", "case-study.md"), "# Case study\n");
    const before = readFileSync(path.join(dir, "3-log", "decision-log.md"), "utf8");

    await cmdPromote(
      dir,
      CFG_CONSULTANT,
      ["5-personal/case-study.md", "--to", "2-work", "--dry-run"],
      {
        resolveMember: () => "alex",
        scanFile: async () => {
          throw new Error("scanFile must not be called on --dry-run");
        },
      }
    );

    assert.equal(existsSync(path.join(dir, "2-work", "case-study.md")), false);
    const after = readFileSync(path.join(dir, "3-log", "decision-log.md"), "utf8");
    assert.equal(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// die()-invoking failure paths call process.exit(1); each runs cmdPromote in a CHILD
// process (see runPromoteChild) so the harness survives and we assert on exit code +
// on-disk state, mirroring test/pr.test.mjs's convention for the same shape of test.

test("cmdPromote: a failed scan deletes the copy and writes nothing else (child process)", () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(path.join(dir, "5-personal", "leaky.md"), "api_key: sk-ant-super-secret-value\n");
    const before = readFileSync(path.join(dir, "3-log", "decision-log.md"), "utf8");

    const script =
      `import { cmdPromote } from ${JSON.stringify(PROMOTE_MOD)};` +
      `await cmdPromote(${JSON.stringify(dir)}, {context:"consultant",sync_include:["2-work","4-shared"]}, ` +
      `["5-personal/leaky.md","--to","2-work"], ` +
      `{ resolveMember: () => "alex", scanFile: async () => ({ clean: false, findings: ["mock: forbidden term found"] }) });`;
    let code = 0;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status ?? -1;
    }

    assert.equal(code, 1);
    assert.equal(existsSync(path.join(dir, "2-work", "leaky.md")), false);
    const after = readFileSync(path.join(dir, "3-log", "decision-log.md"), "utf8");
    assert.equal(before, after, "decision log must be untouched when the scan fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPromote: refuses a source that already syncs (not a private location)", () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(path.join(dir, "2-work", "already-team.md"), "# Already team\n");
    const res = runPromoteChild(dir, ["2-work/already-team.md", "--to", "4-shared"]);
    assert.equal(res.code, 1);
    assert.match(res.err, /already syncs/);
    assert.equal(existsSync(path.join(dir, "4-shared", "already-team.md")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPromote: refuses to overwrite an existing destination file", () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(path.join(dir, "5-personal", "dup.md"), "# Source\n");
    writeFileSync(path.join(dir, "2-work", "dup.md"), "# Already there\n");
    const res = runPromoteChild(dir, ["5-personal/dup.md", "--to", "2-work"]);
    assert.equal(res.code, 1);
    assert.match(res.err, /already exists/);
    // Untouched — never clobbered.
    assert.equal(readFileSync(path.join(dir, "2-work", "dup.md"), "utf8"), "# Already there\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPromote: unrecognized --to value aborts before any copy", () => {
  const dir = tmpWorkspace();
  try {
    writeFileSync(path.join(dir, "5-personal", "x.md"), "# X\n");
    const res = runPromoteChild(dir, ["5-personal/x.md", "--to", "1-inbox"]);
    assert.equal(res.code, 1);
    assert.match(res.err, /must be 2-work/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
