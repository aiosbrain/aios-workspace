// Reconcile — the confirm/correct step that makes the derived tags trustworthy. Targets rows by
// opaque id. Confirmed rows are IMMUTABLE (no re-tag, re-tier, or re-confirm). An unknown id or an
// invalid tag/tier is an error, and validation is ATOMIC: nothing is written unless every targeted
// id is valid and mutable, so a single bad id never leaves a partial write.

import { readStore, writeStore, type StoreRow } from "./store.js";
import { TAGS, type Tag } from "./runtime.js";

const TIERS: ReadonlySet<string> = new Set(["admin", "team", "external"]);

export interface ReconcileOptions {
  root: string;
  ids: string[];
  setTag?: string;
  setTier?: string;
  confirm?: boolean;
  dryRun?: boolean;
}

export interface ReconcileResult {
  updated: string[];
  dryRun: boolean;
  rel: string;
}

export function reconcile(opts: ReconcileOptions): ReconcileResult {
  const { root, ids } = opts;
  if (!ids.length) throw new Error("reconcile: no --id given");
  if (opts.setTag === undefined && opts.setTier === undefined && !opts.confirm) {
    throw new Error("reconcile: nothing to do — pass --set-tag, --set-tier, and/or --confirm");
  }
  if (opts.setTag !== undefined && !(TAGS as readonly string[]).includes(opts.setTag)) {
    throw new Error(`reconcile: invalid tag "${opts.setTag}" (one of ${TAGS.join("|")})`);
  }
  if (opts.setTier !== undefined && !TIERS.has(opts.setTier)) {
    throw new Error(`reconcile: invalid tier "${opts.setTier}" (one of admin|team|external)`);
  }

  const read = readStore(root);
  const byId = new Map<string, StoreRow>(read.rows.map((r) => [r.id, r]));

  // Validate every id first (atomic: no partial write on a bad/confirmed id).
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new Error(`reconcile: no time row with id ${id}`);
    if (row.confirmed) throw new Error(`reconcile: row ${id} is confirmed and immutable`);
  }

  for (const id of ids) {
    const row = byId.get(id) as StoreRow;
    if (opts.setTag !== undefined) row.tag = opts.setTag as Tag;
    if (opts.setTier !== undefined) row.tier = opts.setTier;
    if (opts.confirm) row.confirmed = true;
  }

  if (!opts.dryRun) writeStore(root, read.rows);
  return { updated: [...ids], dryRun: Boolean(opts.dryRun), rel: read.rel };
}
