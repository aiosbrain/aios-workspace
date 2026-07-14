// GUI inbox API (I-14 / AIO-395, the G6a gate) — the server half of the comms section.
//
// The load-bearing contract: `GET /api/inbox` must render EXACTLY what `aios inbox --json` returns, so
// the GUI queue and the terminal never diverge (the spec's "API contract test: GET /api/inbox
// deep-equals the aios inbox --json output over the same fixture workspace"). We assert that against the
// real CLI over the same fixture workspace, ignoring only the two wall-clock fields that can never match
// across two separate reads (`generated_at`, `staleness.age_ms`) — every item, the ranker version, and
// the staleness verdict are identity-checked.
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

import { getInboxView, getInboxDetail, decideInbox } from "../../gui/server/inbox-api.mjs";
import {
  issueHandle,
  capabilityTargets,
} from "../../gui/server/runtime-adapters/capability-store.mjs";
import { buildObservation, appendObservations } from "../../dist/operator-loop/index.js";

// Issue a capability handle exactly as the WS gateway does (index.mjs) — with explicit `targetResources`,
// so the persisted record's request digest is self-consistent (the runtime's own integrity gate).
function issue(dir, command) {
  return issueHandle(dir, {
    operation: "Bash",
    normalizedArgs: { command },
    targetResources: capabilityTargets("Bash", { command }),
    repoWorktreeIdentity: dir,
  });
}

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

// The two fields that can never match across two independent reads (each stamps its own `now`).
function stripVolatile(view) {
  const { generated_at: _generated_at, staleness, ...rest } = view;
  const { age_ms: _age_ms, ...stalenessRest } = staleness ?? {};
  return { ...rest, staleness: stalenessRest };
}

test("EXIT — GET /api/inbox deep-equals `aios inbox --json` over the same fixture workspace", async () => {
  const dir = ws();
  try {
    addAsk(dir, "idle", "blocker", "Need input on deploy");
    addAsk(dir, "status", "fyi", "Nightly ran");
    seedObservations(dir);

    const cliView = JSON.parse(cli(dir, "inbox", ["--json"]));
    const apiView = await getInboxView(dir);

    // Every item, the ranker version, and the staleness verdict are identical; only the wall-clock
    // fields differ (two separate reads), so they're stripped before the deep-equal.
    assert.deepEqual(stripVolatile(apiView), stripVolatile(cliView));
    // The volatile fields still exist and carry the right types on the API response.
    assert.equal(typeof apiView.generated_at, "string");
    assert.equal(typeof apiView.staleness.stale, "boolean");
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
    assert.deepEqual(stripVolatile(apiRaw), stripVolatile(cliRaw));
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

test("POST /api/inbox/:id/decision approves → durable native receipt; replay is rejected", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "review", "decision", "Approve push?");
    const { handle, displayProjection } = issue(dir, "git push");
    const approve = await decideInbox(dir, id, {
      handle,
      digest: displayProjection.digest,
      decision: "approve",
    });
    assert.equal(approve.ok, true);
    assert.equal(approve.status, 200);
    assert.equal(approve.result.kind, "native-receipt", "approved + executed exactly once");

    // Replaying the same handle after a completed round-trip is rejected at the door — the durable
    // tombstone means the handle is no longer pending, so it is never re-brokered or re-executed.
    const replay = await decideInbox(dir, id, {
      handle,
      digest: displayProjection.digest,
      decision: "approve",
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 409);
    assert.equal(replay.state, "consumed", "the handle folds to consumed (replay guard)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/inbox/:id/decision denies → typed denial (handle spent, never re-brokerable to approve)", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "review", "decision", "Approve push?");
    const { handle, displayProjection } = issue(dir, "git push");
    const deny = await decideInbox(dir, id, {
      handle,
      digest: displayProjection.digest,
      decision: "deny",
    });
    assert.equal(deny.status, 200);
    assert.equal(deny.result.kind, "rejected");
    assert.equal(deny.result.reason, "denied");

    // A spent (denied) handle cannot then be approved.
    const flip = await decideInbox(dir, id, {
      handle,
      digest: displayProjection.digest,
      decision: "approve",
    });
    assert.notEqual(flip.result?.kind, "native-receipt", "a denied handle never executes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/inbox/:id/decision rejects a tampered digest and an unknown handle", async () => {
  const dir = ws();
  try {
    const id = addAsk(dir, "review", "decision", "Approve push?");
    const { handle } = issueHandle(dir, {
      operation: "Bash",
      normalizedArgs: { command: "git push" },
      repoWorktreeIdentity: dir,
    });
    const tampered = await decideInbox(dir, id, {
      handle,
      digest: "deadbeef".repeat(8),
      decision: "approve",
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.status, 409);
    assert.equal(tampered.error, "digest-mismatch");

    const unknown = await decideInbox(dir, id, {
      handle: "not-a-real-handle",
      digest: "x",
      decision: "approve",
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.error, "unknown-handle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/inbox/:id/decision validates its input (bad decision, missing handle)", async () => {
  const dir = ws();
  try {
    const badDecision = await decideInbox(dir, "item", {
      handle: "h",
      digest: "d",
      decision: "maybe",
    });
    assert.equal(badDecision.status, 400);
    const noHandle = await decideInbox(dir, "item", { digest: "d", decision: "approve" });
    assert.equal(noHandle.status, 400);
    assert.equal(noHandle.error, "handle is required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
