// Inbox audit anchor + retention package (I-16 / AIO-397). Drives the compiled dist surface:
//   • hash-chain verification passes on an intact log, fails on any single-byte mutation, and
//     PASSES AGAIN after a backup/restore cycle verified against a faked (host-independent) anchor
//     endpoint;
//   • checkpoint cadence is honored on a time-faked run (emits at each cadence boundary, skips
//     before, never re-anchors a tail already covered);
//   • executing a store's deletion procedure removes it from the live store AND the backup set
//     while `verifyChain` still exits pass (the digest survives, the content is gone);
//   • the redaction/doc lint exits non-zero on a body/subject/participant string and zero on a
//     clean fixture.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAuditRecord,
  readAuditLog,
  auditLogPath,
  createLocalAnchorSink,
  auditCheckpoint,
  runCheckpointCadence,
  checkpointDue,
  verifyChain,
  verifyAuditStore,
  backupAuditStore,
  restoreAuditStore,
  digestPayload,
  computeRecordHash,
  executeDeletion,
  backupStore,
} from "../../dist/operator-loop/index.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LINT = path.join(REPO, "scripts", "inbox-redaction-lint.mjs");
const INBOX_REL = ".aios/loop/inbox";

function ws(tag = "inbox-audit-") {
  return mkdtempSync(path.join(tmpdir(), tag));
}

/** Append a small governance chain and return its records. */
function seedChain(root, n = 4) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    recs.push(
      appendAuditRecord(root, {
        actor: "owner:alex",
        event: i % 2 === 0 ? "pdp.decision" : "capability.consumed",
        correlation_id: `corr_${i}`,
        payload: { i, note: `synthetic decision ${i}` },
        receipt: `runtime:tombstone_${i}`,
      })
    );
  }
  return recs;
}

test("appended chain links (prev_hash) and every record hash is self-consistent", () => {
  const root = ws();
  const recs = seedChain(root, 5);
  assert.equal(recs[0].prev_hash, "sha256:genesis");
  for (let i = 1; i < recs.length; i++) {
    assert.equal(recs[i].prev_hash, recs[i - 1].hash, "prev_hash links to prior record");
    assert.equal(recs[i].seq, recs[i - 1].seq + 1, "seq is contiguous");
  }
  for (const r of recs) {
    const { hash, ...body } = r;
    assert.equal(computeRecordHash(body), hash, "stored hash == recomputed hash");
  }
  const { records } = readAuditLog(root);
  assert.equal(records.length, 5);
  assert.ok(verifyChain(records).ok, "intact chain verifies");
  rmSync(root, { recursive: true, force: true });
});

test("records carry payload DIGESTS only — never the payload bodies", () => {
  const root = ws();
  const body = { subject: "Q3 board deck review", to: "dana.whitfield@example.com" };
  const rec = appendAuditRecord(root, {
    actor: "owner:alex",
    event: "action.attempt",
    payload: body,
  });
  const line = readFileSync(auditLogPath(root), "utf8");
  assert.ok(rec.payload_digest.startsWith("sha256:"), "digest is a sha256");
  assert.equal(rec.payload_digest, digestPayload(body));
  assert.ok(!line.includes("Q3 board deck review"), "subject never written to the audit log");
  assert.ok(!line.includes("dana.whitfield@example.com"), "participant never written");
  rmSync(root, { recursive: true, force: true });
});

test("verifyChain FAILS on any single-byte mutation of the stored log", () => {
  const root = ws();
  seedChain(root, 4);
  const p = auditLogPath(root);
  const original = readFileSync(p, "utf8");

  // Flip a single byte inside an interior record's stored content.
  const idx = Math.floor(original.length / 2);
  const flipped = original[idx] === "a" ? "b" : "a";
  const mutated = original.slice(0, idx) + flipped + original.slice(idx + 1);
  assert.notEqual(mutated, original, "mutation actually changed a byte");
  writeFileSync(p, mutated);

  const res = verifyAuditStore(root);
  assert.equal(res.ok, false, "a single-byte mutation is detected");
  assert.ok(res.failures.length > 0, "failures are reported with detail");
  rmSync(root, { recursive: true, force: true });
});

