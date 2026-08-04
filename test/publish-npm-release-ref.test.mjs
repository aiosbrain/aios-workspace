import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8"
);

test("workspace npm publishing is manual and requires the exact immutable release tag", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /GIT_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /GIT_REF_TYPE: \$\{\{ github\.ref_type \}\}/);
  assert.match(workflow, /if \[ "\$INPUT_PACKAGE" = "aios" \]; then/);
  assert.match(workflow, /EXPECTED_REF="refs\/tags\/v\$PKG_VERSION"/);
  assert.match(workflow, /"\$PKG_VERSION" == \*-\*/);
  assert.match(workflow, /must not publish to npm's stable latest channel/);
  assert.match(workflow, /"\$GIT_REF_TYPE" != "tag"/);
  assert.match(workflow, /"\$GIT_REF" != "\$EXPECTED_REF"/);

  const guard = workflow.indexOf('EXPECTED_REF="refs/tags/v$PKG_VERSION"');
  const publish = workflow.indexOf("run: npm publish");
  assert.ok(guard >= 0 && publish > guard, "the exact-tag guard must run before publish");
});
