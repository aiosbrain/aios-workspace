#!/usr/bin/env node
// test/cli-common.test.mjs — characterization tests for the shared CLI primitives
// consolidated in scripts/cli-common.mjs (AIO-315). Zero-dep, no network.
// Run: node test/cli-common.test.mjs
//
// The load-bearing case: scripts/aios.mjs used to have its OWN slugify that stripped
// only a single leading/trailing hyphen (/^-|-$/g), and it derives the durable
// `project`/`member` identifiers stamped into loop manifests + tier-tagged brain
// pushes. Consolidating onto the shared run-strip slugify (/^-+|-+$/g) is a flagged
// behaviour change; this test pins that for REAL identity inputs (repo basenames,
// git user names) the output is byte-identical, so no brain-side identity/dedupe key
// silently changes. It also pins build.mjs's bound {maxLen:40, fallback:"task"} form.

import { c, die, sha256, slugify, gitConfig } from "../scripts/cli-common.mjs";
import { slugify as buildSlugify } from "../scripts/build.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// The exact pre-AIO-315 scripts/aios.mjs slugify (single-hyphen strip, not null-safe).
// Kept here only to prove equivalence for real identity inputs.
function oldAiosSlugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

console.log("slugify — base semantics");
{
  check("lowercases + hyphenates", slugify("John Ellison") === "john-ellison");
  check("collapses non-alnum runs", slugify("a__b  c") === "a-b-c");
  check("strips hyphen runs both ends", slugify("--foo--") === "foo");
  check("null-safe", slugify(null) === "" && slugify(undefined) === "");
  check("no clamp by default", slugify("x".repeat(60)).length === 60);
  check("empty stays empty without fallback", slugify("!!!") === "");
}

console.log("slugify — durable identity inputs are unchanged (aios.mjs project/member)");
{
  // Representative repo basenames and git user names that feed cfg.project / member.
  const identityInputs = [
    "aios-workspace",
    "aios-workspace-john-aio-315-decompose-scriptsaiosmjs-operator-loop-command-extraction",
    "John Ellison",
    "john.ellison",
    "Chetan",
    "my_project",
    "ACME Corp",
    "a-b-c",
  ];
  for (const s of identityInputs) {
    check(`identity slug stable: "${s}" → "${slugify(s)}"`, slugify(s) === oldAiosSlugify(s));
  }
}

console.log("slugify — build.mjs bound form { maxLen: 40, fallback: 'task' }");
{
  check(
    "lowercases + hyphenates (build)",
    buildSlugify("Add an aios Build Phase!! (v2)") === "add-an-aios-build-phase-v2"
  );
  check("empty → task (build)", buildSlugify("") === "task");
  check("caps length ≤ 40 (build)", buildSlugify("x".repeat(100)).length <= 40);
  check(
    "base form has no clamp/fallback (contrast)",
    slugify("") === "" && slugify("x".repeat(100)).length === 100
  );
}

console.log("sha256");
{
  check(
    "known digest",
    sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
}

console.log("c (colours)");
{
  check("wraps in ANSI + reset", c.red("x") === "\x1b[0;31mx\x1b[0m");
  check("has bold (the 6th key aios.mjs needed)", c.bold("x") === "\x1b[1mx\x1b[0m");
}

console.log("gitConfig");
{
  // Unreadable repo path → "" (never throws).
  check("missing repo → empty string", gitConfig("/nonexistent-repo-xyz", "user.name") === "");
  check("is a function", typeof gitConfig === "function");
}

console.log("die");
{
  check("is a function", typeof die === "function");
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
