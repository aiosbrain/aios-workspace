#!/usr/bin/env node
// check-citations.mjs — OGR16: every cited validator is a shipped validator (AIO-965).
//
// THE BUG THIS EXISTS TO STOP. A scaffolded workspace's governance docs told the agent to run
// validators the scaffold never installed. `.claude/memory/README.md` claimed "OGR05
// (validation/check-rubrics.sh) checks that every instinct links at least one incident file that
// exists" — and check-rubrics.sh was not on disk. The rule was real, the guard was absent, and
// nothing surfaced the gap. An agent reads "this is enforced", believes it, and proceeds.
//
// A claimed check that does not run reads exactly like a passing one. That is the whole failure
// mode, and it applies to the guards themselves as readily as to the code they grade.
//
// THE FIX IS DERIVATION, NOT A HARDCODED LIST. The required set is whatever the shipped `.claude/`
// docs actually reference. Add a rule that cites a new validator and either the validator ships or
// this check fails — which is the property that stops the drift recurring, rather than fixing this
// one instance of it.
//
// TWO MODES, auto-detected the same way check-skill-export.mjs does it:
//   * TOOLKIT  (scaffold/.claude exists) — grade what the scaffold WILL ship: scan scaffold/.claude
//     for citations and assert each is in MANAGED_PATHS, and that MANAGED_PATHS and
//     scaffold-project.sh stay in lockstep.
//   * WORKSPACE (no scaffold/) — grade what this workspace HAS: scan .claude for citations and
//     assert each file is on disk and executable.
//
// Zero dependencies (node builtins only) — a workspace has no node_modules.

import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  YELLOW = "\x1b[1;33m",
  NC = "\x1b[0m";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(SCRIPT_DIR, ".."));

/**
 * Citations that are NOT enforcement claims, and the reason each is exempt. The ticket's own
 * outcome requires that a deliberately-excluded validator has its exclusion RECORDED rather than
 * being absent by accident — this list is that record, and it is the only way to exempt something.
 *
 * `check-modularity.mjs` is the case that proves the naive version of this check is wrong. Its one
 * reference in the scaffolded tree is a path-FORMATTING example in aios-spec-write/SKILL.md
 * ("write `validation/check-modularity.mjs`, not `aios-workspace/validation/check-modularity.mjs`"),
 * teaching how to cite a toolkit path inside a spec. Treating that as "the workspace enforces
 * modularity" would force-ship a devtools validator that needs the external codebase-memory-mcp and
 * ratchets against a toolkit-derived baseline (14721 deadCode vs limit 0 when pointed at a real
 * workspace). Deriving the set is right; deriving it without reading context is not.
 */
const NOT_ENFORCEMENT_CLAIMS = [
  {
    validator: "check-modularity.mjs",
    in: ".claude/skills/aios-spec-write/SKILL.md",
    why: "path-formatting example for spec authors, not a claim the workspace runs it; OGR13 is toolkit-only (needs codebase-memory-mcp + a toolkit baseline)",
  },
  {
    // Found by THIS check on its first run — a second, independent instance of the AIO-965 bug.
    // The scaffold ships a bookkeeping command citing check-ledger.sh, which exists nowhere in
    // the toolkit; john-workspace has one only because its owner wrote it. Bookkeeping is not a
    // toolkit concern, so the validator is deliberately owner-supplied and the doc hedges with
    // "(or workspace copy)". Recorded rather than silently tolerated: if bookkeeping ever becomes
    // a shipped capability, this entry is what has to be revisited.
    validator: "check-ledger.sh",
    in: ".claude/commands/process-statement.md",
    why: "owner-supplied bookkeeping validator — not a toolkit capability, and the citing doc marks it optional",
  },
];

/**
 * Validators deliberately NOT shipped into a workspace, with the reason. Cited or not, these must
 * never appear in MANAGED_PATHS — the check asserts the exclusion holds, so a future edit that
 * quietly adds one has to come here and say why it changed.
 */
