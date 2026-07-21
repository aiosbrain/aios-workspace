// GUI inbox API (I-14 / AIO-395, the G6a gate) — the server half of the comms section.
//
// The load-bearing contract: `GET /api/inbox` must render EXACTLY what `aios inbox --json` returns, so
// the GUI queue and the terminal never diverge (the spec's "API contract test: GET /api/inbox
// deep-equals the aios inbox --json output over the same fixture workspace"). We assert that against the
// real CLI over the same fixture workspace, ignoring response metadata: every active item and the ranker
// version are identity-checked. The GUI intentionally replaces the CLI's occurrence-derived `staleness`
// with connector-ingestion `freshness`, because occurrence timestamps do not measure ingestion health.
//
// The rest of the suite covers the raw escape hatch, item detail, and the ONLY mutating call in this
// issue — the scoped-confirmation decision — including its tamper (digest) and replay guards, which are
// the I-03 owning-runtime authority the GUI must not weaken.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ackInboxAsk,
  getInboxView,
  getInboxDetail,
  decideInbox,
  shouldReconcileClaudeAsks,
  invalidateReconcileThrottle,
} from "../../gui/server/inbox-api.mjs";
import {
  issueHandle,
  capabilityTargets,
  loadRecord,
} from "../../gui/server/runtime-adapters/capability-store.mjs";
import {
  appendObservations,
  buildObservation,
  createDurableNotifyJournal,
  readJournalSegments,
} from "../../dist/operator-loop/index.js";