test("chain PASSES after a backup/restore cycle, verified against a faked host-independent anchor", () => {
  const root = ws();
  // Anchors live OUTSIDE the inbox store, so an inbox wipe/restore never erases them.
  const anchorDir = ws("inbox-anchor-");
  const sink = createLocalAnchorSink(anchorDir);

  seedChain(root, 6);
  const { anchor } = auditCheckpoint(root, sink, { at: "2026-07-14T09:05:00.000Z" });
  assert.ok(anchor.chain_head.startsWith("sha256:"));
  assert.equal(anchor.signature, null, "no signer configured → no false signature claim");

  // Back up the audit store, then simulate a full inbox loss.
  const backupDir = ws("inbox-backup-");
  backupAuditStore(root, backupDir);
  rmSync(path.join(root, INBOX_REL), { recursive: true, force: true });
  assert.equal(existsSync(auditLogPath(root)), false, "inbox store was wiped");

  // Restore from backup and verify against the independently-held anchors.
  restoreAuditStore(root, backupDir);
  const restored = verifyAuditStore(root, sink);
  assert.equal(restored.ok, true, "restored chain verifies against the retained anchors");
  assert.ok(restored.anchorsChecked >= 1, "at least one anchor was checked");

  // A tampered restore (anchored prefix mutated) is caught by the anchor digest/head check.
  const recs = readAuditLog(root).records;
  const forged = recs.map((r, i) => (i === 1 ? { ...r, actor: "attacker:mallory" } : r));
  const bad = verifyChain(forged, sink.list());
  assert.equal(bad.ok, false, "a mutated prefix fails against the anchor");

  rmSync(root, { recursive: true, force: true });
  rmSync(anchorDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
});

test("checkpoint cadence honored on a time-faked run", () => {
  const root = ws();
  const anchorDir = ws("inbox-anchor-");
  const sink = createLocalAnchorSink(anchorDir);
  const cadenceMs = 60 * 60 * 1000; // hourly cadence
  const t0 = Date.parse("2026-07-14T09:00:00.000Z");

  // No records yet → nothing to anchor.
  assert.equal(runCheckpointCadence(root, sink, { cadenceMs, now: t0 }).reason, "no-new-records");

  seedChain(root, 2);
  // First run with records is always due (no prior anchor).
  const first = runCheckpointCadence(root, sink, { cadenceMs, now: t0 });
  assert.equal(first.emitted, true, "first cadence run emits");
  assert.equal(sink.list().length, 1);

  // 30 min later, new records but cadence not elapsed → not due.
  appendAuditRecord(root, { actor: "owner:alex", event: "action.outcome", payload: { ok: true } });
  const early = runCheckpointCadence(root, sink, { cadenceMs, now: t0 + 30 * 60 * 1000 });
  assert.equal(early.emitted, false);
  assert.equal(early.reason, "not-due");
  assert.equal(sink.list().length, 1, "no premature anchor");

  // 60 min later → due, emits a second anchor covering the new record.
  const due = runCheckpointCadence(root, sink, { cadenceMs, now: t0 + 60 * 60 * 1000 });
  assert.equal(due.emitted, true);
  assert.equal(sink.list().length, 2);
  assert.ok(due.anchor.through_seq > first.anchor.through_seq, "second anchor advances");

  // Immediately again with no new records → nothing to anchor.
  const again = runCheckpointCadence(root, sink, { cadenceMs, now: t0 + 61 * 60 * 1000 });
  assert.equal(again.emitted, false);
  assert.equal(again.reason, "no-new-records");

  assert.equal(checkpointDue([], { cadenceMs, now: t0 }), true, "empty anchors → due");

  rmSync(root, { recursive: true, force: true });
  rmSync(anchorDir, { recursive: true, force: true });
});

test("deletion removes a store from live AND backup while verifyChain still passes", () => {
  const root = ws();
  const anchorDir = ws("inbox-anchor-");
  const sink = createLocalAnchorSink(anchorDir);

  // A cached-bodies content store: live + a backup mirror.
  const liveDir = path.join(root, INBOX_REL, "bodies");
  const backupDir = path.join(root, INBOX_REL, "backups", "bodies");
  mkdirSync(liveDir, { recursive: true });
  const bodyText = "Let's move the kickoff to Thursday afternoon";
  writeFileSync(path.join(liveDir, "msg-1.txt"), bodyText);
  writeFileSync(path.join(liveDir, "msg-2.txt"), "second body");

  // Record the DIGEST of a body in the audit log (never the body itself), then anchor.
  appendAuditRecord(root, {
    actor: "owner:alex",
    event: "action.attempt",
    correlation_id: "corr_del",
    payload_digest: digestPayload(bodyText),
    receipt: "runtime:tombstone_del",
  });
  seedChain(root, 2);
  auditCheckpoint(root, sink, { at: "2026-07-14T09:05:00.000Z" });

  // Mirror live → backup, so both copies provably exist before deletion.
  const store = {
    id: "snippets_body_cache",
    livePaths: [path.join(INBOX_REL, "bodies")],
    backupPaths: [path.join(INBOX_REL, "backups", "bodies")],
  };
  backupStore(root, store);
  assert.ok(existsSync(path.join(backupDir, "msg-1.txt")), "backup mirror created");

  const before = verifyAuditStore(root, sink);
  assert.equal(before.ok, true, "chain verifies before deletion");
  const auditBytesBefore = readFileSync(auditLogPath(root), "utf8");

  // Execute the deletion procedure for the store.
  const result = executeDeletion({
    root,
    store,
    actor: "owner:alex",
    reason: "user erasure request",
  });
  assert.ok(result.liveRemoved.length >= 2, "live entries removed");
  assert.ok(result.backupRemoved.length >= 2, "backup entries removed");
  assert.equal(existsSync(path.join(liveDir, "msg-1.txt")), false, "live body gone");
  assert.equal(existsSync(path.join(backupDir, "msg-1.txt")), false, "backup body gone");
  assert.ok(typeof result.auditSeq === "number", "a retention.deletion record was appended");

  // The audit log gained the deletion record but no earlier record changed.
  const auditBytesAfter = readFileSync(auditLogPath(root), "utf8");
  assert.ok(auditBytesAfter.startsWith(auditBytesBefore), "prior audit records unchanged");
  assert.ok(!auditBytesAfter.includes(bodyText), "deleted content never entered the audit log");

  // verifyChain STILL passes — digests survived, content is gone.
  const after = verifyAuditStore(root, sink);
  assert.equal(after.ok, true, "chain still verifies after deleting user content");
  assert.ok(after.records > before.records, "the deletion itself is audited");

  rmSync(root, { recursive: true, force: true });
  rmSync(anchorDir, { recursive: true, force: true });
});

test("SELECTIVE deletion (per-user selector) removes the record from BOTH the live tree and the backup tree", () => {
  const root = ws();
  const anchorDir = ws("inbox-anchor-");
  const sink = createLocalAnchorSink(anchorDir);
  seedChain(root, 2);
  auditCheckpoint(root, sink, { at: "2026-07-14T09:05:00.000Z" });

  // Per-user layout: <store>/<user>/<record>. Backups are re-rooted under a DIFFERENT base, so a
  // root-relative key would never match a backup — the selector must be keyed store-relative.
  const liveDir = path.join(root, INBOX_REL, "bodies");
  const backupDir = path.join(root, INBOX_REL, "backups", "bodies");
  mkdirSync(path.join(liveDir, "alex"), { recursive: true });
  mkdirSync(path.join(liveDir, "sam"), { recursive: true });
  writeFileSync(path.join(liveDir, "alex", "msg-1.txt"), "alex body one");
  writeFileSync(path.join(liveDir, "sam", "msg-2.txt"), "sam body two");

  const store = {
    id: "snippets_body_cache",
    livePaths: [path.join(INBOX_REL, "bodies")],
    backupPaths: [path.join(INBOX_REL, "backups", "bodies")],
  };
  backupStore(root, store);
  assert.ok(existsSync(path.join(backupDir, "alex", "msg-1.txt")), "backup mirror created");

  // Erase ONLY alex's records — one store-relative key matches live AND backup copies.
  const result = executeDeletion({
    root,
    store,
    actor: "owner:alex",
    reason: "per-user erasure request",
    selector: (rel) => rel.split(path.sep)[0] === "alex",
  });

  assert.deepEqual(result.liveRemoved, [path.join("alex", "msg-1.txt")]);
  assert.deepEqual(result.backupRemoved, [path.join("alex", "msg-1.txt")]);
  assert.equal(existsSync(path.join(liveDir, "alex", "msg-1.txt")), false, "live copy gone");
  assert.equal(existsSync(path.join(backupDir, "alex", "msg-1.txt")), false, "backup copy gone");
  assert.ok(existsSync(path.join(liveDir, "sam", "msg-2.txt")), "unselected live record survives");
  assert.ok(
    existsSync(path.join(backupDir, "sam", "msg-2.txt")),
    "unselected backup record survives"
  );
  assert.ok(typeof result.auditSeq === "number", "the selective erasure is audited");

  const after = verifyAuditStore(root, sink);
  assert.equal(after.ok, true, "chain still verifies after the selective deletion");

  rmSync(root, { recursive: true, force: true });
  rmSync(anchorDir, { recursive: true, force: true });
});

test("the redaction/doc lint exits non-zero on a leak and zero on a clean fixture", () => {
  // Clean run (default targets) exits 0.
  execFileSync("node", [LINT], { cwd: REPO, encoding: "utf8" });

  // A dirty telemetry fixture carrying a subject string exits non-zero.
  const dir = ws("inbox-redact-");
  const dirty = path.join(dir, "inbox-telemetry-dirty.jsonl");
  writeFileSync(dirty, JSON.stringify({ payload: { note: "Q3 board deck review" } }) + "\n");
  assert.throws(
    () =>
      execFileSync("node", [LINT, "--check", "redaction", "--telemetry", dirty], {
        cwd: REPO,
        stdio: "pipe",
      }),
    /forbidden string|Command failed/,
    "lint fails on a forbidden string"
  );

  // A clean telemetry fixture (digests/counts only) exits 0.
  const clean = path.join(dir, "inbox-telemetry-ok.jsonl");
  writeFileSync(clean, JSON.stringify({ payload: { digest: "sha256:abcd", count: 3 } }) + "\n");
  execFileSync("node", [LINT, "--check", "redaction", "--telemetry", clean], {
    cwd: REPO,
    encoding: "utf8",
  });

  rmSync(dir, { recursive: true, force: true });
});
