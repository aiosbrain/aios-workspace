// Workflow-policy gate (scripts/check-workflow-policy.mjs) — leak-gate-remediation-plan.md §5.1.3.
//
// Runs the REAL gate as a child process against the committed fixture workflows in
// test/__fixtures__/workflow-policy/, so what the test proves is what CI runs. Every rule has a
// violating fixture AND a compliant counterpart; the compliant assertions are the load-bearing
// half, because a gate that flags everything is as useless as one that flags nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULES,
  mutableUsesRef,
  triggersOf,
  validateAllowlist,
} from "../scripts/check-workflow-policy.mjs";
import { parseWorkflowYaml, walkScalars, YamlError } from "../scripts/workflow-yaml.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-workflow-policy.mjs");
const FIXTURES = "test/__fixtures__/workflow-policy";
const NO_ALLOWLIST = path.join(tmpdir(), "workflow-policy-absent-allowlist.json");

/** Run the gate and return { code, out } with stdout and stderr merged. */
function run({ dir = FIXTURES, allowlist = NO_ALLOWLIST, cwd = ROOT } = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--dir", dir, "--allowlist", allowlist], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Every `FAIL <file> job \`<job>\` [<rule>]` line, as {file, job, rule}. */
function failures(out) {
  return [...out.matchAll(/^FAIL {2}(\S+?)(?::\d+)? {2}job `([^`]+)` {2}\[([a-z-]+)\]$/gm)].map(
    ([, file, job, rule]) => ({ file: path.basename(file), job, rule })
  );
}

const withAllowlist = (entries, body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-policy-"));
  const file = path.join(dir, "allowlist.json");
  writeFileSync(file, JSON.stringify({ entries }, null, 2));
  try {
    return body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── every rule fires on its own fixture ──────────────────────────────────────

const EXPECTED = [
  ["violating-secrets.yml", "deploy", "secrets-in-pr-reachable"],
  ["violating-elevated-checks.yml", "(workflow)", "elevated-permissions"],
  ["violating-elevated-statuses.yml", "publish", "elevated-permissions"],
  ["violating-write-all.yml", "(workflow)", "elevated-permissions"],
  ["violating-security-gate-context.yml", "forge", "security-gate-context"],
  ["violating-mutable-action.yml", "build", "mutable-action-ref"],
  ["violating-prt-checkout.yml", "review", "pr-target-checkout"],
  ["violating-prt-artifact.yml", "consume", "pr-target-artifact-download"],
  ["violating-prt-install.yml", "build", "pr-target-package-install"],
  ["violating-prt-dynamic-run.yml", "greet", "pr-target-dynamic-run"],
  ["violating-workflow-run.yml", "report", "secrets-in-pr-reachable"],
  ["violating-reusable.yml", "publish", "secrets-in-pr-reachable"],
  ["violating-unparseable.yml", "(file)", "unparseable-workflow"],
];

test("every rule fires on its violating fixture, naming file, job, and rule", () => {
  const { code, out } = run();
  assert.equal(code, 1, out);
  const found = failures(out);
  for (const [file, job, rule] of EXPECTED) {
    assert.ok(
      found.some((f) => f.file === file && f.job === job && f.rule === rule),
      `expected ${rule} on ${file} job ${job}\n${out}`
    );
  }
  // Coverage oracle: no rule in the catalogue may go unexercised by these fixtures.
  const exercised = new Set(found.map((f) => f.rule));
  for (const rule of Object.keys(RULES)) {
    if (rule === "allowlist-entry-invalid") continue; // exercised by the allowlist tests below
    assert.ok(exercised.has(rule), `rule ${rule} has no violating fixture`);
  }
});

test("compliant fixtures produce no finding at all", () => {
  const clean = [
    "compliant-pull-request.yml",
    "compliant-prt-env-only.yml",
    "compliant-not-pr-reachable.yml",
    "upstream-pr-workflow.yml",
    "upstream-reusable-caller.yml",
  ];
  const found = failures(run().out);
  for (const file of clean) {
    assert.deepEqual(
      found.filter((f) => f.file === file),
      [],
      `${file} must be clean`
    );
  }
});

test("a compliant pull_request_target workflow reading github.event.* via env: passes", () => {
  const { out } = run();
  // The whole point of the rule: interpolation into a run body is the violation, not the read.
  assert.match(out, /compliant-prt-env-only\.yml {2}\(via pull_request_target\)/);
  assert.deepEqual(
    failures(out).filter((f) => f.file === "compliant-prt-env-only.yml"),
    []
  );
});

test("a non-PR-reachable workflow is out of scope even when it breaks every rule", () => {
  const { out } = run();
  assert.doesNotMatch(out, /PR-reachable {2}\S*compliant-not-pr-reachable\.yml/);
  assert.deepEqual(
    failures(out).filter((f) => f.file === "compliant-not-pr-reachable.yml"),
    []
  );
});

test("reachability follows workflow_run and local reusable-workflow calls", () => {
  const { out } = run();
  assert.match(
    out,
    /violating-workflow-run\.yml {2}\(via workflow_run of PR-like "upstream pr workflow"\)/
  );
  assert.match(
    out,
    /violating-reusable\.yml {2}\(via called by PR-like \S*upstream-reusable-caller\.yml/
  );
});

// ── the gate never writes the required security status ───────────────────────

test("the checker itself neither writes nor can write the AIOS Security Gate status", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|node:https?|child_process/,
    "the gate makes no network or subprocess call"
  );
  const ci = parseWorkflowYaml(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const job = ci.jobs["workflow-policy"];
  assert.ok(job, "ci.yml must carry the workflow-policy job");
  assert.deepEqual(
    Object.entries(job.permissions),
    [["contents", "read"]],
    "contents:read and nothing else"
  );
  for (const { value } of walkScalars(job, "job", 0)) {
    assert.doesNotMatch(
      value,
      /\$\{\{[^}]*\bsecrets\s*[.[]/,
      `the CI job must hold no secret: ${value}`
    );
  }
  assert.ok(
    ci.jobs["test-gate"].needs.includes("workflow-policy"),
    "the gate must be a mandatory lane, not advisory"
  );
});

// ── allowlist semantics ──────────────────────────────────────────────────────

const VALID_JUSTIFICATION =
  "Waived pending the phase-7 cutover that deletes the workflow; owner tracked in the plan.";

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

// leak-gate-remediation-plan.md §5.1 / §2.4: pr-task-link.yml and pr-in-review.yml land as
// pull_request_target jobs that legitimately hold a credential via an `environment:`. That is the
// plan's sanctioned "static AST-policy exception reviewed by Security" — and it is the ONE rule the
// waiver may suspend. An environment is a blast-radius control, not an author-trust control: for
// pull_request_target the ref is always the base branch, so a fork PR author satisfies a main-only
// deployment branch policy and receives the secret anyway.
test("`environment:` never counts as satisfying the secrets rule on its own", () => {
  const out = run().out;
  const found = failures(out).filter((f) => f.file === "violating-prt-environment-secret.yml");
  assert.ok(
    found.some((f) => f.rule === "secrets-in-pr-reachable"),
    `an environment-scoped secret in a pull_request_target job must still fail\n${out}`
  );
});

test("waiving only the secrets rule leaves every other rule enforced on the same job", () => {
  withAllowlist(
    [
      {
        workflow: `${FIXTURES}/violating-prt-environment-secret.yml`,
        job: "link",
        rule: "secrets-in-pr-reachable",
        owner: "AIOS Security",
        justification: VALID_JUSTIFICATION,
      },
    ],
    (file) => {
      const { code, out } = run({ allowlist: file });
      assert.equal(code, 1, out);
      const found = failures(out).filter((f) => f.file === "violating-prt-environment-secret.yml");
      const rules = new Set(found.map((f) => f.rule));
      assert.ok(!rules.has("secrets-in-pr-reachable"), "the named rule is waived");
      // ...and the file is NOT skipped: three unrelated rules still fail on the same job.
      for (const rule of ["mutable-action-ref", "pr-target-checkout", "pr-target-dynamic-run"]) {
        assert.ok(rules.has(rule), `${rule} must still fail on the waived file\n${out}`);
      }
      assert.ok(
        found.every((f) => f.job === "link"),
        "findings stay attributed to the job that owns them"
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

// ── unit-level pieces ────────────────────────────────────────────────────────

test("mutableUsesRef pins on a 40-hex SHA and nothing else", () => {
  assert.equal(mutableUsesRef("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"), null);
  assert.equal(
    mutableUsesRef("./.github/actions/local"),
    null,
    "in-repo actions travel with the commit"
  );
  assert.equal(mutableUsesRef(`docker://alpine@sha256:${"a".repeat(64)}`), null);
  assert.match(mutableUsesRef("actions/checkout@v4"), /mutable ref/);
  assert.match(mutableUsesRef("actions/checkout@main"), /mutable ref/);
  assert.match(
    mutableUsesRef("actions/checkout@3d3c42e5"),
    /mutable ref/,
    "a short SHA is not a pin"
  );
  assert.match(mutableUsesRef("actions/checkout"), /no `@ref`/);
  assert.match(mutableUsesRef("docker://alpine:3"), /digest-pinned/);
});