const TOOLKIT_ONLY = [
  ["check-scaffold-guard.mjs", "takes no argv — grades the toolkit repo whatever path is passed"],
  ["check-scaffold-git-workflow.mjs", "takes no argv — grades the toolkit repo"],
  ["check-opencode-scaffold.mjs", "takes no argv — grades the toolkit repo"],
  [
    "check-runtime-adapters.mjs",
    "validates scripts/runtimes.mjs internals + the GUI adapter registry",
  ],
  ["check-modularity.mjs", "needs external codebase-memory-mcp; ratchets on a toolkit baseline"],
  [
    "check-delivery-skill-suite.mjs",
    "imports ajv + a toolkit script; a workspace has no node_modules",
  ],
];

const CITATION = /validation\/([A-Za-z0-9_.-]+\.(?:sh|mjs|json|txt))/g;

let errors = 0;
let warnings = 0;
const fail = (msg) => {
  console.log(`  ${RED}✗${NC} ${msg}`);
  errors++;
};
const warn = (msg) => {
  console.log(`  ${YELLOW}!${NC} ${msg}`);
  warnings++;
};
const ok = (msg) => console.log(`  ${GREEN}✓${NC} ${msg}`);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(md|mdx)(?:\.tmpl)?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Collect `validation/<file>` references from every markdown doc under a .claude tree. */
function collectCitations(claudeDir, repoRoot) {
  const found = new Map(); // validator -> Set(relative doc paths)
  for (const file of walk(claudeDir)) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(repoRoot, file);
    for (const m of text.matchAll(CITATION)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(rel);
    }
  }
  return found;
}

