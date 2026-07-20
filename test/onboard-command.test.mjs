import test from "node:test";
import assert from "node:assert/strict";

import { runToolkitUpgrade } from "../scripts/onboard-command.mjs";

// The toolkit-upgrade subsection of `aios onboard`, extracted so its SEQUENCING can be unit
// tested deterministically with a stubbed `cmdUpdate` — no real git/process spawning. This is
// exactly the gap the build-readiness review flagged: onboarding used to discard --check/
// --preview's results entirely and had zero try/catch around any of its three cmdUpdate calls,
// so a conflicted/dirty toolkit could be offered for apply anyway, and a thrown error could
// crash the whole onboarding session instead of being handled gracefully.

function fakeClack() {
  const warnings = [];
  return { clack: { log: { warn: (m) => warnings.push(m) } }, warnings };
}

const CLEAN_TOOLKIT = { path: "/tk", git: { dirty: false }, relation: "behind" };
const DIRTY_TOOLKIT = { path: "/tk", git: { dirty: true }, relation: "behind" };
const DIVERGED_TOOLKIT = { path: "/tk", git: { dirty: false }, relation: "diverged" };

test("safe check + preview: apply is offered and called", async () => {
  const { clack, warnings } = fakeClack();
  const calls = [];
  const cmdUpdate = async (repo, cfg, args) => {
    calls.push(args[0]);
    if (args[0] === "--check" || args[0] === "--preview")
      return { applyAllowed: true, reasons: [] };
    return { exitStatus: 0, applied: true, changedCount: 3, reasons: [] };
  };
  let confirmCalled = false;
  const confirm = async () => {
    confirmCalled = true;
    return true;
  };
  await runToolkitUpgrade("/ws", {}, { toolkit: CLEAN_TOOLKIT }, { confirm, clack, cmdUpdate });
  assert.deepEqual(calls, ["--check", "--preview", "--from"]);
  assert.equal(confirmCalled, true);
  assert.deepEqual(warnings, []);
});

test("user declines the confirmation: apply is never called", async () => {
  const { clack } = fakeClack();
  const calls = [];
  const cmdUpdate = async (repo, cfg, args) => {
    calls.push(args[0]);
    return { applyAllowed: true, reasons: [] };
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: CLEAN_TOOLKIT },
    { confirm: async () => false, clack, cmdUpdate }
  );
  assert.deepEqual(calls, ["--check", "--preview"]);
});

test("check reports a conflict: apply is NOT offered, one warning naming the reason, no crash", async () => {
  const { clack, warnings } = fakeClack();
  const calls = [];
  const cmdUpdate = async (repo, cfg, args) => {
    calls.push(args[0]);
    if (args[0] === "--check") {
      return { applyAllowed: false, reasons: ["the toolkit has 1 file(s) with conflict markers"] };
    }
    if (args[0] === "--preview") return { applyAllowed: true, reasons: [] };
    throw new Error("apply must never be reached");
  };
  const confirm = async () => {
    throw new Error("confirm must never be reached — apply should have been suppressed");
  };
  await runToolkitUpgrade("/ws", {}, { toolkit: CLEAN_TOOLKIT }, { confirm, clack, cmdUpdate });
  assert.deepEqual(calls, ["--check", "--preview"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conflict markers/);
  assert.match(warnings[0], /skipping the upgrade offer/);
});

test("preview reports dirty/unsafe (check was fine): apply is still suppressed", async () => {
  const { clack, warnings } = fakeClack();
  const cmdUpdate = async (repo, cfg, args) => {
    if (args[0] === "--check") return { applyAllowed: true, reasons: [] };
    if (args[0] === "--preview")
      return { applyAllowed: false, reasons: ["toolkit checkout is dirty"] };
    throw new Error("apply must never be reached");
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: CLEAN_TOOLKIT },
    { confirm: async () => true, clack, cmdUpdate }
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dirty/);
});

test("cmdUpdate throws unexpectedly during check/preview: caught, one warning, no crash escapes", async () => {
  const { clack, warnings } = fakeClack();
  const cmdUpdate = async () => {
    throw new Error("boom — totally unexpected");
  };
  const confirm = async () => {
    throw new Error("confirm must never be reached");
  };
  // Must not throw out of runToolkitUpgrade — this is the exact crash class that used to take
  // down the whole `aios onboard` session.
  await assert.doesNotReject(
    runToolkitUpgrade("/ws", {}, { toolkit: CLEAN_TOOLKIT }, { confirm, clack, cmdUpdate })
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed unexpectedly/);
  assert.match(warnings[0], /boom/);
});

test("cmdUpdate throws unexpectedly during the apply call itself: caught, one warning, no crash", async () => {
  const { clack, warnings } = fakeClack();
  const cmdUpdate = async (repo, cfg, args) => {
    if (args[0] === "--check" || args[0] === "--preview")
      return { applyAllowed: true, reasons: [] };
    throw new Error("apply exploded");
  };
  await assert.doesNotReject(
    runToolkitUpgrade(
      "/ws",
      {},
      { toolkit: CLEAN_TOOLKIT },
      { confirm: async () => true, clack, cmdUpdate }
    )
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed unexpectedly/);
  assert.match(warnings[0], /finish it with `aios update`/);
});

test("apply itself returns a non-zero exitStatus (ran, but incompletely): one warning, no crash", async () => {
  const { clack, warnings } = fakeClack();
  const cmdUpdate = async (repo, cfg, args) => {
    if (args[0] === "--check" || args[0] === "--preview")
      return { applyAllowed: true, reasons: [] };
    return { exitStatus: 1, applied: false, reasons: ["the vendor step failed"] };
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: CLEAN_TOOLKIT },
    { confirm: async () => true, clack, cmdUpdate }
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not complete cleanly/);
});

test("dirty toolkit: skipped entirely, zero cmdUpdate calls, one warning", async () => {
  const { clack, warnings } = fakeClack();
  const calls = [];
  const cmdUpdate = async (repo, cfg, args) => {
    calls.push(args[0]);
    return {};
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: DIRTY_TOOLKIT },
    { confirm: async () => true, clack, cmdUpdate }
  );
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dirty/);
});

test("diverged (not fast-forward) toolkit: skipped entirely, zero cmdUpdate calls, one warning", async () => {
  const { clack, warnings } = fakeClack();
  const calls = [];
  const cmdUpdate = async (repo, cfg, args) => {
    calls.push(args[0]);
    return {};
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: DIVERGED_TOOLKIT },
    { confirm: async () => true, clack, cmdUpdate }
  );
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not fast-forward compatible/);
});

test("no toolkit found at all: no-op, zero calls, zero warnings", async () => {
  const { clack, warnings } = fakeClack();
  let called = false;
  const cmdUpdate = async () => {
    called = true;
    return {};
  };
  await runToolkitUpgrade(
    "/ws",
    {},
    { toolkit: null },
    { confirm: async () => true, clack, cmdUpdate }
  );
  assert.equal(called, false);
  assert.deepEqual(warnings, []);
});
