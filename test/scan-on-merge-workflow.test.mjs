import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/scan-on-merge.yml", import.meta.url)
);
const workflow = readFileSync(workflowPath, "utf8");

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const SETUP_PYTHON_SHA = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const BRAIN_SHA = "8c29919236e602af63508abf5e988d4ab1d97eff";

test("scan-on-merge grants only read access to repository contents", () => {
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /(?:contents|actions|checks|packages|pull-requests): write/);
});

test("scan-on-merge pins every third-party action to an immutable commit", () => {
  assert.equal(
    (workflow.match(new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "g")) ?? []).length,
    2
  );
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
  assert.match(workflow, new RegExp(`actions/setup-python@${SETUP_PYTHON_SHA}`));

  const actionRefs = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length > 0);
  assert.ok(
    actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)),
    actionRefs.join(", ")
  );
});

test("Team Brain scanner checkout is anonymous and bound to an exact commit", () => {
  assert.match(workflow, new RegExp(`ref: ${BRAIN_SHA}`));
  assert.match(
    workflow,
    /repository: aiosbrain\/aios-team-brain[\s\S]*?persist-credentials: false\n\s+token: ""/
  );
  assert.doesNotMatch(workflow, /BRAIN_REPO_TOKEN/);
});

test("both checkouts discard credentials", () => {
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
});
