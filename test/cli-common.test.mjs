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
  // Since AIO-545 (GRAIN W0-4) `c` is capability-aware: it emits SGR only when the stream
  // it is bound to can render it, and this test's stdout is usually a pipe. So each case
  // has to state the colour environment it is asserting for. The full detection table
  // lives in test/cli-common-color-characterization.test.mjs.
  //
  // Every colour-deciding variable is cleared, not just the one under test: restoring the
  // parent's FORCE_COLOR and then setting NO_COLOR would assert nothing, because
  // FORCE_COLOR outranks NO_COLOR — under a runner with FORCE_COLOR set (common in CI)
  // the suppression case would fail spuriously.
  const COLOR_ENV_KEYS = [
    "NO_COLOR",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "COLORTERM",
    "TERM",
    "CI",
  ];
  const withColorEnv = (overrides, fn) => {
    const saved = Object.fromEntries(COLOR_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of COLOR_ENV_KEYS) delete process.env[key];
    process.env.TERM = "xterm";
    Object.assign(process.env, overrides);
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  withColorEnv({ FORCE_COLOR: "1" }, () => {
    check("wraps in ANSI + reset", c.red("x") === "\x1b[0;31mx\x1b[0m");
    check("has bold (the 6th key aios.mjs needed)", c.bold("x") === "\x1b[1mx\x1b[0m");
  });

  // NO_COLOR rather than "is stdout a pipe?", so this holds whether the suite is run in a
  // terminal or under CI.
  withColorEnv({ NO_COLOR: "1" }, () => {
    check("suppressed when the environment says no colour", c.red("x") === "x");
  });
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
