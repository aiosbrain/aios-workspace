// Allowlist semantics for the workflow-policy gate (leak-gate-remediation-plan.md §5.1.3).
//
// The waiver mechanism is the part of a policy gate most likely to quietly become a blanket skip,
// so it gets its own file: a waiver must name ONE rule for ONE (workflow, job) pair, carry an
// accountable owner and a real justification, and leave every other rule enforced.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { validateAllowlist } from "../scripts/check-workflow-policy.mjs";
import {
  FIXTURES,
  ROOT,
  VALID_JUSTIFICATION,
  failures,
  run,
  withAllowlist,
} from "./workflow-policy-test-helpers.mjs";

test("a matching (workflow, job, rule) waiver suppresses exactly that finding", () => {
  withAllowlist(
    [
      {
        workflow: `${FIXTURES}/violating-secrets.yml`,
        job: "deploy",
        rule: "secrets-in-pr-reachable",
        owner: "AIOS Security",
        justification: VALID_JUSTIFICATION,
      },
    ],
    (file) => {
      const { code, out } = run({ allowlist: file });
      assert.equal(code, 1, "other fixtures still fail");
      assert.match(
        out,
        /waived {2}\S*violating-secrets\.yml {2}job `deploy` {2}\[secrets-in-pr-reachable\] {2}owner: AIOS Security/
      );
      assert.deepEqual(
        failures(out).filter((f) => f.file === "violating-secrets.yml"),
        []
      );
    }
  );
});

test("a waiver is scoped to its rule — it does not silence the file's other rules", () => {
  withAllowlist(
    [
      {
        workflow: `${FIXTURES}/violating-mutable-action.yml`,
        job: "build",
        rule: "secrets-in-pr-reachable",
        owner: "AIOS Security",
        justification: VALID_JUSTIFICATION,
      },
    ],
    (file) => {
      const out = run({ allowlist: file }).out;
      assert.ok(
        failures(out).some(
          (f) => f.file === "violating-mutable-action.yml" && f.rule === "mutable-action-ref"
        ),
        "the unwaived rule still fails"
      );
    }
  );
});

test('job "*" waives one rule across a file\'s jobs, and is still rule-scoped', () => {
  const entries = [
    {
      workflow: `${FIXTURES}/violating-prt-dynamic-run.yml`,
      job: "*",
      rule: "pr-target-dynamic-run",
      owner: "Platform Engineering",
      justification: VALID_JUSTIFICATION,
    },
  ];
  withAllowlist(entries, (file) => {
    const out = run({ allowlist: file }).out;
    assert.deepEqual(
      failures(out).filter((f) => f.file === "violating-prt-dynamic-run.yml"),
      []
    );
  });
});

test("an unused waiver is a note, never a failure — so a fix in another PR cannot redden main", () => {
  withAllowlist(
    [
      {
        workflow: ".github/workflows/does-not-exist.yml",
        job: "ghost",
        rule: "mutable-action-ref",
        owner: "AIOS Security",
        justification: VALID_JUSTIFICATION,
      },
    ],
    (file) => {
      const out = run({ allowlist: file, dir: `${FIXTURES}/../workflow-policy-none` }).out;
      assert.match(out, /stale {3}\.github\/workflows\/does-not-exist\.yml/);
      assert.equal(run({ allowlist: file, dir: `${FIXTURES}/../workflow-policy-none` }).code, 0);
    }
  );
});

for (const [label, entry] of [
  ["no justification", { justification: undefined }],
  ["a too-short justification", { justification: "TODO" }],
  ["no owner", { owner: "" }],
  ["an unknown rule", { rule: "everything" }],
  ["a wildcard rule", { rule: "*" }],
  ["no workflow", { workflow: "" }],
]) {
  test(`an allowlist entry with ${label} is itself a failure`, () => {
    const base = {
      workflow: `${FIXTURES}/violating-secrets.yml`,
      job: "deploy",
      rule: "secrets-in-pr-reachable",
      owner: "AIOS Security",
      justification: VALID_JUSTIFICATION,
    };
    withAllowlist([{ ...base, ...entry }], (file) => {
      const { code, out } = run({ allowlist: file });
      assert.equal(code, 1);
      assert.match(out, /\[allowlist-entry-invalid\]/, out);
    });
  });
}

test("validateAllowlist rejects a non-array entries field", () => {
  const { findings } = validateAllowlist({ entries: "everything" }, "a.json");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "allowlist-entry-invalid");
});

test("the repo's own allowlist is valid and every entry justifies itself", () => {
  const raw = JSON.parse(
    execFileSync("cat", [path.join(ROOT, "scripts/workflow-policy-allowlist.json")], {
      encoding: "utf8",
    })
  );
  const { findings, entries } = validateAllowlist(raw, "scripts/workflow-policy-allowlist.json");
  assert.deepEqual(findings, []);
  for (const e of entries) assert.notEqual(e.rule, "*");
});

test("the repo's own workflows pass the gate with its committed allowlist", () => {
  const result = run({
    dir: ".github/workflows",
    allowlist: path.join(ROOT, "scripts/workflow-policy-allowlist.json"),
  });
  assert.equal(result.code, 0, result.out);
});
