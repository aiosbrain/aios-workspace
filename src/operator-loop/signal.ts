// The canonical signal contract for the Verified Operator Loop (C1).
// Every workflow domain emits typed, tier-tagged signals shaped like this into the
// collector manifest; the C2 evidence ledger relies on `ref`, and C3 enforces `tier`.
// See docs/ENGINEERING-CONSTITUTION.md §4 and docs/v1-operator-loop/c1-collector.md.

import { normalizeTier } from "./parsers.js";

export type Tier = "admin" | "team" | "external";
export type Cadence = "daily" | "weekly";

/** A pointer back to the source a signal/claim came from — the C2 trust anchor. */
export interface EvidenceRef {
  path: string; // workspace-relative path
  row?: string; // row key within a table (decisions/tasks/hours), when applicable
  tier: Tier;
}

export interface Signal {
  /** Known kinds plus forward-compat: consumers MUST ignore kinds they don't recognize. */
  kind:
    "decision" | "task" | "hours" | "deliverable" | "inbox" | "carryover" | "time" | (string & {});
  source: string; // 'decision-log' | 'tasks' | 'hours-log' | 'deliverable' | 'inbox'
  tier: Tier; // mandatory; missing/unresolvable signals are excluded upstream, never emitted
  occurredAt: string; // ISO date/time: the row's date, or the file mtime
  ref: EvidenceRef;
  summary: string;
  payload?: Record<string, unknown>;
}

const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);

/**
 * Resolve a raw `access:`/audience value to a canonical Tier, or `null` when it cannot
 * be resolved. Reuses the single-sourced `normalizeTier` (private→admin, client/company→
 * external) and then validates membership — an unknown value is unresolvable (default-deny),
 * NOT silently passed through. admin IS a valid resolved tier (retained by the collector).
 */
export function resolveTier(raw: string | string[] | null | undefined): Tier | null {
  if (raw == null) return null;
  // A multi-valued access/audience is malformed — default-deny rather than silently taking the
  // first element (e.g. ["team","admin"] must NOT resolve to "team" and up-scope private content).
  let scalar: string | undefined;
  if (Array.isArray(raw)) {
    if (raw.length !== 1) return null;
    scalar = raw[0];
  } else {
    scalar = raw;
  }
  const v = (scalar ?? "").toString().trim().toLowerCase();
  if (!v) return null;
  const n = normalizeTier(v);
  return TIERS.has(n) ? (n as Tier) : null;
}

/**
 * Resolve an occurrence timestamp to a valid ISO string. A blank or unparseable row date
 * falls back to `fallbackIso` (the file mtime) so the collector's window filter is never fed
 * a `NaN` — an undateable signal must not silently bypass the window. Always returns valid ISO.
 */
export function toOccurredAt(raw: string | null | undefined, fallbackIso: string): string {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallbackIso;
}
