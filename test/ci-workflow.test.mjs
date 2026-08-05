import test from "node:test";
import assert from "node:assert/strict";
import { ghExecutable, ciWorkflowState } from "../scripts/ci-workflow.mjs";

test("CI workflow preference distinguishes unset, explicit no, and explicit yes", () => {
  assert.equal(ciWorkflowState({}), null);
  assert.equal(ciWorkflowState({ ci_workflow: "false" }), false);
  assert.equal(ciWorkflowState({ ci_workflow: "true" }), true);
});

test("gh resolution accepts only an absolute explicit path", () => {
  const exists = (value) => value === "/trusted/gh";
  assert.equal(ghExecutable({ platform: "darwin", env: { AIOS_GH_PATH: "gh" }, exists }), null);
  assert.equal(
    ghExecutable({ platform: "darwin", env: { AIOS_GH_PATH: "/trusted/gh" }, exists }),
    "/trusted/gh"
  );
});
