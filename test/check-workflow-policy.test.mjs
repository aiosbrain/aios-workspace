// Workflow-policy gate (scripts/check-workflow-policy.mjs) — leak-gate-remediation-plan.md §5.1.3.
//
// Runs the REAL gate as a child process against the committed fixture workflows in
// test/__fixtures__/workflow-policy/, so what the test proves is what CI runs. Every rule has a
// violating fixture AND a compliant counterpart; the compliant assertions are the load-bearing
// half, because a gate that flags everything is as useless as one that flags nothing.
//
// Allowlist/waiver semantics live in test/check-workflow-policy-allowlist.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RULES, mutableUsesRef, triggersOf } from "../scripts/check-workflow-policy.mjs";
import { parseWorkflowYaml, walkScalars, YamlError } from "../scripts/workflow-yaml.mjs";
import {
  FIXTURES,
  INDIRECT,
  ORIGIN_DEPENDENT_RULES,
  ROOT,
  SCRIPT,
  VALID_JUSTIFICATION,
  failures,
  reachedVia,
  run,
  withAllowlist,
} from "./workflow-policy-test-helpers.mjs";

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
  // The reusable-workflow bypass: judged under the CALLER's pull_request_target origin.
  ["violating-prt-reusable-callee.yml", "privileged", "pr-target-checkout"],
  ["violating-prt-reusable-callee.yml", "privileged", "pr-target-artifact-download"],
  ["violating-prt-reusable-callee.yml", "privileged", "pr-target-package-install"],
  ["violating-prt-reusable-callee.yml", "privileged", "pr-target-dynamic-run"],
  ["violating-prt-chain-end.yml", "deep", "pr-target-checkout"],
  ["violating-prt-chain-end.yml", "deep", "pr-target-dynamic-run"],
  // Endpoint-blocklist hole: five acquisition shapes the old regex missed.
  ["violating-prt-fetch-variants.yml", "codeload-targz", "pr-target-checkout"],
  ["violating-prt-fetch-variants.yml", "raw-content", "pr-target-checkout"],
  ["violating-prt-fetch-variants.yml", "git-fetch-sha", "pr-target-checkout"],
  ["violating-prt-fetch-variants.yml", "env-indirection", "pr-target-checkout"],
  ["violating-prt-fetch-variants.yml", "event-path", "pr-target-checkout"],
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

  // Stronger oracle for the origin-dependent rules. Firing only on a DIRECTLY triggered
  // `pull_request_target` workflow is not coverage — that is precisely the state the gate was in
  // when it shipped the reusable-workflow bypass. Each of these rules must also have fired on a
  // workflow reached only through a workflow_call / workflow_run edge.
  const via = reachedVia(out);
  for (const rule of ORIGIN_DEPENDENT_RULES) {
    const hits = found.filter((f) => f.rule === rule);
    assert.ok(
      hits.some((f) => !INDIRECT.test(via.get(f.file) ?? "")),
      `${rule} has no directly-triggered violating fixture`
    );
    assert.ok(
      hits.some((f) => INDIRECT.test(via.get(f.file) ?? "")),
      `${rule} only ever fires on a directly-triggered workflow — a reusable-workflow callee ` +
        `would bypass it. Add an indirectly-reached fixture.`
    );
  }

  // `pr-target-checkout` is the rule that shipped an endpoint blocklist, so it carries an extra
  // obligation: it must be exercised by SEVERAL distinct acquisition shapes, not just the one
  // narrow endpoint its first version happened to match. Counting distinct (file, job) pairs means
  // a single fixture — however many endpoints it lists — can never satisfy this on its own.
  const acquisitionShapes = new Set(
    found.filter((f) => f.rule === "pr-target-checkout").map((f) => `${f.file}#${f.job}`)
  );
  assert.ok(
    acquisitionShapes.size >= 5,
    `pr-target-checkout is covered by only ${acquisitionShapes.size} shape(s). It is a ` +
      `construction-based rule (transport/archive primitive x PR-controlled reference); cover ` +
      `the variants — a new endpoint must not be able to open a new hole.`
  );
});

// ── the reusable-workflow bypass (Codex adversarial review, P1) ──────────────
//
// A local reusable workflow declares `on: workflow_call`, so its own trigger list never contains
// `pull_request_target` — but it EXECUTES with the caller's event context and privileges. Deriving
// the pr-target origin from the audited file's own `on:` let every pr-target rule be laundered by
// moving the privileged step into a `uses: ./.github/workflows/...` callee. Refactoring into a
// reusable workflow is completely ordinary, so this was not theoretical.

test("pr-target rules fire on a reusable callee of a pull_request_target caller", () => {
  const out = run().out;
  const found = failures(out).filter((f) => f.file === "violating-prt-reusable-callee.yml");
  const rules = new Set(found.map((f) => f.rule));
  for (const rule of ORIGIN_DEPENDENT_RULES) {
    assert.ok(rules.has(rule), `${rule} must fire on the callee\n${out}`);
  }
  assert.ok(
    found.every((f) => f.job === "privileged"),
    "findings are attributed to the callee's own job"
  );
  // The callee's own `on:` is workflow_call — the origin must come from the caller.
  assert.match(
    reachedVia(out).get("violating-prt-reusable-callee.yml"),
    /^called by pull_request_target /
  );
});