// Issue a capability handle exactly as the WS gateway does (index.mjs) — with explicit `targetResources`,
// so the persisted record's request digest is self-consistent (the runtime's own integrity gate). `extra`
// carries the I-07 binding fields (audience/epoch) and TTL for the adversarial cases.
function issue(dir, command, extra = {}) {
  const { ttlMs, ...binding } = extra;
  return issueHandle(
    dir,
    {
      operation: "Bash",
      normalizedArgs: { command },
      targetResources: capabilityTargets("Bash", { command }),
      repoWorktreeIdentity: dir,
      ...binding,
    },
    ttlMs !== undefined ? { ttlMs } : {}
  );
}
/** The exactly-three-field body the client is allowed to post. */
const body = (handle, digest, decision) => ({ handle, digest, decision });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-gui-api-"));
}
function cli(dir, cmd, args) {
  const stdout = execFileSync("node", [CLI, cmd, ...args, "--repo", dir], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout;
}
const addAsk = (dir, kind, severity, title) =>
  JSON.parse(
    cli(dir, "asks", ["add", "--kind", kind, "--severity", severity, "--title", title, "--json"])
  ).id;

// Same enriched-observation shape the I-09 CLI suite uses (single account, deterministic ts). No grey
// channels (WhatsApp/X) anywhere — email + agent asks only, per the epic's hard rule.
function seedObservations(dir, ts = new Date().toISOString()) {
  appendObservations(dir, [
    buildObservation({
      connection_id: "gmail-a",
      account: "me@acme.com",
      tenant: "acme.com",
      object_kind: "email",
      native_id: "solo-msg",
      ts,
      snippet: "quarterly review thread",
    }),
  ]);
}

// Compare the shared queue contract while allowing each surface to own its response metadata.
function queueProjection(view) {
  return { items: view.items, ranker_version: view.ranker_version };
}

test("EXIT — GET /api/inbox deep-equals `aios inbox --json` over the same fixture workspace", async () => {
  const dir = ws();
  try {
    addAsk(dir, "idle", "blocker", "Need input on deploy");
    addAsk(dir, "status", "fyi", "Nightly ran");
    seedObservations(dir);

    const cliView = JSON.parse(cli(dir, "inbox", ["--json"]));
    const apiView = await getInboxView(dir);

    assert.deepEqual(queueProjection(apiView), queueProjection(cliView));
    // The GUI publishes ingestion freshness only; it must not mislabel message age as connector health.
    assert.equal(typeof apiView.generated_at, "string");
    assert.equal(apiView.freshness, null);
    assert.equal("staleness" in apiView, false);
    assert.ok(apiView.items.length >= 3, "queue carries the seeded asks + observation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/inbox?raw deep-equals `aios inbox --raw --json` (pure chronological, no partition)", async () => {
  const dir = ws();
  try {
    addAsk(dir, "idle", "blocker", "b");
    addAsk(dir, "status", "fyi", "f");
    seedObservations(dir);

    const cliRaw = JSON.parse(cli(dir, "inbox", ["--raw", "--json"]));
    const apiRaw = await getInboxView(dir, { raw: true });
    assert.deepEqual(queueProjection(apiRaw), queueProjection(cliRaw));
    assert.deepEqual(
      apiRaw.items.map((i) => i.id),
      cliRaw.items.map((i) => i.id),
      "raw ordering matches the CLI"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/inbox/:id returns the matching unified row for detail", async () => {
  const dir = ws();
  try {
    const blocker = addAsk(dir, "idle", "blocker", "protected one");
    seedObservations(dir);
    const detail = await getInboxDetail(dir, blocker);
    assert.ok(detail.item, "found the item");
    assert.equal(detail.item.id, blocker);
    assert.equal(detail.item.origin, "agent-event");
    assert.equal(detail.item.protected, true, "open blocker is protected");
    assert.ok(Array.isArray(detail.pendingApprovals), "carries a (possibly empty) approvals list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/inbox/:id threads ingestion freshness exactly like the list endpoint", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "idle", "blocker", "with freshness");
    const refresh = {
      status: "ready",
      last_attempt_at: "2026-07-17T09:04:59.000Z",
      last_success_at: "2026-07-17T09:05:00.000Z",
      error: null,
      sources: { gmail: "ready", calendar: "ready", telegram: "outbound_only" },
    };
    const detail = await getInboxDetail(dir, id, { refresh });
    assert.deepEqual(detail.freshness, refresh, "detail carries the refresher snapshot");
    // The contract declares freshness non-optional — without a refresher it is an explicit null.
    const bare = await getInboxDetail(dir, id);
    assert.equal(bare.freshness, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notify journal projects as a sibling without changing queue parity", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "idle", "blocker", "notify sibling");
    createDurableNotifyJournal(dir)({
      kind: "delivery-attempted",
      correlation_id: id,
      ts: "2026-07-21T01:00:00.000Z",
      payload: {
        lane: "telegram",
        count: 1,
        repo_label: "fixture",
        deep_link: "aios://inbox/ask/" + id,
        at: "2026-07-21T01:00:00.000Z",
      },
    });
    const cliView = JSON.parse(cli(dir, "inbox", ["--json"]));
    const lane = {
      status: "delivery_ok",
      last_attempt_at: "2026-07-21T01:00:00.000Z",
      last_delivery_at: "2026-07-21T01:00:00.000Z",
      last_error: null,
    };
    const view = await getInboxView(dir, { notifyLane: lane });
    assert.deepEqual(queueProjection(view), queueProjection(cliView));
    assert.deepEqual(view.notify.lane, lane);
    assert.equal(view.notify.states[id].delivery_attempts, 1);
    assert.equal(view.notify.states[id].acked, false);

    const detail = await getInboxDetail(dir, id, { notifyLane: lane });
    assert.deepEqual(detail.notify.lane, lane);
    assert.deepEqual(Object.keys(detail.notify.states), [id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ack is honest, idempotent, and never records before a delivery", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "idle", "blocker", "ack me");
    const never = await ackInboxAsk(dir, id);
    assert.deepEqual(never, {
      ok: true,
      status: 200,
      recorded: false,
      reason: "never-delivered",
    });
    assert.equal(
      readJournalSegments(dir).events.filter((event) => event.kind === "human-ack").length,
      0
    );

    createDurableNotifyJournal(dir)({
      kind: "delivery-attempted",
      correlation_id: id,
      ts: "2026-07-21T01:00:00.000Z",
      payload: {
        lane: "telegram",
        count: 1,
        repo_label: "fixture",
        deep_link: "aios://inbox/ask/" + id,
        at: "2026-07-21T01:00:00.000Z",
      },
    });
    const recorded = await ackInboxAsk(dir, id, {
      now: () => new Date("2026-07-21T01:01:00.000Z"),
    });
    assert.equal(recorded.recorded, true);
    const again = await ackInboxAsk(dir, id);
    assert.equal(again.recorded, false);
    assert.equal(again.reason, "already-acked");
    assert.equal(
      readJournalSegments(dir).events.filter((event) => event.kind === "human-ack").length,
      1
    );
    const view = await getInboxView(dir);
    assert.equal(view.notify.states[id].acked, true);
    assert.equal(view.notify.overdue[id], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown and concurrent acknowledgments fail closed without duplicate events", async () => {
  const dir = ws();
  try {
    const unknown = await ackInboxAsk(dir, "missing");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.reason, "not-acknowledgeable");

    const id = addAsk(dir, "idle", "blocker", "race ack");
    createDurableNotifyJournal(dir)({
      kind: "delivery-attempted",
      correlation_id: id,
      ts: "2026-07-21T01:00:00.000Z",
      payload: {
        lane: "telegram",
        count: 1,
        repo_label: "fixture",
        deep_link: "aios://inbox/ask/" + id,
        at: "2026-07-21T01:00:00.000Z",
      },
    });
    const results = await Promise.all([ackInboxAsk(dir, id), ackInboxAsk(dir, id)]);
    assert.equal(
      results.some((result) => result.recorded),
      true
    );
    assert.equal(
      readJournalSegments(dir).events.filter((event) => event.kind === "human-ack").length,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human acknowledgment is appended inside the ask-store lifecycle lock", async () => {
  let underAskLock = false;
  let recorded = 0;
  const id = "ask-lock-proof";
  const loop = {
    buildInbox: () => ({
      items: [
        {
          id,
          origin: "agent-event",
          bucket: "needs-you",
          attention_state: "surfaced",
          ask: { id, status: "open" },
        },
      ],
    }),
    readJournalSegments: () => ({ events: [] }),
    foldNotificationState: () =>
      new Map([
        [
          id,
          {
            delivery_attempts: 1,
            last_delivery_at: "2026-07-21T01:00:00.000Z",
            acked: false,
          },
        ],
      ]),
    createDurableNotifyJournal: () => () => {},
    recordHumanAck: () => {
      assert.equal(underAskLock, true);
      recorded++;
    },
    withLock: (_repo, operation) => {
      underAskLock = true;
      try {
        return operation();
      } finally {
        underAskLock = false;
      }
    },
  };
  const notifyCoordinator = {
    async runExclusive(operation) {
      return { acquired: true, value: await operation() };
    },
  };

  const result = await ackInboxAsk("/tmp/fixture", id, {
    loadLoopFn: async () => loop,
    notifyCoordinator,
  });
  assert.equal(result.recorded, true);
  assert.equal(recorded, 1);
});

test("reconcile throttle — at most once per 30s, and an ask decision bypasses the wait", () => {
  invalidateReconcileThrottle();
  const t0 = 1_000_000_000;
  assert.equal(shouldReconcileClaudeAsks(t0), true, "first read reconciles");
  assert.equal(shouldReconcileClaudeAsks(t0 + 10_000), false, "polls inside the window skip");
  assert.equal(shouldReconcileClaudeAsks(t0 + 29_999), false, "still inside the window");
  assert.equal(shouldReconcileClaudeAsks(t0 + 30_000), true, "window elapsed → reconcile again");
  // A posted decision/reply/archive clears the throttle so the next read is immediate.
  invalidateReconcileThrottle();
  assert.equal(shouldReconcileClaudeAsks(t0 + 30_001), true, "mutation bypasses the throttle");
  invalidateReconcileThrottle();
});

test("GET /api/inbox/:id surfaces a pending capability as a scoped-confirm approval", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "review", "decision", "Approve schema change?");
    const { handle, displayProjection } = issueHandle(dir, {
      operation: "Bash",
      normalizedArgs: { command: "git push origin feat/inbox-adapter" },
      repoWorktreeIdentity: dir,
    });
    const detail = await getInboxDetail(dir, id);
    const approval = detail.pendingApprovals.find((p) => p.handle === handle);
    assert.ok(approval, "pending capability is projected onto the detail");
    assert.equal(
      approval.digest,
      displayProjection.digest,
      "carries the request digest to bind to"
    );
    assert.ok(approval.summary.includes("Bash"), "content-free display summary (operation only)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST decision — the URL id IS the handle: approve → durable native receipt; replay is rejected", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push");
    // The decision resource is the handle itself — the URL id must equal it (binding).
    const approve = await decideInbox(
      dir,
      handle,
      body(handle, displayProjection.digest, "approve")
    );
    assert.equal(approve.ok, true);
    assert.equal(approve.status, 200);
    assert.equal(approve.result.kind, "native-receipt", "approved + executed exactly once");

    // Replay after a completed round-trip is rejected by the LOCKED consume (durable tombstone + outcome).
    const replay = await decideInbox(
      dir,
      handle,
      body(handle, displayProjection.digest, "approve")
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 409);
    assert.equal(replay.result.kind, "rejected");
    assert.equal(replay.result.reason, "replay-consumed", "authoritative locked replay guard");
    // The 4xx body carries a human-readable `error` (api.ts surfaces body.error —
    // without it the dialog shows the bare statusText "Conflict").
    assert.equal(replay.error, "This request was already decided.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST decision — deny is a processed decision that spends the handle (never re-brokerable to approve)", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push");
    const deny = await decideInbox(dir, handle, body(handle, displayProjection.digest, "deny"));
    assert.equal(deny.status, 200);
    assert.equal(deny.ok, true, "a denial is processed, not an error");
    assert.equal(deny.result.kind, "rejected");
    assert.equal(deny.result.reason, "denied");
    assert.equal(deny.error, undefined, "a processed denial is not an error");

    // The spent (denied) handle can never then be approved.
    const flip = await decideInbox(dir, handle, body(handle, displayProjection.digest, "approve"));
    assert.notEqual(flip.result?.kind, "native-receipt", "a denied handle never executes");
    assert.equal(flip.status, 409);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST decision — tampered digest is rejected by the LOCKED consume (no misleading precheck)", async () => {
  const dir = ws();
  try {
    const { handle } = issue(dir, "git push");
    const tampered = await decideInbox(dir, handle, body(handle, "deadbeef".repeat(8), "approve"));
    assert.equal(tampered.ok, false);
    assert.equal(tampered.status, 409);
    // The verdict comes from the locked compare-and-consume, not an unlocked precheck.
    assert.equal(tampered.result.kind, "rejected");
    assert.equal(tampered.result.reason, "digest-mismatch");
    assert.match(tampered.error, /changed after it was shown/, "human-readable reason in the body");

    // …and the handle is still consumable with the correct digest afterwards (nothing was spent).
    const { requestDigest } = loadRecord(dir, handle);
    const ok = await decideInbox(dir, handle, body(handle, requestDigest, "approve"));
    assert.equal(ok.result.kind, "native-receipt", "a rejected tamper never consumed the handle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST decision — validates its input (bad decision, missing handle)", async () => {
  const dir = ws();
  try {
    assert.equal((await decideInbox(dir, "h", body("h", "d", "maybe"))).status, 400);
    const noHandle = await decideInbox(dir, "h", { digest: "d", decision: "approve" });
    assert.equal(noHandle.status, 400);
    assert.equal(noHandle.error, "handle is required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── adversarial: substitution, concurrency, expiry, audience, epoch ─────────────────────────────────

test("ADVERSARIAL — a handle cannot be approved through another resource's URL or an arbitrary id", async () => {
  const dir = ws();
  try {
    const a = issue(dir, "git push A");
    const b = issue(dir, "git push B");

    // Approving handle A through handle B's URL is refused (URL id must name the same resource).
    const crossUrl = await decideInbox(
      dir,
      b.handle,
      body(a.handle, a.displayProjection.digest, "approve")
    );
    assert.equal(crossUrl.status, 400);
    assert.equal(crossUrl.error, "handle does not match the decision resource");

    // Approving A through an ARBITRARY id in the URL is refused for the same reason.
    const arbitraryUrl = await decideInbox(
      dir,
      "totally-made-up-id",
      body(a.handle, a.displayProjection.digest, "approve")
    );
    assert.equal(arbitraryUrl.status, 400);

    // A self-consistent but NON-EXISTENT resource id is a 404 from the store (server data, not a claim).
    const ghost = await decideInbox(dir, "ghost-handle", body("ghost-handle", "x", "approve"));
    assert.equal(ghost.status, 404);
    assert.equal(ghost.error, "unknown-handle");

    // Neither real handle was consumed by any of the above — both still approve normally.
    const okA = await decideInbox(
      dir,
      a.handle,
      body(a.handle, a.displayProjection.digest, "approve")
    );
    const okB = await decideInbox(
      dir,
      b.handle,
      body(b.handle, b.displayProjection.digest, "approve")
    );
    assert.equal(okA.result.kind, "native-receipt");
    assert.equal(okB.result.kind, "native-receipt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADVERSARIAL — concurrent approvals of the same handle: exactly one native receipt, one rejection", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push");
    const req = () => decideInbox(dir, handle, body(handle, displayProjection.digest, "approve"));
    const [r1, r2] = await Promise.all([req(), req()]);
    const kinds = [r1.result?.kind, r2.result?.kind].sort();
    assert.deepEqual(
      kinds,
      ["native-receipt", "rejected"],
      "exactly one executes; the other is rejected"
    );
    const rejected = [r1, r2].find((r) => r.result?.kind === "rejected");
    assert.equal(rejected.status, 409);
    // The rejection is a durable replay/crash-window verdict, never a second execution.
    assert.ok(
      ["replay-consumed"].includes(rejected.result.reason) || rejected.result.kind === "outcome",
      "second consumer never re-executes"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADVERSARIAL — an expired approval window is rejected (locked, clock-driven)", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push", { ttlMs: 5 * 60 * 1000 });
    // Consume with a clock past the TTL — the locked consume distinguishes expiry from denial.
    const expired = await decideInbox(
      dir,
      handle,
      body(handle, displayProjection.digest, "approve"),
      {
        now: Date.now() + 6 * 60 * 1000,
      }
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.result.kind, "rejected");
    assert.equal(expired.result.reason, "expired");
    assert.match(expired.error, /approval window has expired/, "human-readable reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADVERSARIAL — audience/session binding is enforced through the GUI consume path", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push", { audience: "session-A" });
    const b = body(handle, displayProjection.digest, "approve");

    // Wrong consuming session → rejected (never executed).
    const wrong = await decideInbox(dir, handle, b, { audience: "session-B" });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.result.kind, "rejected");
    assert.equal(wrong.result.reason, "audience-mismatch");

    // The bound session → succeeds (binding continues to work, it isn't dormant).
    const right = await decideInbox(dir, handle, b, { audience: "session-A" });
    assert.equal(right.result.kind, "native-receipt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADVERSARIAL — a rotated (superseded) epoch is rejected; the current epoch consumes", async () => {
  const dir = ws();
  try {
    const { handle, displayProjection } = issue(dir, "git push", { epoch: "epoch-1" });
    const b = body(handle, displayProjection.digest, "approve");

    // A key/session rotation supersedes the old handle → typed rotation rejection (not a silent failure).
    const superseded = await decideInbox(dir, handle, b, { epoch: "epoch-2" });
    assert.equal(superseded.status, 409);
    assert.equal(superseded.result.kind, "rejected");
    assert.equal(superseded.result.reason, "rotation-superseded");

    // The current epoch consumes normally.
    const current = await decideInbox(dir, handle, b, { epoch: "epoch-1" });
    assert.equal(current.result.kind, "native-receipt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
