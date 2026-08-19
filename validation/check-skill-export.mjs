#!/usr/bin/env node
// check-skill-export.mjs — OGR06: BYOA skill-export round-trip
//
// Asserts every workspace skill exports cleanly for each agent runtime and that
// SKILL.md stays the single source of truth: valid frontmatter (name +
// non-block-scalar description), exactly one H1, claude-code identity preserves
// the .workflow.js, and multi-agent harnesses are flagged as degraded on
// runtimes that can't run them. See docs/byoa.md (BYOA Phase 2).
//
// Usage: ./validation/check-skill-export.mjs <path-to-team-ops-repo>
// Wired into validate-all.sh as OGR06.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AIOS = path.join(SCRIPT_DIR, "..", "scripts", "aios.mjs");
const RUNTIMES = ["claude-code", "hermes", "openclaw", "codex", "opencode", "claude-api"];

/**
 * Count real H1 headings, ignoring fenced code blocks.
 *
 * AIO-965: this used to be `text.match(/^# /gm)`, which counts every shell comment inside a
 * ```bash fence as a heading. Four correct skills in a real workspace failed on it —
 * aios-spec-write reported 6 H1s for one heading plus five `# 1. Fast pass first…` comments in
 * its worked example. The rule is right (one H1 per SKILL.md); the reading of it was not, and a
 * validator that fires on correct content is one people route around.
 *
 * Tracks ``` and ~~~ fences, including longer runs and info strings, per CommonMark: a fence is
 * closed only by a marker of the same character and at least the same length.
 */
function countH1(text) {
  let count = 0;
  let fence = null; // { char, len }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!fence) {
        // An opening fence may carry an info string; a closing one may not.
        fence = { char, len };
        continue;
      }
      if (char === fence.char && len >= fence.len && m[2].trim() === "") {
        fence = null;
      }
      continue;
    }
    if (!fence && /^# /.test(line)) count++;
  }
  return count;
}

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: check-skill-export.mjs <repo>");
  process.exit(1);
}

// A user workspace keeps skills at .claude/skills; the toolkit repo in scaffold/.
let src = repo;
if (existsSync(path.join(repo, "scaffold", ".claude", "skills"))) src = path.join(repo, "scaffold");

console.log("OGR06: BYOA skill export round-trip");
console.log("================================================");

if (!existsSync(path.join(src, ".claude", "skills"))) {
  console.log(`  ${GREEN}✓${NC} no .claude/skills — nothing to export (valid)`);
  console.log(`${GREEN}OGR06 PASSED${NC}`);
  process.exit(0);
}

let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

for (const rt of RUNTIMES) {
  const out = mkdtempSync(path.join(tmpdir(), `byoa-${rt}-`));
  try {
    execFileSync("node", [AIOS, "skills", "export", "--runtime", rt, "--repo", src, "--out", out], {
      stdio: "pipe",
    });
  } catch (e) {
    fail(`${rt} — export failed: ${String(e.stderr || e.message).split("\n")[0]}`);
    rmSync(out, { recursive: true, force: true });
    continue;
  }

  const files = existsSync(out) ? walk(out) : [];
  const skillDirs = readdirSync(out).filter((n) => statSync(path.join(out, n)).isDirectory());
  if (!skillDirs.length) {
    fail(`${rt} — no skills emitted`);
    rmSync(out, { recursive: true, force: true });
    continue;
  }

  if (rt === "claude-code") {
    // identity copy must preserve the multi-agent harness executable
    if (!files.some((f) => f.endsWith(".workflow.js")))
      fail("claude-code — .workflow.js not preserved");
  } else if (rt === "hermes" || rt === "openclaw") {
    for (const f of files.filter((f) => path.basename(f) === "SKILL.md")) {
      const name = path.basename(path.dirname(f));
      const text = readFileSync(f, "utf8");
      const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
      if (!/^name:\s*\S/m.test(fm)) fail(`${rt}/${name} — missing name:`);
      const desc = (fm.match(/^description:\s*(.*)$/m) || [])[1]?.trim() ?? "";
      if (!desc || /^["']?[|>][-+]?["']?$/.test(desc))
        fail(`${rt}/${name} — empty/block-scalar description`);
      const h1 = countH1(text);
      if (h1 !== 1) fail(`${rt}/${name} — expected exactly 1 H1, got ${h1}`);
    }
  } else {
    if (!files.some((f) => f.endsWith(".md"))) fail(`${rt} — no instruction .md emitted`);
  }

  // A known multi-agent harness (decision-audit) must be flagged as degraded off claude-code.
  if (rt !== "claude-code" && existsSync(path.join(out, "decision-audit"))) {
    const da = walk(path.join(out, "decision-audit")).find((f) => f.endsWith(".md"));
    if (da && !readFileSync(da, "utf8").includes("single-agent")) {
      fail(`${rt} — decision-audit harness not flagged as degraded`);
    }
  }

  if (!errors)
    console.log(`  ${GREEN}✓${NC} ${rt} — ${skillDirs.length} skill(s) exported & validated`);
  rmSync(out, { recursive: true, force: true });
}

console.log("================================================");
if (errors === 0) {
  console.log(`${GREEN}OGR06 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR06 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
