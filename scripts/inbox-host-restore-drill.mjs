#!/usr/bin/env node
/**
 * inbox-host-restore-drill.mjs — the DRILLED backup/restore of the Fly coordinator's SQLite +
 * journal (I-15 / AIO-396, the G6b gate).
 *
 * The spec's backup/restore acceptance is a RUNNABLE check, not prose: this script exits 0 ONLY when
 *   (a) a fresh-machine restore yields projections BYTE-EQUIVALENT to a pre-backup rebuild, and
 *   (b) the audit chain VERIFIES post-restore (the recorded checkpoint digest still matches the
 *       restored data, so a tampered backup is caught).
 *
 * D5 backup mode (domain doc decision table): `better-sqlite3` with WAL. The consistent-backup unit
 * is the append-only journal (`inbox-events.ndjson` segments + the compaction snapshot) — the SQLite
 * read model is a DETERMINISTIC projection of it, so backing up the journal and re-projecting on the
 * fresh machine is provably equivalent to (and safer than) copying a live WAL database. The
 * "byte-equivalent projection" invariant is the canonical `readModelDigest` (projected state, ordered
 * by primary key), exactly as I-02 defined it.
 *
 * Everything is admin-tier local: the drill runs entirely on-host in temp dirs; nothing is synced.
 * Deterministic: fixed event timestamps + injected ids, no wall-clock in the projection.
 *
 * Usage:
 *   node scripts/inbox-host-restore-drill.mjs [--keep] [--json]
 *     --keep   leave the temp source/restore dirs on disk for inspection
 *     --json   emit the drill report as JSON (default: human-readable + drill notes path)
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";
import { c } from "./cli-common.mjs";

const INBOX_REL = ".aios/loop/inbox";
const AUDIT_KIND = "audit-checkpoint-link";

/** Seed a deterministic, lifecycle-complete journal: one correlated thread that sends + receipts,
 *  one consumed capability tombstone. Fixed ts/ids so the projection digest is reproducible. */
function seedJournal(loop, root) {
  const at = (n) => new Date(Date.UTC(2026, 6, 14, 9, 0, n)).toISOString();
  const ev = (kind, correlation_id, payload, ts) =>
    loop.appendInboxEvent(root, { kind, correlation_id, causation_id: null, payload, ts });
  ev(
    "observation-correlation",
    "corr_1",
    { source: "gmail", native_id: "m1", thread_id: "t1", source_transition: "correlated" },
    at(1)
  );
  ev("user-intent", "corr_1", { intent: "surface" }, at(2));
  ev("pdp-decision", "corr_1", { decision: "approve" }, at(3));
  ev(
    "capability-consumption",
    "corr_1",
    { capability_id: "cap_1", operation: "gmail.send", request_digest: "sha256:abc" },
    at(4)
  );
  ev("action-attempt", "corr_1", { operation: "gmail.send" }, at(5));
  ev("outcome", "corr_1", { result: "succeeded" }, at(6));
  ev("native-receipt", "corr_1", { receipt_id: "rcpt_1", native_ref: "gmail:msgid-1" }, at(7));
}

/** Rebuild a journal at `root` into a scratch db and return the canonical projection digest. */
function digestOf(loop, root) {
  const dbPath = path.join(root, INBOX_REL, "drill-read-model.db");
  loop.rebuildReadModel(root, { dbPath });
  return loop.readModelDigest(dbPath);
}

/** Rebuild ONLY the data events (excluding audit-checkpoint-link) into a fresh scratch root, so we
 *  can recompute the anchor the checkpoint recorded and confirm the restored data still matches it.
 *  Seq numbers are preserved verbatim (written as-is), so first_seq/last_seq — and thus the digest —
 *  are identical to the original data-only projection. This is the audit-chain verification. */
