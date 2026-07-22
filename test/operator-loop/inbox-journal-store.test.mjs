// Inbox journal store (I-02 / AIO-383) — the durability/concurrency acceptance:
//   • two concurrent writers (separate processes, asks-store lock discipline) produce no
//     interleaved/torn lines, the exact count, and a gap-free total order of `seq`;
//   • rotation at the size threshold produces `inbox-events.<seq>.ndjson` segments and rebuild reads
//     across them;
//   • after `compact`, rebuild remains byte-equivalent AND consumed-tombstones + receipts survive.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendInboxEvent,
  readJournalSegments,
  listSegments,
  rebuildReadModel,
  compactInboxJournal,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_INDEX = pathToFileURL(path.join(ROOT, "dist", "operator-loop", "index.js")).href;

function ws(tag = "inbox-store-") {
  return mkdtempSync(path.join(tmpdir(), tag));
}

function runAppender(root, tag, n) {
  return new Promise((resolve, reject) => {
    const script = `const { appendInboxEvent } = await import(${JSON.stringify(DIST_INDEX)});
const [root, tag, n] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < n; i++)
  appendInboxEvent(root, { kind: "observation-correlation", correlation_id: tag + "-" + i, payload: { source: "test", native_id: tag + "-" + i } });
`;
    const file = path.join(root, `appender-${tag}.mjs`);
    writeFileSync(file, script);
    const p = spawn("node", [file, root, tag, String(n)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`appender ${tag} exited ${code}: ${err}`))
    );
  });
}

