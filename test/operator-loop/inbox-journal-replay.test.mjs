// Inbox journal replay (I-02 / AIO-383) — the deterministic-rebuild acceptance:
//   (a) rebuilding twice from identical inputs → byte-equivalent (content-digest) projection;
//   (b) after the asks store's 7-day GC deletes resolved asks, the rebuild is UNCHANGED (journal is
//       canonical, asks rows are advisory);
//   (c) truncating inbox-events.ndjson at EVERY byte boundary recovers a clean prefix — at most the
//       torn tail line is dropped, never corrupt;
//   (d) a legacy `schema_version: 1` fixture still rebuilds without loss.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendInboxEvent,
  rebuildReadModel,
  INBOX_DIR_REL,
  appendCreate,
  appendOp,
  compact as asksCompact,
} from "../../dist/operator-loop/index.js";

const DAY = 86_400_000;

function ws(tag = "inbox-replay-") {
  return mkdtempSync(path.join(tmpdir(), tag));
}
function segPath(root, index = 1) {
  return path.join(root, INBOX_DIR_REL, `inbox-events.${index}.ndjson`);
}
function writeSegment(root, content) {
  const p = segPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// A small but representative workflow: correlation, attention moves, an approved action that runs
// to an unknown-then-succeeded outcome, a consumed capability, a native receipt, an audit link.
function seedWorkflow(root) {
  const cid = "corr-A";
  const p = (kind, payload) => appendInboxEvent(root, { kind, correlation_id: cid, payload });
  p("observation-correlation", { source: "email", native_id: "n1", ask_id: "ask-1" });
  p("user-intent", { intent: "surface" });
  p("user-intent", { intent: "acknowledge" });
  p("user-intent", { intent: "propose" });
  p("user-intent", { intent: "submit" });
  p("pdp-decision", { decision: "approve" });
  p("capability-consumption", { capability_id: "cap-1", operation: "reply", request_digest: "d1" });
  p("action-attempt", {});
  p("outcome", { result: "outcome_unknown" });
  p("native-receipt", { receipt_id: "r1", native_ref: "ref-1" });
  p("outcome", { result: "succeeded" });
  p("audit-checkpoint-link", { checkpoint_id: "ck-1", digest: "h1" });
  return cid;
}

test("rebuilding twice from identical inputs yields a byte-equivalent projection", () => {
  const root = ws();
  try {
    seedWorkflow(root);
    const a = rebuildReadModel(root);
    const b = rebuildReadModel(root);
    assert.equal(a.digest, b.digest, "identical inputs → identical digest");
    assert.equal(a.counts.events, 12);
    assert.equal(a.counts.items, 1);
    assert.equal(a.counts.tombstones, 1);
    assert.equal(a.counts.receipts, 1);
    assert.equal(a.counts.auditLinks, 1);
    assert.equal(a.warnings.length, 0, `no warnings: ${JSON.stringify(a.warnings)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuild is byte-equivalent AFTER the asks store's 7-day GC deletes correlated asks", () => {
  const root = ws();
  try {
    // Seed real asks the journal correlates to.
    const askA = appendCreate(root, { kind: "k", severity: "fyi", title: "A", source: "test" });
    const askB = appendCreate(root, { kind: "k", severity: "fyi", title: "B", source: "test" });
    // Journal references those ask ids.
    appendInboxEvent(root, {
      kind: "observation-correlation",
      correlation_id: "corr-1",
      payload: { source: "email", ask_id: askA.id },
    });
    appendInboxEvent(root, {
      kind: "observation-correlation",
      correlation_id: "corr-2",
      payload: { source: "slack", ask_id: askB.id },
    });
    appendInboxEvent(root, {
      kind: "user-intent",
      correlation_id: "corr-1",
      payload: { intent: "surface" },
    });

    const before = rebuildReadModel(root);

    // Resolve + GC the asks 8 days out (older than RESOLVED_GC_DAYS=7) — deletes them from asks.ndjson.
    const now = new Date("2026-08-01T00:00:00.000Z");
    appendOp(root, "resolve", askA.id, new Date(now.getTime() - 8 * DAY).toISOString());
    appendOp(root, "resolve", askB.id, new Date(now.getTime() - 8 * DAY).toISOString());
    const gc = asksCompact(root, now);
    assert.ok(gc.removed >= 2, `asks GC removed the resolved asks (removed=${gc.removed})`);

    const after = rebuildReadModel(root);
    assert.equal(
      after.digest,
      before.digest,
      "journal is canonical — asks GC does not change the projection"
    );
    // The advisory cross-check now flags the GC'd asks (report-only; not in the digest).
    assert.ok(after.warnings.some((w) => /not present in asks store/.test(w)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncation at EVERY byte boundary recovers a clean prefix (drops at most the torn tail)", () => {
  const src = ws("inbox-trunc-src-");
  let bytes, lines;
  try {
    seedWorkflow(src);
    bytes = readFileSync(segPath(src), "utf8");
    lines = bytes.split("\n").filter((l) => l.length > 0);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
  assert.ok(lines.length >= 10);

  // Precompute the reference digest for the first k complete lines (k = 0..N), once.
  const digestForFirstK = [];
  for (let k = 0; k <= lines.length; k++) {
    const ref = ws("inbox-trunc-ref-");
    try {
      writeSegment(ref, k === 0 ? "" : lines.slice(0, k).join("\n") + "\n");
      digestForFirstK.push(rebuildReadModel(ref).digest);
    } finally {
      rmSync(ref, { recursive: true, force: true });
    }
  }

  const buf = Buffer.from(bytes, "utf8");
  for (let L = 0; L <= buf.length; L++) {
    const prefix = buf.subarray(0, L).toString("utf8");
    const nl = (prefix.match(/\n/g) || []).length; // fully-terminated lines
    const root = ws("inbox-trunc-");
    try {
      writeSegment(root, prefix);
      const r1 = rebuildReadModel(root);
      const r2 = rebuildReadModel(root);
      assert.equal(r1.digest, r2.digest, `L=${L}: deterministic`);
      // At most one extra line beyond the terminated ones (a complete-but-unterminated tail line).
      assert.ok(
        r1.counts.events === nl || r1.counts.events === nl + 1,
        `L=${L}: recovered ${r1.counts.events} not in {${nl}, ${nl + 1}}`
      );
      // Whatever it recovered, it equals rebuilding from exactly that many clean lines — i.e. a
      // clean prefix, never a corrupt fold.
      assert.equal(
        r1.digest,
        digestForFirstK[r1.counts.events],
        `L=${L}: recovered projection is a clean ${r1.counts.events}-line prefix`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy schema_version:1 records (no causation_id) still rebuild without loss", () => {
  const legacy = ws("inbox-legacy-");
  const modern = ws("inbox-modern-");
  try {
    // v1 lines: schema_version 1, no causation_id / payload wrapping differences.
    const v1 = [
      {
        schema_version: 1,
        id: "e1",
        seq: 1,
        ts: "2026-07-01T00:00:01.000Z",
        kind: "observation-correlation",
        correlation_id: "c1",
        payload: { source: "email", native_id: "n1" },
      },
      {
        schema_version: 1,
        id: "e2",
        seq: 2,
        ts: "2026-07-01T00:00:02.000Z",
        kind: "user-intent",
        correlation_id: "c1",
        payload: { intent: "surface" },
      },
      {
        schema_version: 1,
        id: "e3",
        seq: 3,
        ts: "2026-07-01T00:00:03.000Z",
        kind: "capability-consumption",
        correlation_id: "c1",
        payload: { capability_id: "cap-x", operation: "reply", request_digest: "d" },
      },
    ];
    writeSegment(legacy, v1.map((o) => JSON.stringify(o)).join("\n") + "\n");
    const rl = rebuildReadModel(legacy);
    assert.equal(rl.counts.events, 3, "all legacy lines fold");
    assert.equal(rl.counts.items, 1);
    assert.equal(rl.counts.tombstones, 1);
    assert.equal(rl.warnings.length, 0, `legacy folds cleanly: ${JSON.stringify(rl.warnings)}`);

    // The same logical events at schema_version 2 (causation_id: null) project identically.
    const v2 = v1.map((o) => ({ ...o, schema_version: 2, causation_id: null }));
    writeSegment(modern, v2.map((o) => JSON.stringify(o)).join("\n") + "\n");
    const rm = rebuildReadModel(modern);
    assert.equal(
      rl.digest,
      rm.digest,
      "legacy read yields the same projection as the modern encoding"
    );
  } finally {
    rmSync(legacy, { recursive: true, force: true });
    rmSync(modern, { recursive: true, force: true });
  }
});
