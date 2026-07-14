// Runtime-issued capability handle spike (I-03 / AIO-384, G2b) — EXIT proof.
//
// The two-authority split under test:
//   • coordinator side (compiled): brokerDecision / notifyDeepLink / createInMemoryJournal
//       imported from ../../dist/operator-loop/index.js
//   • owning-runtime side (durable store): issueHandle / consumeAndExecute / readCapabilities
//       imported from ../../gui/server/runtime-adapters/capability-store.mjs
//
// EXIT (verbatim from the spec): tamper rejection + replay-rejection-after-runtime-restart proven.
// Restart is simulated in-test by re-importing the store module with a fresh URL (a new module
// instance with zero in-memory state) and re-folding the durable NDJSON tombstone from disk.
//
// Run: node --test test/operator-loop/inbox-capability.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  brokerDecision,
  notifyDeepLink,
  createInMemoryJournal,
} from "../../dist/operator-loop/index.js";
import {
  issueHandle,
  consumeAndExecute,
  readCapabilities,
  loadRecord,
  capabilityDigest,
  CAPABILITY_STORE_REL,
} from "../../gui/server/runtime-adapters/capability-store.mjs";

const IDENTITY = "/repo/aios-workspace@feat/inbox";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-capability-"));
}
function sampleRequest(over = {}) {
  return {
    operation: "Bash",
    normalizedArgs: { command: "git status" },
    targetResources: ["cmd:git"],
    repoWorktreeIdentity: IDENTITY,
    ...over,
  };
}
// A fresh counter-backed executor: proves consume→execute happens EXACTLY once (0 on rejection).
function counter() {
  const c = { n: 0 };
  return { c, execute: () => (c.n += 1) };
}

