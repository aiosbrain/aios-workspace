import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditWorkflow, computeReachability } from "../scripts/workflow-policy-rules.mjs";
import {
  classifyExpression,
  classifyValue,
  environmentValues,
} from "../scripts/workflow-policy-values.mjs";
import { parseWorkflowYaml } from "../scripts/workflow-yaml.mjs";
import { main } from "../scripts/check-workflow-policy.mjs";

const pin = "a".repeat(40);
const expr = (s) => "${{ " + s + " }}";
const audit = (steps, job = {}, doc = {}) =>
  auditWorkflow({
    rel: "probe.yml",
    doc: {
      on: "pull_request_target",
      permissions: {},
      jobs: { test: { steps, ...job } },
      ...doc,
    },
  });

const unknown = [
  "matrix.ref",
  "matrix",
  "steps.p.outputs",
  "needs.build.outputs",
  "steps",
  "inputs.ref",
  "fromJSON(toJSON(github)).event.pull_request.head.sha",
  "format('{0}', inputs.ref)",
  "github.event.pull_request.base.sha + matrix.ref",
  "env[inputs.key]",
  "env.MISSING",
  "github.event_name trailing",
  "github.event.pull_request.base.sha.extra",
  "(github.event_name)",
];
const tainted = [
  "github.event",
  "GITHUB.EVENT.PULL_REQUEST.HEAD.SHA",
  "github['event'].pull_request.title",
  "github",
  "SECRETS",
  "Secrets['TOKEN']",
];
const safe = [
  "github.event.pull_request.base.sha",
  " github ['event'] . pull_request [ 'base' ] . ref ",
  "GITHUB.EVENT_NAME",
  "github.event.repository.default_branch",
  "'literal'",
  "42",
  "true",
  "null",
];
for (const [kind, values] of [
  ["unknown", unknown],
  ["tainted", tainted],
  ["safe", safe],
]) {
  for (const value of values)
    test(`${kind} expression: ${value}`, () => {
      assert.equal(classifyExpression(value), kind);
      const code = expr(value);
      const cases = [
        [{ uses: `actions/checkout@${pin}`, with: { ref: code } }, "pr-target-checkout"],
        [{ uses: `actions/checkout@${pin}`, with: { repository: code } }, "pr-target-checkout"],
        [{ run: `curl ${code}` }, "pr-target-checkout"],
        [{ run: `echo ${code}` }, "pr-target-dynamic-run"],
        [{ uses: `actions/github-script@${pin}`, with: { script: code } }, "pr-target-dynamic-run"],
        [{ uses: `vendor/action@${pin}`, with: { command: code } }, "pr-target-input"],
      ];
      for (const [step, rule] of cases) {
        const findings = audit([step]);
        assert.equal(
          findings.some((f) => f.rule === rule),
          kind !== "safe",
          `${rule}: ${value}`
        );
        if (kind === "unknown")
          assert.match(findings.find((f) => f.rule === rule).detail, /cannot prove safe/);
      }
      const calls = audit([], {
        uses: `vendor/repo/.github/workflows/run.yml@${pin}`,
        with: { ref: code },
      });
      assert.equal(
        calls.some((f) => f.rule === "pr-target-input"),
        kind !== "safe"
      );
      // Ordinary PR testing continues accepting dynamic values; secret policy is independent.
      assert.equal(
        audit([{ run: `echo ${code}` }], {}, { on: "pull_request" }).some((f) =>
          f.rule.startsWith("pr-target")
        ),
        false
      );
    });
}

test("environment resolution closes cycles, missing definitions and shadowed chains", () => {
  for (const env of [
    { A: expr("env.B"), B: expr("env.A") },
    { A: expr("env.MISSING") },
    { A: expr("matrix.ref") },
  ]) {
    const findings = audit([{ run: `git fetch origin "$A"` }, { run: `echo ${expr("env.A")}` }], {
      env,
    });
    assert.ok(findings.some((f) => f.rule === "pr-target-checkout"));
    assert.ok(findings.some((f) => f.rule === "pr-target-dynamic-run"));
  }
  const env = { B: expr("env.A"), A: expr("github.event.pull_request.base.sha") };
  assert.deepEqual(audit([{ run: `echo ${expr("env.B")}` }], { env }), []);
  assert.deepEqual(
    audit([{ env: { A: "literal" }, run: `echo ${expr("env.A")}` }], {
      env: { A: expr("github.event") },
    }),
    []
  );
  assert.ok(
    audit([{ env: { A: expr("matrix.ref") }, run: `echo ${expr("env.A")}` }], {
      env: { A: "literal" },
    }).length
  );
  const inherited = environmentValues({ A: "safe", B: expr("env.A") });
  assert.equal(environmentValues({ A: expr("env.A") }, inherited).get("A"), "unknown");
  assert.equal(classifyValue("${{ env.A"), "unknown");
});

