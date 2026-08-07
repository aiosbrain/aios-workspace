/**
 * The expected outcome of the real lockfile compensating gate, for whichever Node
 * major the suite happens to be running on.
 *
 * `verifyLockfileResolves` (scripts/review-bugbot/lockfile-gate.mjs) deliberately
 * REFUSES to verify a lockfile under any Node other than the pinned major: resolving
 * a lock under a runtime that would resolve it differently is worse than not
 * verifying it at all. Before AIO-628 the CI test lane only ever ran the pinned Node,
 * so the caller could assert a flat "the gate passes". The lane now runs Node 22, 24
 * and 26 to prove `engines.node: ">=22"`, so the assertion has to follow the runtime.
 *
 * This also pins the refusal path itself, which previously had no coverage at all —
 * an off-pin runtime silently passing this gate would be a real hole.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";

/** The development pin (`.nvmrc`), as a bare major. */
export function pinnedNodeMajor(repoRoot) {
  return readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0];
}

/** True when the active runtime is not the repo's development pin. */
export function runningOffPin(repoRoot) {
  return process.versions.node.split(".")[0] !== pinnedNodeMajor(repoRoot);
}

/**
 * Assert the gate result that is correct for the active runtime: a clean pass on the
 * pinned Node, an explicit named refusal anywhere else.
 */
export function assertRealLockfileGate(gates, repoRoot) {
  if (!runningOffPin(repoRoot)) {
    assert.equal(gates.ok, true, `real npm verification must succeed, got: ${gates.reason}`);
    assert.deepEqual(gates.summaries["package-lock.json"], []);
    return;
  }
  assert.equal(gates.ok, false, "an off-pin runtime must not silently pass the lockfile gate");
  assert.match(
    gates.reason,
    /must run under the pinned Node \d+ \(running Node \d+\)/,
    `off-pin refusal must name both majors, got: ${gates.reason}`
  );
}
