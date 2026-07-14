// Unified inbox — deterministic retention + deletion package (I-16 / AIO-397).
//
// The machine-readable retention TABLE (period + deletion procedure per store) lives beside the
// governance docs as `docs/v1-operator-loop/domains/inbox-governance/retention.yaml`; this module is
// the deterministic ENGINE that executes a deletion for a given store over BOTH the live store and
// its backup set — the domain spec's requirement that "deletion covers backups".
//
// The tamper-evidence ↔ deletion reconciliation (retention.yaml + audit.ts): the audit log holds
// only `payload_digest`s, never content, so deleting a user's records removes the content from live
// + backups while every audit digest survives — `verifyChain` still passes after deletion. This
// module records the deletion itself as a `retention.deletion` audit record (a digest of WHICH ids
// were removed — never the content), so the erasure is itself accountable.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { appendAuditRecord, digestPayload, type AuditRecord } from "./audit.js";

/**
 * A physical store the retention table governs. `livePaths`/`backupPaths` are directories under
 * which deletable entries live (root-relative or absolute). Directories are walked recursively; a
 * path that is itself a file is treated as a single deletable entry.
 */
export interface StoreDescriptor {
  /** Canonical store id — matches retention.yaml + the data-inventory doc. */
  id: string;
  livePaths: string[];
  backupPaths: string[];
}

export interface DeletionRequest {
  root: string;
  store: StoreDescriptor;
  /** Authenticated actor performing the erasure (recorded in the audit trail). */
  actor: string;
  /**
   * Which entries to delete, by store-relative path. Default: everything under the store's paths.
   * A selector lets a per-user / per-record-type erasure target a subset deterministically.
   */
  selector?: (relPath: string, absPath: string) => boolean;
  /** Reason string recorded (digested) in the audit record. */
  reason?: string;
}

export interface DeletionResult {
  store: string;
  liveRemoved: string[];
  backupRemoved: string[];
  /** The seq of the `retention.deletion` audit record, or null if nothing was removed. */
  auditSeq: number | null;
  auditRecord: AuditRecord | null;
}

/** Recursively list every file under a path (a file path yields itself; a missing path yields []). */
function listFiles(base: string): string[] {
  if (!existsSync(base)) return [];
  let st;
  try {
    st = statSync(base);
  } catch {
    return [];
  }
  if (st.isFile()) return [base];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    out.push(...listFiles(path.join(base, entry)));
  }
  return out;
}

function resolveUnder(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function collectRemovable(
  root: string,
  paths: string[],
  selector: DeletionRequest["selector"]
): Array<{ abs: string; rel: string }> {
  const hits: Array<{ abs: string; rel: string }> = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const baseAbs = resolveUnder(root, p);
    for (const abs of listFiles(baseAbs)) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      const rel = path.relative(root, abs);
      if (selector && !selector(rel, abs)) continue;
      hits.push({ abs, rel });
    }
  }
  return hits;
}

/**
 * Execute the deletion procedure for one store: remove the selected entries from the live store AND
 * the backup set, then append a `retention.deletion` audit record digesting the removed ids (paths
 * only — content is already gone, and was never in the audit log). Deterministic: given the same
 * store + selector, the removed set and the recorded digest are identical.
 *
 * verifyChain is unaffected — no audit record is removed; a new one is appended and the chain
 * extends. Content digests recorded earlier remain valid because they were only ever digests.
 */
export function executeDeletion(req: DeletionRequest): DeletionResult {
  const { root, store, actor } = req;
  const live = collectRemovable(root, store.livePaths, req.selector);
  const backup = collectRemovable(root, store.backupPaths, req.selector);

  const liveRemoved: string[] = [];
  const backupRemoved: string[] = [];
  for (const { abs, rel } of live) {
    rmSync(abs, { force: true });
    liveRemoved.push(rel);
  }
  for (const { abs, rel } of backup) {
    rmSync(abs, { force: true });
    backupRemoved.push(rel);
  }

  if (liveRemoved.length === 0 && backupRemoved.length === 0) {
    return { store: store.id, liveRemoved, backupRemoved, auditSeq: null, auditRecord: null };
  }

  // Digest WHICH ids were erased — never the content (content is gone; only accountability remains).
  const digest = digestPayload({
    store: store.id,
    reason: req.reason ?? null,
    live: [...liveRemoved].sort(),
    backup: [...backupRemoved].sort(),
  });
  const record = appendAuditRecord(root, {
    actor,
    event: "retention.deletion",
    payload_digest: digest,
    receipt: `store:${store.id}`,
  });
  return {
    store: store.id,
    liveRemoved,
    backupRemoved,
    auditSeq: record.seq,
    auditRecord: record,
  };
}

/**
 * The deterministic backup half: mirror a store's live entries into its backup path (byte copies),
 * preserving store-relative structure. So a later `executeDeletion` provably removes both copies.
 */
export function backupStore(
  root: string,
  store: StoreDescriptor,
  opts: { backupPath?: string } = {}
): { copied: string[] } {
  const backupBase = resolveUnder(root, opts.backupPath ?? store.backupPaths[0] ?? "");
  if (!backupBase) return { copied: [] };
  const copied: string[] = [];
  for (const liveBase of store.livePaths) {
    const liveAbs = resolveUnder(root, liveBase);
    for (const abs of listFiles(liveAbs)) {
      const rel = path.relative(liveAbs, abs);
      const dest = path.join(backupBase, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(abs));
      copied.push(path.relative(root, dest));
    }
  }
  return { copied };
}
