#!/usr/bin/env node
// check-scaffold-git-workflow.mjs — OGR11: scaffolded workspaces ship git/workflow agent rules.
//
// Generates a throwaway workspace and asserts it contains the personal-workstation git
// contract in .claude/CLAUDE.md, AGENTS.md, and .claude/rules/git-workflow.md so new
// owners (and agents) don't treat their IC workspace as a toolkit PR staging area.
//
// Usage: ./validation/check-scaffold-git-workflow.mjs [repo]  (repo arg unused; kept for
// validate-all.sh's signature). Wired into validate-all.sh.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
let errors = 0;
const fail = (m) => {
  console.log(`  ${RED}✗${NC} ${m}`);
  errors++;
};
const ok = (m) => console.log(`  ${GREEN}✓${NC} ${m}`);

const REQUIRED_SNIPPETS = [
  { file: ".claude/CLAUDE.md", needles: ["Dogfood here, ship there", "aios-workspace", "master"] },
  { file: "AGENTS.md", needles: ["Dogfood notes here", "aios-workspace", "master"] },
  {
    file: ".claude/rules/git-workflow.md",
    needles: ["not a staging area", "aios-workspace", "master"],
  },
];

console.log("OGR11: scaffolded workspace ships git/workflow agent rules");
console.log("===========================================================");

const tmp = mkdtempSync(path.join(tmpdir(), "ogr11-"));
const ws = path.join(tmp, "ws");
try {
  execFileSync(
    "bash",
    [
      path.join(REPO, "scripts", "scaffold-project.sh"),
      "--slug",
      "ogr11-check",
      "--owner",
      "tester",
      "--context",
      "employee",
      "--output",
      ws,
      "--org",
      "test-org",
    ],
    { cwd: REPO, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
} catch (e) {
  fail(`scaffold-project.sh failed: ${String(e.stderr || e.message).split("\n")[0]}`);
}

if (existsSync(ws)) {
  for (const { file, needles } of REQUIRED_SNIPPETS) {
    const full = path.join(ws, file);
    if (!existsSync(full)) {
      fail(`workspace missing ${file}`);
      continue;
    }
    const text = readFileSync(full, "utf8");
    for (const needle of needles) {
      if (!text.includes(needle)) fail(`${file} missing required text: ${needle}`);
    }
    if (needles.every((n) => text.includes(n))) ok(`${file} contains git/workflow contract`);
  }
} else {
  fail("no workspace generated");
}

try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
} catch {
  /* best-effort cleanup */
}

console.log("===========================================================");
if (errors === 0) {
  console.log(`${GREEN}OGR11 PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}OGR11 FAILED — ${errors} issue(s)${NC}`);
process.exit(1);
