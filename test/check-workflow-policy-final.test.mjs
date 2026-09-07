import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowYaml } from "../scripts/workflow-yaml.mjs";
import { auditWorkflow, computeReachability } from "../scripts/workflow-policy-rules.mjs";

function file(rel, yaml) {
  return { rel, doc: parseWorkflowYaml(yaml) };
}

for (const jobs of [
  "  __proto__:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'echo ${{ secrets.TOKEN }}' }]",
  "  __proto__: { runs-on: ubuntu-latest, steps: [{ run: 'echo ${{ secrets.TOKEN }}' }] }",
]) {
  test(`prototype key fails closed: ${jobs.split("\n")[0]}`, () => {
    assert.throws(() => parseWorkflowYaml(`on: pull_request\njobs:\n${jobs}\n`), /__proto__/);
  });
}

for (const trigger of ["workflow_call", "[workflow_call]", "[workflow_dispatch, workflow_call]"]) {
  test(`reusable scalar/list trigger propagates origin: ${trigger}`, () => {
    const caller = file(
      "caller.yml",
      "on: pull_request_target\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n"
    );
    const callee = file(
      "callee.yml",
      `on: ${trigger}\njobs:\n  install:\n    steps: [{ run: npm ci }]\n`
    );
    const via = computeReachability([caller, callee]).get(callee.rel);
    assert.equal(via?.prTarget, true);
    assert.ok(
      auditWorkflow(callee, via.prTarget).some((f) => f.rule === "pr-target-package-install")
    );
  });
}

test("both trigger edges retain the strongest origin", () => {
  const files = [
    file("pr.yml", "name: plain\non: pull_request\njobs: {}\n"),
    file(
      "caller.yml",
      "on: pull_request_target\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n"
    ),
    file(
      "callee.yml",
      "on:\n  workflow_run:\n    workflows: [plain]\n  workflow_call: {}\njobs:\n  install:\n    steps: [{ run: npm ci }]\n"
    ),
  ];
  assert.equal(computeReachability(files).get("callee.yml")?.prTarget, true);
  files[1].doc.on = "schedule";
  assert.equal(computeReachability(files).get("callee.yml")?.prTarget, false);
});

test("whole event is tainted while event_name stays trusted", () => {
  for (const [expression, expected] of [
    ["toJSON(github.event)", true],
    ["github.event_name", false],
  ]) {
    const probe = file(
      "event.yml",
      `on: pull_request_target\npermissions: { contents: read }\njobs:\n  probe:\n    steps:\n      - run: echo '\${{ ${expression} }}'\n`
    );
    assert.equal(
      auditWorkflow(probe, true).some((f) => f.rule === "pr-target-dynamic-run"),
      expected
    );
  }
});