test("the pull_request_target origin survives two reusable-workflow hops", () => {
  const out = run().out;
  const rules = new Set(
    failures(out)
      .filter((f) => f.file === "violating-prt-chain-end.yml")
      .map((f) => f.rule)
  );
  assert.ok(rules.has("pr-target-checkout"), `caller → A → B must still be judged as prt\n${out}`);
  assert.ok(
    rules.has("pr-target-dynamic-run"),
    `caller → A → B must still be judged as prt\n${out}`
  );
  assert.match(
    reachedVia(out).get("upstream-prt-chain-middle.yml"),
    /^called by pull_request_target /
  );
});

test("a reusable callee reached only from `pull_request` does NOT get the pr-target rules", () => {
  const out = run().out;
  const found = failures(out).filter((f) => f.file === "pr-reachable-not-prt-callee.yml");
  const rules = new Set(found.map((f) => f.rule));
  // It IS PR-reachable, so the secrets rule applies...
  assert.ok(rules.has("secrets-in-pr-reachable"), `still PR-reachable\n${out}`);
  // ...but pull_request carries no base-repo privileges, so these must stay silent. Without this
  // control the bypass fix would have traded a false negative for a false positive.
  for (const rule of ORIGIN_DEPENDENT_RULES) {
    assert.ok(!rules.has(rule), `${rule} must NOT fire for a plain pull_request origin\n${out}`);
  }
});

test("a reusable callee reached only from schedule/push is out of scope entirely", () => {
  const out = run().out;
  assert.equal(reachedVia(out).get("compliant-unreached-callee.yml"), undefined);
  assert.deepEqual(
    failures(out).filter((f) => f.file === "compliant-unreached-callee.yml"),
    [],
    "a schedule-only caller must not drag its callee into scope"
  );
});

test("compliant fixtures produce no finding at all", () => {
  const clean = [
    "compliant-pull-request.yml",
    "compliant-prt-env-only.yml",
    "compliant-not-pr-reachable.yml",
    "upstream-pr-workflow.yml",
    "upstream-reusable-caller.yml",
    "upstream-prt-reusable-caller.yml",
    "upstream-prt-chain-caller.yml",
    "upstream-prt-chain-middle.yml",
    "upstream-plain-pr-caller.yml",
    "upstream-schedule-caller.yml",
    "compliant-unreached-callee.yml",
    "compliant-prt-trusted-fetch.yml",
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

// ── PR-content acquisition is judged by construction, not by endpoint ────────
//
// The first version enumerated known-bad endpoints and missed `codeload.../tar.gz/refs/pull/N/head`
// outright. These fixtures are one job per acquisition shape; the rule now requires a transport or
// archive primitive PLUS a PR-controlled reference, so a new endpoint cannot open a new hole.

for (const [job, shape] of [
  ["codeload-targz", "codeload `tar.gz/refs/pull/<n>/head` (the exact reported miss)"],
  ["raw-content", "raw.githubusercontent.com selected by a head.sha expression"],
  ["git-fetch-sha", "`git fetch origin <sha>` with no `refs/pull/` literal"],
  ["env-indirection", "`env:` indirection — no `${{ }}` in the run body at all"],
  ["event-path", "`$GITHUB_EVENT_PATH` read, then fetch"],
]) {
  test(`pr-target-checkout catches PR content fetched via ${shape}`, () => {
    const out = run().out;
    const hit = failures(out).some(
      (f) =>
        f.file === "violating-prt-fetch-variants.yml" &&
        f.job === job &&
        f.rule === "pr-target-checkout"
    );
    assert.ok(hit, `job \`${job}\` must trip pr-target-checkout\n${out}`);
  });
}

test("a pull_request_target job may fetch trusted things without being flagged", () => {
  const out = run().out;
  assert.deepEqual(
    failures(out).filter((f) => f.file === "compliant-prt-trusted-fetch.yml"),
    [],
    `curl/tar/git-fetch with no PR-controlled reference, and an explicit base-ref checkout, ` +
      `must stay silent — otherwise the inverted rule just flags every fetch in the repo\n${out}`
  );
});

// The boundary this gate draws, stated as a test rather than left to accident: fetching PR objects
// "as inert data" (the leak-gate/nda-gate scanner shape) IS flagged. There is no silent exemption
// for it — the gate cannot tell from YAML that bytes are never executed, so the sanctioned route is
// a reviewed waiver carrying an owner and a justification, which is exactly what the repo's own
// allowlist does for .github/workflows/leak-gate.yml.
test("fetching PR objects as inert scanner data is flagged, not silently permitted", () => {
  const out = run().out;
  assert.ok(
    failures(out).some(
      (f) => f.file === "violating-prt-fetch-variants.yml" && f.job === "env-indirection"
    ),
    "the scanner-input shape must still be reported"
  );
  const repoAllowlist = JSON.parse(
    readFileSync(path.join(ROOT, "scripts/workflow-policy-allowlist.json"), "utf8")
  );
  const waiver = repoAllowlist.entries.find(
    (e) => e.workflow === ".github/workflows/leak-gate.yml" && e.rule === "pr-target-checkout"
  );
  assert.ok(waiver, "the real scanner is permitted by an explicit waiver, not by a rule exemption");
  assert.ok(waiver.owner && waiver.justification.length >= 40);
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