test("round-trip: approve → consume → execute once → native-receipt journalled", () => {
  const root = ws();
  try {
    const journal = createInMemoryJournal();
    const { handle, displayProjection } = issueHandle(root, sampleRequest());

    const brokered = brokerDecision(displayProjection, "approve", {
      appendInboxEvent: journal.append,
    });
    // Coordinator never mutates request fields — it echoes the digest it was shown.
    assert.equal(brokered.digest, displayProjection.digest);

    const { c, execute } = counter();
    const receipt = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      appendEvent: journal.append,
    });

    assert.equal(receipt.kind, "native-receipt");
    assert.equal(receipt.ok, true);
    assert.equal(c.n, 1, "executed exactly once");
    // journal saw user-intent, pdp-decision, and native-receipt.
    assert.deepEqual(
      journal.events.map((e) => e.kind),
      ["user-intent", "pdp-decision", "native-receipt"]
    );
    // durable tombstone on disk
    assert.equal(readCapabilities(root).get(handle).state, "consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXIT (a): tamper — a mutated digest is rejected before execution, counter stays 0", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");

    // Coordinator mutates the envelope's digest (e.g. tries to bind approval to different args).
    const tampered = {
      ...brokered,
      digest: capabilityDigest(sampleRequest({ normalizedArgs: { command: "rm -rf /" } })),
    };

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, tampered, { identity: IDENTITY, execute });

    assert.equal(rej.kind, "rejected");
    assert.equal(rej.reason, "digest-mismatch");
    assert.equal(c.n, 0, "no execution on tamper");
    // The legitimate handle is NOT spent by a tamper attempt — a correct broker still consumes it.
    assert.equal(loadRecord(root, handle).state, "pending");
    const good = consumeAndExecute(root, handle, brokered, { identity: IDENTITY, execute });
    assert.equal(good.kind, "native-receipt");
    assert.equal(c.n, 1, "exactly-once after the correct broker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EXIT (b): replay-after-runtime-restart — consumed handle rejected via durable tombstone", async () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");

    const first = counter();
    const r1 = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: first.execute,
    });
    assert.equal(r1.kind, "native-receipt");
    assert.equal(first.c.n, 1);

    // The tombstone must be a real, durable line on disk (not just in-memory state).
    const raw = readFileSync(path.join(root, CAPABILITY_STORE_REL), "utf8");
    assert.match(raw, /"op":"consume"/);

    // Simulate a FULL runtime restart: import a fresh module instance (zero in-memory state) and
    // re-fold the store from disk. The consumed tombstone must still reject a replay.
    const fresh = await import("../../gui/server/runtime-adapters/capability-store.mjs?restart=1");
    assert.equal(fresh.loadRecord(root, handle).state, "consumed", "tombstone survived restart");

    const second = counter();
    const r2 = fresh.consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: second.execute,
    });
    assert.equal(r2.kind, "rejected");
    assert.equal(r2.reason, "replay-consumed");
    assert.equal(second.c.n, 0, "no re-execution after restart replay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deny → typed denial, handle spent (cannot later be approved)", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const journal = createInMemoryJournal();
    const brokered = brokerDecision(displayProjection, "deny", {
      appendInboxEvent: journal.append,
    });

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      appendEvent: journal.append,
    });
    assert.equal(rej.kind, "rejected");
    assert.equal(rej.reason, "denied");
    assert.equal(c.n, 0);

    // A denied handle is tombstoned — a later approve attempt replays into the tombstone.
    const approve = brokerDecision(displayProjection, "approve");
    const retry = consumeAndExecute(root, handle, approve, { identity: IDENTITY, execute });
    assert.equal(retry.reason, "replay-consumed");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL expiry → expired, distinguishable from denial", () => {
  const root = ws();
  try {
    const t0 = Date.now();
    const { handle, displayProjection } = issueHandle(root, sampleRequest(), {
      now: t0,
      ttlMs: 1000,
    });
    const brokered = brokerDecision(displayProjection, "approve", { now: t0 });

    const later = t0 + 5000; // past TTL
    assert.equal(loadRecord(root, handle, later).state, "expired");

    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute,
      now: later,
    });
    assert.equal(rej.reason, "expired");
    assert.notEqual(rej.reason, "denied");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity mismatch (wrong repo/worktree) is rejected, no execution", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");
    const { c, execute } = counter();
    const rej = consumeAndExecute(root, handle, brokered, {
      identity: "/some/other/repo@main",
      execute,
    });
    assert.equal(rej.reason, "identity-mismatch");
    assert.equal(c.n, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown handle is rejected", () => {
  const root = ws();
  try {
    const rej = consumeAndExecute(
      root,
      "not-a-real-handle",
      { handle: "not-a-real-handle", decision: "approve", digest: "x" },
      { identity: IDENTITY }
    );
    assert.equal(rej.reason, "unknown-handle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome_unknown: consumed-then-execute-throws is retry-flagged, still not re-executable", () => {
  const root = ws();
  try {
    const { handle, displayProjection } = issueHandle(root, sampleRequest());
    const brokered = brokerDecision(displayProjection, "approve");
    const boom = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: () => {
        throw new Error("side effect failed");
      },
    });
    assert.equal(boom.kind, "outcome");
    assert.equal(boom.outcome, "outcome_unknown");
    // Still consumed — a retry replays into the tombstone rather than double-executing.
    const retry = consumeAndExecute(root, handle, brokered, {
      identity: IDENTITY,
      execute: () => 1,
    });
    assert.equal(retry.reason, "replay-consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KILL fallback: notifyDeepLink is content-free and demoable standalone", () => {
  const journal = createInMemoryJournal();
  const n = notifyDeepLink(
    { handle: "h-123", deepLink: "aios://runtime/prompt/h-123" },
    { appendInboxEvent: journal.append }
  );

  assert.equal(n.lane, "notify-deep-link");
  assert.equal(n.handle, "h-123");
  assert.equal(n.deepLink, "aios://runtime/prompt/h-123");
  // Content-free: no operation / args / resources / summary ever cross this seam.
  assert.deepEqual(Object.keys(n).sort(), ["at", "deepLink", "handle", "lane"]);
  for (const forbidden of [
    "operation",
    "normalizedArgs",
    "args",
    "targetResources",
    "summary",
    "input",
  ]) {
    assert.equal(forbidden in n, false, `fallback payload must not carry ${forbidden}`);
  }
  // No capability store is touched by the fallback lane — it needs no durable consume.
  assert.equal(existsSync(path.join(tmpdir(), CAPABILITY_STORE_REL)), false);
});