function dataOnlyDigest(loop, sourceRoot, scratchRoot) {
  const { events } = loop.readJournalSegments(sourceRoot);
  const dataLines = events
    .filter((e) => e.kind !== AUDIT_KIND)
    .map((e) => JSON.stringify(e))
    .join("\n");
  const seg = path.join(scratchRoot, INBOX_REL, "inbox-events.0.ndjson");
  mkdirSync(path.dirname(seg), { recursive: true });
  writeFileSync(seg, dataLines + (dataLines ? "\n" : ""), "utf8");
  return digestOf(loop, scratchRoot);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const keep = args.has("--keep");
  const loop = await loadOperatorLoop();

  const base = mkdtempSync(path.join(tmpdir(), "inbox-restore-drill-"));
  const sourceRoot = path.join(base, "source"); // the "live" coordinator
  const restoreRoot = path.join(base, "restore"); // the "fresh machine"
  const scratchA = path.join(base, "scratch-a");
  const scratchB = path.join(base, "scratch-b");
  mkdirSync(sourceRoot, { recursive: true });

  const steps = [];
  let ok = true;
  const check = (name, pass, detail) => {
    steps.push({ name, pass, detail });
    if (!pass) ok = false;
  };

  try {
    // 1) Seed the source journal + compute the anchor over the DATA events (pre-checkpoint).
    seedJournal(loop, sourceRoot);
    const anchor = dataOnlyDigest(loop, sourceRoot, scratchA);

    // 2) Anchor the audit chain: write an audit-checkpoint-link recording the data digest.
    const { events } = loop.readJournalSegments(sourceRoot);
    const throughSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
    loop.appendInboxEvent(sourceRoot, {
      kind: AUDIT_KIND,
      correlation_id: "corr_1",
      causation_id: null,
      payload: {
        checkpoint_id: "ckpt_1",
        through_seq: throughSeq,
        digest: anchor,
        ref: "brain:checkpoint/drill",
      },
      ts: new Date(Date.UTC(2026, 6, 14, 9, 5, 0)).toISOString(),
    });

    // 3) Pre-backup rebuild digest (the reference the restore must reproduce byte-for-byte).
    const preBackupDigest = digestOf(loop, sourceRoot);

    // 4) BACKUP → RESTORE: copy the consistent backup unit (journal segments + snapshot) to a fresh
    //    machine. cpSync of the inbox dir is the backup artifact; a real host tars this + ships it.
    mkdirSync(path.join(restoreRoot, INBOX_REL), { recursive: true });
    cpSync(path.join(sourceRoot, INBOX_REL), path.join(restoreRoot, INBOX_REL), {
      recursive: true,
    });

    // 5) CHECK (a): the fresh-machine rebuild is byte-equivalent to the pre-backup rebuild.
    const restoredDigest = digestOf(loop, restoreRoot);
    check(
      "byte-equivalent-projection",
      restoredDigest === preBackupDigest,
      `pre-backup ${preBackupDigest.slice(0, 16)}… vs restored ${restoredDigest.slice(0, 16)}…`
    );

    // 6) CHECK (b): the audit chain verifies — the restored data reproduces the recorded anchor.
    const restoredEvents = loop.readJournalSegments(restoreRoot).events;
    const checkpoint = restoredEvents.filter((e) => e.kind === AUDIT_KIND).pop();
    const recordedDigest = checkpoint?.payload?.digest ?? null;
    const recomputed = dataOnlyDigest(loop, restoreRoot, scratchB);
    check(
      "audit-chain-verified",
      Boolean(recordedDigest) && recordedDigest === recomputed && recomputed === anchor,
      `checkpoint ${String(recordedDigest).slice(0, 16)}… vs recomputed ${recomputed.slice(0, 16)}…`
    );

    // 7) Commit the drill notes beside the source so the run is auditable.
    const notes = {
      drill: "inbox-host-restore-drill",
      issue: "AIO-396",
      backup_mode:
        "journal segments + snapshot → deterministic re-projection (D5: better-sqlite3 WAL)",
      through_seq: throughSeq,
      anchor_digest: anchor,
      pre_backup_digest: preBackupDigest,
      restored_digest: restoredDigest,
      checks: steps,
      ok,
    };
    const notesPath = path.join(sourceRoot, INBOX_REL, "restore-drill-notes.json");
    writeFileSync(notesPath, JSON.stringify(notes, null, 2) + "\n", "utf8");

    if (asJson) {
      console.log(
        JSON.stringify(
          { ...notes, notes_path: keep ? notesPath : "(temp; --keep to retain)" },
          null,
          2
        )
      );
    } else {
      console.log(c.blue("inbox host restore drill") + c.dim("  (admin-tier local; never synced)"));
      for (const s of steps) {
        console.log(`  ${s.pass ? c.green("✓") : c.red("✗")} ${s.name}  ${c.dim(s.detail)}`);
      }
      console.log(
        ok
          ? c.green("  ✓ restore is byte-equivalent and the audit chain verifies")
          : c.red("  ✗ DRILL FAILED — restore is NOT trustworthy")
      );
      if (keep) console.log(c.dim(`  notes: ${notesPath}`));
    }
  } finally {
    if (!keep) rmSync(base, { recursive: true, force: true });
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`inbox-host-restore-drill: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
