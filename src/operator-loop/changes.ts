// Artifact change-tracking primitive — a content-fingerprint snapshot diff over signals.
// Generic over ANY signal kind; the daily light loop (C4) is its first consumer, but nothing
// here knows about "daily" — weekly/telemetry/future consumers feed (prior, signals, now,
// scope) unchanged.
//
// Change is detected on CONTENT, not mtime: the fingerprint basis deliberately EXCLUDES
// occurredAt, so a file touch that changes nothing registers no change, and a single edited
// row of many marks only that row. A per-scope snapshot lives under .aios/loop/state/ — the
// same local-only, never-synced boundary as run manifests and the continuity store.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Signal } from "./signal.js";

export type ChangeType = "added" | "modified" | "unchanged";

export interface SnapshotEntry {
  fingerprint: string;
  firstSeenAt: string; // ISO — when this artifact key was first recorded
  lastChangedAt: string; // ISO — when its fingerprint last changed
}

export interface SnapshotStore {
  version: 1;
  scope: string; // e.g. "daily" | "weekly"
  updatedAt: string; // ISO — when the snapshot was last written
  artifacts: Record<string, SnapshotEntry>;
}

export interface SignalChange {
  key: string;
  changeType: ChangeType;
  firstSeenAt: string;
  lastChangedAt: string;
}

const SNAPSHOT_VERSION = 1 as const;

/** Stable identity for an artifact: its evidence ref path plus optional row key. */
export function artifactKey(sig: Signal): string {
  return sig.ref.row ? `${sig.ref.path}#${sig.ref.row}` : sig.ref.path;
}

/**
 * Deterministic JSON with recursively sorted object keys, so a fingerprint is stable
 * regardless of payload key order. Array order is preserved (order is meaningful).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort((a, b) => a.localeCompare(b)))
      out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

/**
 * Content fingerprint of a signal. Basis = {kind, tier, summary, payload}. It EXCLUDES
 * occurredAt/mtime (a content-free touch must not register as a change) and INCLUDES tier
 * (a governance re-tag is a real change). Granularity is source-controlled: whatever a source
 * puts in `payload` defines "content" for that artifact.
 */
export function fingerprint(sig: Signal): string {
  const basis = canonicalJson({
    kind: sig.kind,
    tier: sig.tier,
    summary: sig.summary,
    payload: sig.payload ?? null,
  });
  return createHash("sha256").update(basis).digest("hex");
}

/**
 * Pure: classify each current signal against the prior snapshot and produce the next snapshot
 * to persist. First run (prior === null, or a scope mismatch) → every artifact is "added".
 * Removed artifacts (in prior, absent now) drop out of `next` and are not surfaced (v1).
 * Deterministic; no I/O.
 */
export function diffSignals(opts: {
  prior: SnapshotStore | null;
  signals: Signal[];
  now: Date;
  scope: string;
}): { changes: Map<string, SignalChange>; next: SnapshotStore } {
  const nowIso = opts.now.toISOString();
  // A snapshot from a different scope is not a valid baseline — re-baseline rather than
  // compare across cadences.
  const prior = opts.prior && opts.prior.scope === opts.scope ? opts.prior : null;
  const changes = new Map<string, SignalChange>();
  const artifacts: Record<string, SnapshotEntry> = {};

  for (const sig of opts.signals) {
    const key = artifactKey(sig);
    const fp = fingerprint(sig);
    const priorEntry = prior?.artifacts[key];

    let changeType: ChangeType;
    let firstSeenAt: string;
    let lastChangedAt: string;
    if (!priorEntry) {
      changeType = "added";
      firstSeenAt = nowIso;
      lastChangedAt = nowIso;
    } else if (priorEntry.fingerprint !== fp) {
      changeType = "modified";
      firstSeenAt = priorEntry.firstSeenAt;
      lastChangedAt = nowIso;
    } else {
      changeType = "unchanged";
      firstSeenAt = priorEntry.firstSeenAt;
      lastChangedAt = priorEntry.lastChangedAt;
    }

    // Last writer wins if two signals share a key (shouldn't happen within one kind); the
    // change record mirrors the recorded entry.
    artifacts[key] = { fingerprint: fp, firstSeenAt, lastChangedAt };
    changes.set(key, { key, changeType, firstSeenAt, lastChangedAt });
  }

  const next: SnapshotStore = {
    version: SNAPSHOT_VERSION,
    scope: opts.scope,
    updatedAt: nowIso,
    artifacts,
  };
  return { changes, next };
}

/** Workspace-relative path of a scope's snapshot, under the never-synced .aios/loop/ boundary. */
export function snapshotRel(scope: string): string {
  return path.join(".aios", "loop", "state", `changes-${scope}.json`);
}

/**
 * Read a scope's snapshot, or `null` when absent / unreadable / incompatible. Fail-closed like
 * `readContinuityActions`: corrupt JSON, a wrong version, a scope mismatch, or a malformed entry
 * all re-baseline (return null) rather than throw.
 */
export function readSnapshot(root: string, scope: string): SnapshotStore | null {
  const abs = path.join(root, snapshotRel(scope));
  if (!existsSync(abs)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== SNAPSHOT_VERSION) return null;
  if (parsed.scope !== scope) return null;
  if (typeof parsed.updatedAt !== "string") return null;
  if (!isRecord(parsed.artifacts)) return null;
  for (const entry of Object.values(parsed.artifacts)) {
    if (
      !isRecord(entry) ||
      typeof entry.fingerprint !== "string" ||
      typeof entry.firstSeenAt !== "string" ||
      typeof entry.lastChangedAt !== "string"
    ) {
      return null;
    }
  }
  return parsed as unknown as SnapshotStore;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Persist a snapshot under .aios/loop/state/ (mkdir -p). The only write the daily loop makes. */
export function writeSnapshot(root: string, next: SnapshotStore): void {
  const abs = path.join(root, snapshotRel(next.scope));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(next, null, 2));
}
