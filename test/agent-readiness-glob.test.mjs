#!/usr/bin/env node
// test/agent-readiness-glob.test.mjs — pins the agent-readiness glob engine to SEGMENT-STRICT,
// brace-correct semantics. This is the cross-scorer guard: the JS engine here must match the
// Team Brain Python scanner (ingestion/aios_ingest/analyzers/readiness.py `_glob_regex`), so a
// repo scores the same locally (`aios assess-codebase`) and on the dashboard.
//
// Regression: the old engine turned `{yml,yaml,json}` into an unanchored alternation, so the
// bare `yaml` arm matched ANY path containing "yaml" — `eval_harness` falsely passed (→ L4) on
// any repo with a .yaml file, disagreeing with the dashboard (→ L3).
//
// Run: node test/agent-readiness-glob.test.mjs

import { globToRegex } from "../validation/agent-readiness-lib.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
const m = (glob, path) => globToRegex(glob).test(path);

function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// Brace expansion is anchored per-extension (the bug).
check(
  "promptfoo.yaml matches promptfoo glob",
  m("**/promptfoo*.{yml,yaml,json}", "promptfoo.yaml")
);
check(
  "nested promptfoo.config.json matches",
  m("**/promptfoo*.{yml,yaml,json}", "a/b/promptfoo.config.json")
);
check(
  "a plain .yaml does NOT match the promptfoo glob (the regression)",
  !m("**/promptfoo*.{yml,yaml,json}", "scaffold/project.yaml.tmpl")
);
check("docs/foo.yaml does NOT match", !m("**/promptfoo*.{yml,yaml,json}", "docs/foo.yaml"));

// ** is segment-strict: `**/eval/**` needs a path segment exactly "eval".
check("**/eval/** matches eval/x.py", m("**/eval/**", "eval/x.py"));
check("**/eval/** matches a/eval/x.py", m("**/eval/**", "a/eval/x.py"));
check(
  "**/eval/** does NOT match eval-viewer/x (segment-strict)",
  !m("**/eval/**", "a/eval-viewer/x.py")
);
check("**/eval/** does NOT match myeval/x (segment-strict)", !m("**/eval/**", "myeval/x.py"));

// *.eval.* and single-segment *.
check("**/*.eval.* matches foo.eval.ts", m("**/*.eval.*", "src/foo.eval.ts"));
check("**/*.eval.* does NOT match eval_review.html", !m("**/*.eval.*", "eval_review.html"));
check("* does not cross a slash", !m("*.py", "src/foo.py"));
check("**/*.py crosses slashes", m("**/*.py", "src/foo.py"));

if (failed) {
  console.log(`\n${RED}agent-readiness-glob.test: ${failed} failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}agent-readiness-glob.test: all checks passed${NC}`);
