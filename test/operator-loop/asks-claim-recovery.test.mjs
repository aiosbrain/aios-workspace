import test from "node:test";
import assert from "node:assert/strict";
import recoveryPolicy from "../../hooks/asks-claim-recovery.cjs";

const claim = {
  ownerPid: 4242,
  ownerIdentity: "start:old",
  expiresAt: "2026-07-16T01:05:00.000Z",
};
const before = Date.parse("2026-07-16T01:04:00.000Z");
const after = Date.parse("2026-07-16T01:06:00.000Z");

test("shared recovery policy detects PID reuse but never steals a matching live owner", () => {
  const alive = () => {};
  assert.equal(
    recoveryPolicy.claimRecoveryDecision(claim, after, {
      kill: alive,
      processIdentity: () => "start:old",
    }),
    "busy"
  );
  assert.equal(
    recoveryPolicy.claimRecoveryDecision(claim, before, {
      kill: alive,
      processIdentity: () => "start:new",
    }),
    "recover"
  );
});

test("shared EPERM/unknown semantics fail closed through lease then recover boundedly", () => {
  const eperm = () => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  };
  const unknown = () => {
    throw Object.assign(new Error("unknown"), { code: "EIO" });
  };
  for (const kill of [eperm, unknown]) {
    assert.equal(
      recoveryPolicy.claimRecoveryDecision(claim, before, {
        kill,
        processIdentity: () => null,
      }),
      "busy"
    );
    assert.equal(
      recoveryPolicy.claimRecoveryDecision(claim, after, {
        kill,
        processIdentity: () => null,
      }),
      "recover"
    );
  }
});
