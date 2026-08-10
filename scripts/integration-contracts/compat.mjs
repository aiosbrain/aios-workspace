/**
 * Reference implementations of the compatibility truth table (AIO-835 Phase 0).
 *
 * The SDK loader and the Harness policy parser are two independent implementations in two
 * repositories. Both must agree with compatibility.json, so the table ships with an
 * executable reference here and every row is replayed through it. A row nobody can
 * reproduce is a contradiction in the contract, not a bug downstream.
 */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version) {
  if (typeof version !== "string") return null;
  const m = SEMVER_RE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Resolve a manifest against a host. Returns `{ result, rule }` where result is
 * `load` | `inactive` | `fail_closed`. Evaluation order is the one declared in
 * compatibility.json and is load-bearing: a future major fails closed even when min_host
 * would otherwise be satisfied.
 */
export function evaluateManifestLoad(host, manifest) {
  const hostVersion = parse(host.host_version);
  const contractVersion = parse(manifest.contract_version);
  const minHost = parse(manifest.min_host);
  if (!hostVersion || !contractVersion || !minHost) {
    return { result: "fail_closed", rule: "malformed_or_missing_version" };
  }

  if (contractVersion[0] > hostVersion[0]) {
    return { result: "fail_closed", rule: "future_major" };
  }
  if (
    contractVersion[0] < hostVersion[0] &&
    !(host.supported_contract_majors ?? []).includes(contractVersion[0])
  ) {
    return { result: "fail_closed", rule: "unlisted_older_major" };
  }
  if (compare(minHost, hostVersion) > 0) {
    return { result: "inactive", rule: "host_below_min_host" };
  }
  return { result: "load", rule: "compatible" };
}

/**
 * Resolve the generated Harness policy guard. Reads stay allowed under missing, malformed
 * and future-major policy: the guard is a mutation-routing gate, not a read sandbox. Only a
 * same-major STALE policy warns on reads, because there the policy is present and trusted
 * enough to route with but demonstrably out of date. Outside a configured AIOS guard scope
 * every state is a no-op so customer and project routing stay locally governed.
 */
export function evaluateHarnessPolicy({ scope, policy_state: state, operation }) {
  if (scope !== "aios_guard_scope") return { result: "noop", remediation: false };
  if (state === "compatible") return { result: "allow", remediation: false };
  if (state === "stale_same_major") {
    return operation === "mutation"
      ? { result: "block", remediation: true }
      : { result: "warn", remediation: true };
  }
  // missing | malformed | future_major
  return operation === "mutation"
    ? { result: "block", remediation: true }
    : { result: "allow", remediation: false };
}

export function checkCompatibility(compatibility, fail) {
  const load = compatibility.manifest_load;
  const knownRules = new Set(load.evaluation_order.map((r) => r.rule));
  const exercisedRules = new Set();

  for (const testCase of load.cases) {
    const actual = evaluateManifestLoad(testCase.host, testCase.manifest);
    if (!load.results[testCase.expected.result]) {
      fail(`compatibility ${testCase.id}: unknown result "${testCase.expected.result}"`);
    }
    if (!knownRules.has(testCase.expected.rule)) {
      fail(`compatibility ${testCase.id}: unknown rule "${testCase.expected.rule}"`);
    }
    if (actual.result !== testCase.expected.result || actual.rule !== testCase.expected.rule) {
      fail(
        `compatibility ${testCase.id}: expected ${testCase.expected.result}/${testCase.expected.rule}, reference evaluator returned ${actual.result}/${actual.rule}`
      );
    }
    exercisedRules.add(testCase.expected.rule);
  }

  for (const rule of knownRules) {
    if (!exercisedRules.has(rule)) {
      fail(`compatibility: evaluation_order rule "${rule}" has no case exercising it`);
    }
  }

  checkHarnessCases(compatibility.harness_policy, fail);
}

function checkHarnessCases(policy, fail) {
  const states = Object.keys(policy.policy_states);
  const covered = new Set();

  for (const testCase of policy.cases) {
    if (!policy.policy_states[testCase.policy_state]) {
      fail(`harness_policy ${testCase.id}: unknown policy_state "${testCase.policy_state}"`);
    }
    if (!policy.results[testCase.expected.result]) {
      fail(`harness_policy ${testCase.id}: unknown result "${testCase.expected.result}"`);
    }
    const actual = evaluateHarnessPolicy(testCase);
    if (
      actual.result !== testCase.expected.result ||
      actual.remediation !== testCase.expected.remediation
    ) {
      fail(
        `harness_policy ${testCase.id}: expected ${testCase.expected.result}/remediation=${testCase.expected.remediation}, reference evaluator returned ${actual.result}/remediation=${actual.remediation}`
      );
    }
    if (testCase.scope === "aios_guard_scope") {
      covered.add(`${testCase.policy_state}:${testCase.operation}`);
    }
  }

  // In a guard scope, every policy state must pin BOTH a read and a mutation result. A
  // missing row is how a fail-open gap gets introduced silently.
  for (const state of states) {
    for (const operation of ["read", "mutation"]) {
      if (!covered.has(`${state}:${operation}`)) {
        fail(
          `harness_policy: no in-scope case for policy_state "${state}" + operation "${operation}"`
        );
      }
    }
  }
}