const exemptFor = (validator, docs) =>
  NOT_ENFORCEMENT_CLAIMS.find(
    (e) =>
      e.validator === validator && [...docs].every((d) => d.replace(/^scaffold\//, "") === e.in)
  );

const isToolkitOnly = (v) => TOOLKIT_ONLY.find(([name]) => name === v);

console.log(`OGR16: Validator citations resolve in ${repo}`);
console.log("================================================");

const scaffoldClaude = path.join(repo, "scaffold", ".claude");
const TOOLKIT_MODE = existsSync(scaffoldClaude);

if (TOOLKIT_MODE) {
  // ── Toolkit mode: does what we SHIP satisfy what the scaffolded docs CLAIM?
  const manifestPath = path.join(repo, "scripts", "toolkit-manifest.mjs");
  // The validator copy list lives in scaffold-validators.sh (extracted from scaffold-project.sh,
  // which is at its grandfathered size cap), but secret-patterns.txt is still copied by the caller
  // because it ships alongside the PreToolUse hook rather than the validator surface. Read BOTH, so
  // this check does not encode an assumption about which file a given copy line lives in.
  const manifestSrc = readFileSync(manifestPath, "utf8");
  const scaffoldSrc = ["scaffold-validators.sh", "scaffold-project.sh"]
    .map((f) => readFileSync(path.join(repo, "scripts", f), "utf8"))
    .join("\n");

  // What MANAGED_PATHS ships into validation/ — read as text so this check never has to import
  // (and therefore never has to stay in sync with) the manifest module's evolving shape.
  const managed = new Set(
    [...manifestSrc.matchAll(/dest:\s*"validation\/([A-Za-z0-9_.-]+)"/g)].map((m) => m[1])
  );
  // What scaffold-project.sh copies. Two shapes: literal `$REPO_ROOT/validation/<name>` cp lines,
  // and the `for validator in <names>; do cp …/$validator` loop, whose names never appear next to
  // the validation/ prefix. Reading only the literal form would silently under-count the loop and
  // report every looped validator as a lockstep break.
  const scaffolded = new Set(
    [...scaffoldSrc.matchAll(/\$REPO_ROOT\/validation\/([A-Za-z0-9_.-]+)/g)]
      .map((m) => m[1])
      .filter((n) => !n.startsWith("$"))
  );
  const loop = /for\s+validator\s+in\s+([\s\S]*?);\s*do/.exec(scaffoldSrc);
  if (loop) for (const name of loop[1].split(/[\s\\]+/).filter(Boolean)) scaffolded.add(name);

  console.log(`\nShipped set: ${managed.size} file(s) in MANAGED_PATHS`);

  // 1. Lockstep — the two lists are the single definition of the workspace toolkit surface.
  for (const f of managed)
    if (!scaffolded.has(f))
      fail(`${f} is in MANAGED_PATHS but scaffold-project.sh never copies it`);
  for (const f of scaffolded)
    if (!managed.has(f)) fail(`${f} is copied by scaffold-project.sh but is not in MANAGED_PATHS`);
  if (errors === 0) ok(`MANAGED_PATHS and scaffold-project.sh agree on ${managed.size} file(s)`);

  // 2. Everything shipped actually exists upstream.
  for (const f of managed)
    if (!existsSync(path.join(repo, "validation", f)))
      fail(`${f} is shipped but does not exist in validation/`);

  // 3. The exclusions hold.
  for (const [name, why] of TOOLKIT_ONLY)
    if (managed.has(name))
      fail(`${name} is recorded toolkit-only (${why}) but appears in MANAGED_PATHS`);

  // 4. THE CORE CHECK — every citation in the scaffolded .claude tree resolves to a shipped file.
  const citations = collectCitations(scaffoldClaude, repo);
  console.log(`\nCitations found in scaffold/.claude: ${citations.size} distinct validator(s)`);
  for (const [validator, docs] of [...citations].sort()) {
    if (managed.has(validator)) {
      ok(`${validator} — cited and shipped`);
      continue;
    }
    const exempt = exemptFor(validator, docs);
    if (exempt) {
      warn(`${validator} — cited in ${exempt.in} but exempt: ${exempt.why}`);
      continue;
    }
    const only = isToolkitOnly(validator);
    fail(
      `${validator} cited by ${[...docs].join(", ")} but NOT shipped` +
        (only
          ? ` — it is recorded toolkit-only (${only[1]}), so either stop citing it in a scaffolded doc or record the citation as illustrative in NOT_ENFORCEMENT_CLAIMS`
          : " — add it to MANAGED_PATHS + scaffold-project.sh, or record why it is exempt")
    );
  }
} else {
  // ── Workspace mode: does THIS workspace carry every validator its own docs cite?
  const claudeDir = path.join(repo, ".claude");
  if (!existsSync(claudeDir)) {
    console.log(`  ${YELLOW}!${NC} no .claude/ directory — nothing to check`);
    process.exit(0);
  }
  const citations = collectCitations(claudeDir, repo);
  console.log(`\nCitations found in .claude: ${citations.size} distinct validator(s)`);
  for (const [validator, docs] of [...citations].sort()) {
    const target = path.join(repo, "validation", validator);
    if (!existsSync(target)) {
      const exempt = exemptFor(validator, docs);
      if (exempt) {
        warn(`${validator} — cited in ${exempt.in} but exempt: ${exempt.why}`);
        continue;
      }
      fail(
        `${validator} cited by ${[...docs].join(", ")} but missing from validation/ — ` +
          `run \`aios update\` to vendor the shipped validators`
      );
      continue;
    }
    // A validator present but not runnable is the same broken promise with extra steps.
    if (/\.(sh|mjs)$/.test(validator)) {
      try {
        accessSync(target, constants.X_OK);
      } catch {
        fail(`${validator} exists but is not executable`);
        continue;
      }
    }
    ok(`${validator} — cited and present`);
  }
}

console.log("\n================================================");
if (errors > 0) {
  console.log(`${RED}OGR16 FAILED — ${errors} dangling citation(s)/mismatch(es)${NC}`);
  process.exit(1);
}
console.log(
  `${GREEN}OGR16 PASSED — every cited validator is shipped${NC}` +
    (warnings ? ` (${warnings} recorded exemption(s))` : "")
);