test("2 writers × 40 concurrent appends: no corruption, exact count, gap-free total order", async () => {
  const root = ws("inbox-conc-");
  try {
    const N = 40;
    await Promise.all([runAppender(root, "A", N), runAppender(root, "B", N)]);

    // Every physical line across every segment parses.
    for (const seg of listSegments(root)) {
      const raw = readFileSync(seg.path, "utf8");
      for (const line of raw.split(/\r?\n/).filter(Boolean))
        assert.doesNotThrow(() => JSON.parse(line), `corrupt line: ${line}`);
    }
    const { events, warnings, tornTail } = readJournalSegments(root);
    assert.equal(warnings.length, 0, "no malformed lines under contention");
    assert.equal(tornTail, false);
    assert.equal(events.length, 2 * N, "every append landed");
    // seq is a gap-free 1..2N total order (the lock serializes seq assignment across processes).
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    assert.deepEqual(
      seqs,
      Array.from({ length: 2 * N }, (_, i) => i + 1),
      "seq is a gap-free total order"
    );
    assert.equal(new Set(seqs).size, 2 * N, "no duplicate seq");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotation: appending past the size threshold produces multiple <seq> segments, read across", () => {
  const root = ws("inbox-rot-");
  try {
    // A tiny per-segment cap forces a rotation every few events.
    const N = 20;
    for (let i = 0; i < N; i++) {
      appendInboxEvent(
        root,
        {
          kind: "observation-correlation",
          correlation_id: "c" + i,
          payload: { source: "s", native_id: "n" + i },
        },
        { segmentMaxBytes: 400 }
      );
    }
    const segs = listSegments(root);
    assert.ok(segs.length > 1, `rotation produced multiple segments (got ${segs.length})`);
    // Segments are the monotonic inbox-events.<seq>.ndjson family.
    assert.deepEqual(
      segs.map((s) => s.index),
      Array.from({ length: segs.length }, (_, i) => i + 1)
    );
    for (const s of segs) assert.match(path.basename(s.path), /^inbox-events\.\d+\.ndjson$/);

    // Rebuild reads across all segments.
    const r = rebuildReadModel(root);
    assert.equal(r.counts.events, N, "rebuild folds events from every segment");
    assert.equal(r.counts.items, N);
    const { events, warnings } = readJournalSegments(root);
    assert.equal(warnings.length, 0);
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from({ length: N }, (_, i) => i + 1),
      "total order is preserved across segment boundaries"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact: rebuild stays byte-equivalent AND tombstones/receipts/audit survive", () => {
  const root = ws("inbox-compact-");
  try {
    const cid = "corr-C";
    const p = (kind, payload) => appendInboxEvent(root, { kind, correlation_id: cid, payload });
    p("observation-correlation", { source: "email", native_id: "n1" });
    p("user-intent", { intent: "surface" });
    p("user-intent", { intent: "acknowledge" });
    p("user-intent", { intent: "propose" });
    p("user-intent", { intent: "submit" });
    p("pdp-decision", { decision: "approve" });
    p("capability-consumption", {
      capability_id: "cap-1",
      operation: "reply",
      request_digest: "d1",
    });
    p("action-attempt", {});
    p("outcome", { result: "succeeded" });
    p("native-receipt", { receipt_id: "r1", native_ref: "ref-1" });
    p("audit-checkpoint-link", { checkpoint_id: "ck-1", digest: "h1" });

    const before = rebuildReadModel(root);
    assert.equal(before.counts.tombstones, 1);
    assert.equal(before.counts.receipts, 1);
    assert.equal(before.counts.auditLinks, 1);

    // Full compaction (boundary = max seq): every transition event collapses into the snapshot; the
    // consumed-tombstone + receipt + audit events are retained verbatim.
    const cr = compactInboxJournal(root);
    assert.equal(cr.skipped, false);
    assert.ok(cr.prunedEvents >= 8, `transition events pruned (got ${cr.prunedEvents})`);
    assert.equal(cr.tombstones, 1);
    assert.equal(cr.receipts, 1);
    assert.equal(cr.auditLinks, 1);
    // The retained journal still physically contains the tombstone + receipt + audit lines.
    const { events } = readJournalSegments(root);
    const kinds = events.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["audit-checkpoint-link", "capability-consumption", "native-receipt"]);

    const after = rebuildReadModel(root);
    assert.equal(after.digest, before.digest, "rebuild after compact is byte-equivalent");
    assert.equal(after.builtFromSnapshot, true);
    assert.equal(after.counts.tombstones, 1, "consumed-tombstone preserved");
    assert.equal(after.counts.receipts, 1, "receipt preserved");
    assert.equal(after.counts.auditLinks, 1, "audit link preserved");
    assert.equal(after.counts.items, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compact at a partial boundary: rebuild still byte-equivalent (snapshot + post-boundary events)", () => {
  const root = ws("inbox-compact-partial-");
  try {
    const cid = "corr-P";
    const p = (kind, payload) => appendInboxEvent(root, { kind, correlation_id: cid, payload });
    p("observation-correlation", { source: "email", native_id: "n1" }); // seq 1
    p("user-intent", { intent: "surface" }); // seq 2
    p("capability-consumption", { capability_id: "cap-1", request_digest: "d" }); // seq 3 (retained)
    p("user-intent", { intent: "acknowledge" }); // seq 4
    p("user-intent", { intent: "propose" }); // seq 5
    p("native-receipt", { receipt_id: "r1" }); // seq 6 (retained)
    p("user-intent", { intent: "submit" }); // seq 7
    p("pdp-decision", { decision: "approve" }); // seq 8

    const before = rebuildReadModel(root);
    // Compact only the first half — leaves seq>4 in the journal, folds seq≤4 transitions to snapshot.
    const cr = compactInboxJournal(root, { boundarySeq: 4 });
    assert.equal(cr.skipped, false);
    const after = rebuildReadModel(root);
    assert.equal(after.digest, before.digest, "partial-boundary compaction is byte-equivalent");
    assert.equal(after.counts.tombstones, 1);
    assert.equal(after.counts.receipts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A non-blocking append (lockRetries: 0) must still reclaim a STALE lock rather than fail:
// reclaiming is not contention, so it must not consume the single permitted attempt. Regression for
// the ack/notify non-blocking paths, which would otherwise report notify-busy against a dead lock.
test("lockRetries:0 reclaims a stale lock but yields to a live one", async () => {
  const { appendInboxEvent } = await import(DIST_INDEX);
  const { mkdirSync, writeFileSync: wf, utimesSync } = await import("node:fs");
  const root = ws("inbox-stale-lock-");
  const lockDir = path.join(root, ".aios", "loop", "inbox");
  const lockPath = path.join(lockDir, "inbox-events.lock");
  const append = () =>
    appendInboxEvent(
      root,
      { kind: "human-ack", correlation_id: "ask-x", payload: { lane: "telegram" } },
      { lockRetries: 0 }
    );
  try {
    mkdirSync(lockDir, { recursive: true });

    // STALE lock (mtime well past the 30s threshold): a non-blocking append reclaims and succeeds.
    wf(lockPath, "dead-owner-token");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, old, old);
    const result = append();
    assert.ok(result?.seq >= 0, "a stale lock must be reclaimed, not reported busy");

    // FRESH lock (a live writer): the non-blocking append refuses immediately with the busy code.
    wf(lockPath, "live-owner-token");
    utimesSync(lockPath, new Date(), new Date());
    assert.throws(append, (e) => e?.code === "INBOX_JOURNAL_LOCK_BUSY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
