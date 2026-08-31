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
  // A primitive invoked by absolute path is the same primitive (`/usr/bin/npm ci`).
  ["violating-prt-abspath-primitives.yml", "abs-package", "pr-target-package-install"],
  ["violating-prt-abspath-primitives.yml", "abs-pip", "pr-target-package-install"],
  ["violating-prt-abspath-primitives.yml", "abs-fetch", "pr-target-checkout"],
  ["violating-prt-abspath-primitives.yml", "abs-archive", "pr-target-checkout"],
  // `secrets: inherit` — no `secrets.*` text anywhere in the job.
  ["violating-secrets-inherit.yml", "inherits", "secrets-in-pr-reachable"],
  // Duplicate upstream `name:` — the downstream must not vanish from the report.
  ["violating-workflow-run-dup-name.yml", "report", "secrets-in-pr-reachable"],
  ["violating-workflow-run-dup-name.yml", "report", "pr-target-checkout"],
  // Bracket index syntax — `env['X']` is `env.X`, and every context accepts it.
  ["violating-prt-bracket-notation.yml", "bracket-ref", "pr-target-checkout"],
  ["violating-prt-bracket-notation.yml", "bracket-context", "pr-target-dynamic-run"],
  ["violating-prt-bracket-notation.yml", "unresolvable-index", "pr-target-dynamic-run"],
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

  // `pr-target-checkout` and `pr-target-dynamic-run` must each be exercised through the INDIRECT
  // `${{ env.X }}` form, not only by fixtures that name `github.event.*` inline. The direct form is
  // what the first implementation matched, and it is exactly what let the reproducer through.
  for (const rule of ["pr-target-checkout", "pr-target-dynamic-run"]) {
    assert.ok(
      found.some((f) => f.file === "violating-prt-env-expression.yml" && f.rule === rule),
      `${rule} has no \`\${{ env.X }}\` indirection fixture — the direct-expression fixtures ` +
        `alone do not cover it, which is how the demonstrated bypass survived`
    );
    // ...and the same again for the bracket syntax, which bypassed the env fix one round later.
    assert.ok(
      found.some((f) => f.file === "violating-prt-bracket-notation.yml" && f.rule === rule),
      `${rule} has no bracket-index fixture — \`env['X']\` is \`env.X\`, and matching only the ` +
        `dot form is exactly how the second indirection bypass survived`
    );
  }

  // `secrets-in-pr-reachable` has TWO independent mechanisms: an explicit `secrets.*` expression,
  // and `secrets: inherit`, which contains no such expression at all. Requiring both means deleting
  // the inherit fixture cannot leave the rule looking covered by the expression case alone.
  const secretsJobs = new Set(
    found.filter((f) => f.rule === "secrets-in-pr-reachable").map((f) => `${f.file}#${f.job}`)
  );
  assert.ok(
    secretsJobs.has("violating-secrets.yml#deploy"),
    "secrets-in-pr-reachable has no explicit `${{ secrets.* }}` fixture"
  );
  assert.ok(
    secretsJobs.has("violating-secrets-inherit.yml#inherits"),
    "secrets-in-pr-reachable has no `secrets: inherit` fixture — that mechanism carries no " +
      "`secrets.*` text, so the expression fixture alone does not cover this rule"
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
    "secrets-inherit-callee.yml",
    "dup-name-prt-upstream.yml",
    "dup-name-scheduled-upstream.yml",
    "compliant-prt-env-expression.yml",
    "compliant-prt-bracket-notation.yml",
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

// ── `secrets: inherit` and duplicate upstream names ──────────────────────────

test("`secrets: inherit` is flagged even though the job contains no `secrets.*` text", () => {
  const out = run().out;
  const found = failures(out).filter((f) => f.file === "violating-secrets-inherit.yml");
  assert.ok(
    found.some((f) => f.job === "inherits" && f.rule === "secrets-in-pr-reachable"),
    `a job passing every caller secret must be reported\n${out}`
  );
  assert.match(out, /`secrets: inherit` passes every caller secret to this job/);
});

test("an otherwise identical reusable call without `secrets:` is NOT flagged", () => {
  const out = run().out;
  assert.deepEqual(
    failures(out).filter(
      (f) => f.file === "violating-secrets-inherit.yml" && f.job === "no-inherit"
    ),
    [],
    "the rule must key on `inherit`, not on making a reusable call at all"
  );
  assert.deepEqual(
    failures(out).filter((f) => f.file === "secrets-inherit-callee.yml"),
    [],
    "the callee is clean — the finding belongs to the caller that passes the secrets"
  );
});

test("two workflows sharing a `name:` do not collapse the workflow_run lookup", () => {
  const out = run().out;
  // The PR-reachable twin sorts BEFORE the scheduled one, so a last-write-wins index retained the
  // scheduled twin and judged this downstream unreachable — no rule ran against it at all.
  const via = reachedVia(out).get("violating-workflow-run-dup-name.yml");
  assert.ok(via, `the downstream must be reachable via the PR-reachable twin\n${out}`);
  assert.match(via, /^workflow_run of pull_request_target "duplicated upstream name"$/);

  const rules = new Set(
    failures(out)
      .filter((f) => f.file === "violating-workflow-run-dup-name.yml")
      .map((f) => f.rule)
  );
  assert.ok(rules.has("secrets-in-pr-reachable"), "reachable ⇒ the ordinary rules run");
  assert.ok(
    rules.has("pr-target-checkout"),
    "the strongest origin (prTarget) is the one inherited"
  );
});

test("a uniquely-named workflow_run upstream still resolves exactly as before", () => {
  const out = run().out;
  assert.equal(
    reachedVia(out).get("violating-workflow-run.yml"),
    'workflow_run of PR-like "upstream pr workflow"',
    "the ordinary single-match path must not regress"
  );
  assert.ok(
    failures(out).some(
      (f) => f.file === "violating-workflow-run.yml" && f.rule === "secrets-in-pr-reachable"
    )
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

// The gate must not be judged by the code under review. Before this, the job checked out the merge
// revision and ran the PR's own checker, so a PR could add a secret-exfiltrating workflow AND edit
// the checker (or grant itself a waiver) in the same PR, and this required lane went green. Same
// shape and same reasoning as .github/workflows/pr-review-evidence.yml. Asserted against the real
// ci.yml so a future edit that reintroduces a PR-revision checkout goes red here.
test("the CI job judges with the BASE revision's checker and allowlist, never the PR's", () => {
  const ci = parseWorkflowYaml(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const steps = ci.jobs["workflow-policy"].steps;

  const gateCheckout = steps.find((s) => /checkout@/.test(String(s.uses ?? "")));
  assert.match(
    String(gateCheckout.with?.ref ?? ""),
    /github\.event\.pull_request\.base\.sha/,
    "the FIRST checkout must pin the gate to the base revision"
  );

  const candidate = steps.find((s) => s.with?.path === "candidate");
  assert.ok(candidate, "the PR's own tree must arrive in a separate `candidate/` checkout");
  assert.equal(candidate.with["persist-credentials"], false);

  // Match the INVOCATION, not the locate step — whose `test -f` names the same path.
  const invoke = steps.find((s) =>
    String(s.run ?? "").includes("$GATE_ROOT/scripts/check-workflow-policy.mjs")
  );
  assert.ok(invoke, "the gate must be invoked from the base-revision gate root");
  assert.equal(invoke["working-directory"], "candidate", "scan the candidate tree");
  // Both the checker AND the allowlist come from the gate root: a PR that can add its own waiver
  // is the same bypass wearing a different hat.
  assert.match(invoke.run, /\$GATE_ROOT\/scripts\/check-workflow-policy\.mjs/);
  assert.match(invoke.run, /--allowlist "\$GATE_ROOT\/scripts\/workflow-policy-allowlist\.json"/);
  assert.match(
    String(ci.jobs["workflow-policy"].steps.find((s) => s.id === "gate").run),
    /::warning title=Workflow-policy gate bootstrap/,
    "the bootstrap fallback must be loud, and conditioned on the base lacking the checker"
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