test("triggersOf handles the string, list, and map forms of `on:`", () => {
  assert.deepEqual(triggersOf({ on: "push" }), ["push"]);
  assert.deepEqual(triggersOf(parseWorkflowYaml("on: [push, pull_request]\n")), [
    "push",
    "pull_request",
  ]);
  assert.deepEqual(triggersOf(parseWorkflowYaml("on:\n  pull_request:\n  push:\n")), [
    "pull_request",
    "push",
  ]);
  assert.deepEqual(triggersOf({}), []);
});

test("the YAML reader fails closed on constructs it does not model", () => {
  for (const source of [
    "a: &anchor 1\nb: *anchor\n",
    "a: !!str 1\n",
    "jobs:\n  <<: x\n",
    "a: 1\na: 2\n",
    "a:\n\tb: 1\n",
    "a: 'unterminated\n",
    "a: [1, 2\n",
    "---\na: 1\n---\nb: 2\n",
  ]) {
    assert.throws(
      () => parseWorkflowYaml(source),
      YamlError,
      `should have thrown on: ${JSON.stringify(source)}`
    );
  }
});

test("the YAML reader keeps line provenance for findings", () => {
  const doc = parseWorkflowYaml(
    "name: x\non:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: echo hi\n"
  );
  assert.equal(doc.$keyLines.jobs, 4);
  assert.equal(doc.jobs.$keyLines.a, 5);
  const runScalar = [...walkScalars(doc.jobs.a, "jobs.a", 5)].find((s) => s.value === "echo hi");
  assert.equal(runScalar.line, 7);
});

test("the YAML reader models the shapes real workflows use", () => {
  const doc = parseWorkflowYaml(
    [
      "name: real",
      "on:",
      "  pull_request:",
      "    types: [opened, synchronize]",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  a:",
      "    steps:",
      "    - uses: actions/checkout@v4",
      "      with:",
      '        ref: "refs/pull/1/head"',
      "    - name: block",
      "      run: |",
      "        line one # not a comment",
      "        line two",
      "    - if: >-",
      "        a &&",
      "        b",
      "      run: echo done # trailing comment",
      "",
    ].join("\n")
  );
  const steps = doc.jobs.a.steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[0].with.ref, "refs/pull/1/head");
  assert.equal(steps[1].run, "line one # not a comment\nline two\n");
  assert.equal(steps[2].if, "a && b");
  assert.equal(steps[2].run, "echo done");
  assert.deepEqual(doc.on.pull_request.types, ["opened", "synchronize"]);
});