test("local actions are rejected only under privileged origins, including local callees", () => {
  for (const uses of ["./.github/actions/local", "../local"]) {
    assert.ok(audit([{ uses }]).some((f) => f.rule === "pr-target-local-action"));
    assert.deepEqual(audit([{ uses }], {}, { on: "pull_request" }), []);
  }
  const files = [
    {
      rel: ".github/workflows/caller.yml",
      doc: {
        on: "pull_request_target",
        permissions: {},
        jobs: { call: { uses: "./.github/workflows/callee.yml" } },
      },
    },
    {
      rel: ".github/workflows/callee.yml",
      doc: {
        on: "workflow_call",
        permissions: {},
        jobs: {
          run: {
            steps: [
              { uses: "./local" },
              { uses: `vendor/action@${pin}`, with: { ref: expr("inputs.ref") } },
            ],
          },
        },
      },
    },
  ];
  const reachable = computeReachability(files);
  const findings = auditWorkflow(files[1], reachable.get(files[1].rel).prTarget);
  for (const rule of ["pr-target-local-action", "pr-target-input"])
    assert.ok(findings.some((f) => f.rule === rule));
});

test("case variants and whole secret objects retain the secret rule", () => {
  for (const value of ["SECRETS", "toJSON(Secrets)", "Secrets['TOKEN']"]) {
    assert.ok(
      audit([{ env: { X: expr(value) }, run: "echo safe" }]).some(
        (f) => f.rule === "secrets-in-pr-reachable"
      )
    );
  }
});

test("permissions require valid explicit effective declarations with job precedence", () => {
  assert.ok(
    audit([], {}, { permissions: undefined }).some((f) => f.rule === "permissions-required")
  );
  for (const value of [{}, "read-all", { contents: "read" }])
    assert.deepEqual(audit([], {}, { permissions: value }), []);
  assert.deepEqual(audit([], { permissions: {} }, { permissions: { statuses: "write" } }), []);
  assert.ok(
    audit([], { permissions: { statuses: "write" } }).some((f) => f.rule === "elevated-permissions")
  );
  for (const value of [
    null,
    [],
    7,
    "garbage",
    expr("inputs.permissions"),
    { contents: expr("inputs.level") },
    { bogus: "read" },
    { "id-token": "read" },
  ]) {
    const findings = audit([], { permissions: value });
    assert.ok(
      findings.some((f) => f.rule === "permissions-invalid"),
      JSON.stringify(value)
    );
    assert.equal(
      findings.some((f) => f.rule === "elevated-permissions"),
      false
    );
  }
});

test("workflow directory errors return 2; explicit existing empty audit returns 0", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-dir-"));
  const out = [];
  const run = (dir, ...args) =>
    main(["--dir", dir, "--allowlist", path.join(root, "absent.json"), ...args], {
      cwd: root,
      log: (s) => out.push(s),
      err: (s) => out.push(s),
    });
  try {
    assert.equal(run("absent"), 2);
    assert.equal(run("absent", "--allow-empty"), 2);
    writeFileSync(path.join(root, "file"), "data");
    assert.equal(run("file"), 2);
    assert.equal(run("file", "--allow-empty"), 2);
    mkdirSync(path.join(root, "empty"));
    assert.equal(run("empty"), 2);
    assert.equal(run("empty", "--allow-empty"), 0);
    assert.ok(out.some((s) => /zero workflows/.test(s)));
    chmodSync(path.join(root, "empty"), 0);
    if (process.getuid?.() !== 0) assert.equal(run("empty", "--allow-empty"), 2);
  } finally {
    chmodSync(path.join(root, "empty"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("different-case shell variables cannot shadow inherited acquisition taint", () => {
  const findings = audit([{ env: { head_sha: "literal" }, run: 'git fetch origin "$HEAD_SHA"' }], {
    env: { HEAD_SHA: expr("github.event.pull_request.head.sha") },
  });
  assert.ok(findings.some((f) => f.rule === "pr-target-checkout"));
  assert.deepEqual(
    audit([{ env: { HEAD_SHA: "literal" }, run: 'git fetch origin "$HEAD_SHA"' }], {
      env: { HEAD_SHA: expr("github.event.pull_request.head.sha") },
    }),
    []
  );
});

test("action input diagnostics preserve parsed source lines", () => {
  const doc = parseWorkflowYaml(`on: pull_request_target
permissions: {}
jobs:
  test:
    steps:
      - uses: vendor/action@${pin}
        with:
          command: ${expr("matrix.command")}
`);
  const findings = auditWorkflow({ rel: "probe.yml", doc });
  assert.equal(findings.find((f) => f.rule === "pr-target-input").line, 8);
});
