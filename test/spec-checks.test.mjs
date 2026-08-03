import { test } from "node:test";
import assert from "node:assert/strict";

import { assessScopeFence, runDeterministicChecks } from "../scripts/spec-checks.mjs";

function sr18Blocks(specText) {
  return runDeterministicChecks(specText).some(
    (finding) => finding.ruleId === "SR18" && finding.severity === "blocker"
  );
}

test("SR18 ignores a per-file leave-unchanged note inside Scope", () => {
  const perFile = [
    "# Spec",
    "## Scope",
    "- `scripts/relay.mjs` — the gate hard-codes the rubric path; leave it unchanged.",
  ].join("\n");
  assert.equal(assessScopeFence(perFile).fenced, false);
  assert.equal(sr18Blocks(perFile), false);

  const classWide = "# Spec\n## Scope\nLeave all rendered pages unchanged.";
  assert.equal(assessScopeFence(classWide).fenced, true);
  assert.equal(sr18Blocks(classWide), true);
});

test("SR18 evaluates constraints nested beneath a scope heading", () => {
  const spec = [
    "# Spec",
    "## Scope",
    "**In:** the new page.",
    "### Constraints",
    "No change to any file that `/` renders.",
  ].join("\n");
  assert.equal(assessScopeFence(spec).fenced, true);
  assert.equal(sr18Blocks(spec), true);
});
