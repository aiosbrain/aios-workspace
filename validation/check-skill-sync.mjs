#!/usr/bin/env node
// check-skill-sync.mjs — OGR17: a skill that lives in BOTH trees must be byte-identical.
//
// THE BUG. This repo keeps two skill trees: `.claude/skills/` (dev-facing skills used while
// working ON the toolkit — ast-grep, code-review, start-safe-worktree) and
// `scaffold/.claude/skills/` (what a scaffolded workspace RECEIVES — aios-sync, decision-audit,
// weekly-synthesis). They are mostly disjoint BY DESIGN and must stay that way.
//
// A handful of skills legitimately live in both. Those copies drift, silently, because nothing
// makes editing one imply editing the other. AIO-942's "Where" section records three
// independently-drifted copies accumulating exactly this way in 2026-08, and when this check was
// written the overlap was two skills and ONE of them was already drifted — a 50% drift rate, with
// the clean half clean only because someone hand-copied it four times while working on something
// else and happened not to forget.
//
// WHY THE NAIVE VERSION IS WRONG. "The two trees must match" would fail instantly on ~50 files
// that differ deliberately. The assertion is deliberately NARROW: for the INTERSECTION only,
// contents must be identical. Everything outside it is intentional and untouched.
//
// Sibling of OGR16 (check-citations.mjs): same family — the shipped surface must match its source
// of truth — one layer up, over skills rather than validators. Toolkit-only; a workspace has no
// scaffold/ tree, so it exits 0 there.
//
// Zero dependencies (node builtins only).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  YELLOW = "\x1b[1;33m",
  NC = "\x1b[0m";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(SCRIPT_DIR, ".."));

const DEV_TREE = path.join(repo, ".claude", "skills");
const SHIP_TREE = path.join(repo, "scaffold", ".claude", "skills");

/**
 * Generated/derived artifacts that are not source and must never decide a drift verdict. Without
 * this, an untracked __pycache__ beside one copy reports as drift and buries the real one-file
 * divergence in noise — which is how a guard gets muted.
 */
const IGNORED = [
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /\.pyc$/,
];
const ignored = (rel) => IGNORED.some((re) => re.test(rel));

let errors = 0;
const fail = (msg) => {
  console.log(`  ${RED}✗${NC} ${msg}`);
  errors++;
};

console.log(`OGR17: shared skills are identical in both trees`);
console.log("================================================");

if (!existsSync(SHIP_TREE) || !existsSync(DEV_TREE)) {
  console.log(
    `  ${YELLOW}!${NC} not a toolkit checkout (no scaffold/ skills tree) — nothing to check`
  );
  process.exit(0);
}

const dirsIn = (p) =>
  readdirSync(p).filter((e) => {
    try {
      return statSync(path.join(p, e)).isDirectory();
    } catch {
      return false;
    }
  });

const shared = dirsIn(DEV_TREE).filter((d) => dirsIn(SHIP_TREE).includes(d));
console.log(`\nSkills in both trees: ${shared.length ? shared.join(", ") : "(none)"}`);

/** Every non-ignored file under `dir`, relative to it. */
function filesIn(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(base, full);
    if (ignored(rel)) continue;
    if (statSync(full).isDirectory()) filesIn(full, base, out);
    else out.push(rel);
  }
  return out;
}

for (const skill of shared) {
  const a = path.join(DEV_TREE, skill);
  const b = path.join(SHIP_TREE, skill);
  const filesA = new Set(filesIn(a));
  const filesB = new Set(filesIn(b));

  for (const f of filesA)
    if (!filesB.has(f)) fail(`${skill}/${f} — only in .claude/skills (missing from scaffold/)`);
  for (const f of filesB)
    if (!filesA.has(f))
      fail(`${skill}/${f} — only in scaffold/.claude/skills (missing from .claude/)`);

  for (const f of filesA) {
    if (!filesB.has(f)) continue;
    const left = readFileSync(path.join(a, f));
    const right = readFileSync(path.join(b, f));
    if (left.equals(right)) continue;
    // Name the file AND the size of the divergence — "the trees differ" is not actionable.
    const changed = countChangedLines(left.toString("utf8"), right.toString("utf8"));
    fail(
      `${skill}/${f} — differs between .claude/skills and scaffold/.claude/skills ` +
        `(${changed} changed line(s)). Edit one, copy to the other; they ship as one skill.`
    );
  }
}

/** Cheap line-level divergence count — enough to size a drift, not a diff implementation. */
function countChangedLines(x, y) {
  const a = x.split(/\r?\n/);
  const b = y.split(/\r?\n/);
  const setB = new Set(b);
  const setA = new Set(a);
  return a.filter((l) => !setB.has(l)).length + b.filter((l) => !setA.has(l)).length;
}

console.log("\n================================================");
if (errors > 0) {
  console.log(`${RED}OGR17 FAILED — ${errors} drifted file(s)${NC}`);
  process.exit(1);
}
console.log(`${GREEN}OGR17 PASSED — ${shared.length} shared skill(s) in sync${NC}`);
