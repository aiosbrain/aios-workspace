// The `pull_request_target` rule family (leak-gate-remediation-plan.md §5.1.3).
//
// Split from test/check-workflow-policy.test.mjs on the 500-line cap. These are the two rules that
// have actually regressed under adversarial review, so they are kept together and read as one
// story: WHICH jobs are judged as pull_request_target (origin propagation through reusable
// workflows), and WHAT counts as pulling PR-controlled content into one (acquisition by
// construction rather than by endpoint).
//
// The global coverage oracle over all fixtures stays in check-workflow-policy.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  ORIGIN_DEPENDENT_RULES,
  ROOT,
  failures,
  reachedVia,
  run,
} from "./workflow-policy-test-helpers.mjs";

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
