// Unified inbox — cold-start entity seeding (I-08 / AIO-389, review-only stretch).
//
// A fresh operator's ranker has no entity files and no engagement registry, so the protected
// partition (ranker.ts) starts empty and the trust floor has nothing to stand on. This module mines
// the enriched observation history (I-06) and produces **suggestions** — a review-only,
// confidence-scored list of people / relationship tiers / project links the operator merges or
// rejects one at a time. It NEVER writes live config on its own:
//
//   • `generateSuggestions` is a pure, deterministic function over a normalized history. It only
//     READS (the existing registry, to skip already-known people) and never writes a registry or
//     entity file. Every returned suggestion has `status: "proposed"`.
//   • The ONLY writer of a registry/entity file is `merge`, and `merge` performs the
//     `proposed → merged` status transition as it writes. `reject` writes no registry/entity file.
//   • `merge` is REVERSIBLE: it captures the prior file bytes and records them as the inverse
//     operation in the seed journal; `unmerge` restores those exact bytes (or removes a file that
//     did not exist before), so a merge→unmerge round-trip is byte-identical.
//
// Tier: everything here is ADMIN-TIER LOCAL state under `.aios/loop/inbox/` — the registry, the
// per-person entity files, the seed journal, and every evidence summary. It is NEVER added to
// `sync_include`; comms plaintext never leaves the machine. Evidence summaries are CONTENT-FREE:
// counts / channels / recency only, never a message body. Promotion of a seeded entity to `team`
// tier is a separate, deliberate `access:`-retagging act under the normal access-control flow — it
// never happens through this module.
//
// No cross-domain value imports: this file lives in the `inbox` domain and imports only its own
// siblings (journal lock discipline + enriched observations + the registry shape from the ranker).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { INBOX_DIR_REL, withInboxLock } from "./journal.js";
import type { EnrichedObservation } from "./observations.js";
import type { RegistryPerson } from "./ranker.js";

// ── paths + constants ────────────────────────────────────────────────────────────────────────────

/** Admin-tier local registry the ranker reads (engagement registry). NEVER synced. */
export const SEED_REGISTRY_BASENAME = "registry.json";
/** Per-person entity files land here, one JSON file per merged counterparty. NEVER synced. */
export const SEED_ENTITIES_DIR = "entities";
/** Append-only reversible seed journal (merge/reject/unmerge with the inverse operation). */
export const SEED_JOURNAL_BASENAME = "seed-events.ndjson";
export const SEED_JOURNAL_VERSION = 1;

/** Candidates below this many observations are noise and are not proposed (min support). */
export const MIN_SUPPORT_EVENTS = 2;

// Confidence weights (sum to 1). A stated formula, not a vibe — see `scoreCandidate`.
export const CONFIDENCE_WEIGHTS = Object.freeze({
  frequency: 0.35,
  threadBreadth: 0.25,
  recency: 0.25,
  initiation: 0.15,
});
/** Saturation points: frequency saturates at 8 observations, breadth at 4 distinct threads. */
export const FREQUENCY_SATURATION = 8;
export const THREAD_BREADTH_SATURATION = 4;
/** Recency decay constant (days). recencyScore = exp(-ageDays / TAU). */
export const RECENCY_TAU_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── types ────────────────────────────────────────────────────────────────────────────────────────

export type SeedKind = "person" | "relationship-tier" | "project-link";
export type SeedStatus = "proposed" | "merged" | "rejected";

/**
 * A normalized, source-agnostic history event. Both the enriched observation log and the I-04
 * labeled corpus map into this shape (see `observationsToHistory`), so the generator stays a pure
 * function of a stable input regardless of the mining source.
 */
export interface SeedHistoryEvent {
  /** Stable counterparty identity used for clustering (usually an email or account handle). */
  personId: string;
  /** All identities seen for this counterparty (account ids, emails, handles, display names). */
  identities?: string[];
  /** Human display name when known (kept for the entity file; never used as a match key alone). */
  display?: string | null;
  /** The thread / conversation this event belongs to (for thread-breadth). */
  threadId?: string | null;
  /** ISO timestamp of the event (for recency; reference time = the max ts in the history). */
  ts: string;
  /** True iff the operator initiated this event (for the two-way initiation-balance signal). */
  initiatedByOwner?: boolean;
  /** Channel/source (gmail, whatsapp, …) — content-free provenance only. */
  channel?: string | null;
  /** Optional project hint carried by the source; drives a `project-link` suggestion. */
  project?: string | null;
}

/** The confidence breakdown, surfaced so the CLI/tests can show WHY a score is what it is. */
export interface ConfidenceBreakdown {
  frequency: number;
  threadBreadth: number;
  recency: number;
  initiation: number;
}

export interface SeedSuggestion {
  id: string;
  kind: SeedKind;
  /** Content-free evidence: counts / channels / recency only. NEVER a message body. */
  evidence_summary: string;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  /** The registry/entity entry a merge would write — a `RegistryPerson`-shaped patch (+ project). */
  proposed_entry: SeedProposedEntry;
  status: SeedStatus;
}

/** A `RegistryPerson` patch, plus an optional project name for a `project-link` suggestion. */
export interface SeedProposedEntry extends RegistryPerson {
  display?: string | null;
  project?: string | null;
}

export interface SeedJournalEvent {
  v: number;
  op: "merge" | "reject" | "unmerge";
  id: string;
  at: string;
  suggestion_id: string;
  kind: SeedKind;
  /** For `unmerge`, the merge event id it reverses. */
  reverses?: string | null;
  /** The inverse operation: exact prior file bytes to restore (null = the file did not exist). */
  inverse?: {
    registry: string | null;
    entity: { path_rel: string; bytes: string | null } | null;
  };
}

export class SeedValidationError extends Error {
  constructor(message: string) {
    super(`inbox seed: ${message}`);
    this.name = "SeedValidationError";
  }
}

// ── path helpers ─────────────────────────────────────────────────────────────────────────────────

function inboxDir(root: string): string {
  return path.join(root, INBOX_DIR_REL);
}
export function registryPath(root: string): string {
  return path.join(inboxDir(root), SEED_REGISTRY_BASENAME);
}
export function seedJournalPath(root: string): string {
  return path.join(inboxDir(root), SEED_JOURNAL_BASENAME);
}
export function entitiesDir(root: string): string {
  return path.join(inboxDir(root), SEED_ENTITIES_DIR);
}
/** Filesystem-safe slug for an identity, used as the entity file basename. */
export function entitySlug(id: string): string {
  const cleaned = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = cleaned || "entity";
  // Disambiguate slugs that collapse to the same cleaned form (e.g. two different emails).
  const h = createHash("sha256").update(id.trim().toLowerCase()).digest("hex").slice(0, 8);
  return `${base}-${h}`;
}
function entityPathRel(id: string): string {
  return path.posix.join(
    INBOX_DIR_REL.split(path.sep).join("/"),
    SEED_ENTITIES_DIR,
    `${entitySlug(id)}.json`
  );
}

function normKey(v: string): string {
  return v.trim().toLowerCase();
}
function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ── history adapters ──────────────────────────────────────────────────────────────────────────────

/**
 * Map enriched observations into the normalized history. `ownerId`/`ownerIds` identify the operator
 * so the counterparty (the OTHER participant) is mined, and `initiatedByOwner` is set when the owner
 * is the `from`/`organizer` of the object. An observation with no non-owner participant is skipped.
 */
export function observationsToHistory(
  observations: readonly EnrichedObservation[],
  opts: { ownerIds?: readonly string[] } = {}
): SeedHistoryEvent[] {
  const ownerSet = new Set((opts.ownerIds ?? []).map(normKey));
  const out: SeedHistoryEvent[] = [];
  for (const o of observations) {
    const parts = Array.isArray(o.participants) ? o.participants : [];
    const counterpart = parts.find(
      (p) => p && typeof p.id === "string" && !ownerSet.has(normKey(p.id))
    );
    if (!counterpart) continue;
    const fromParticipant = parts.find((p) => p && (p.role === "from" || p.role === "organizer"));
    const initiatedByOwner =
      !!fromParticipant &&
      typeof fromParticipant.id === "string" &&
      ownerSet.has(normKey(fromParticipant.id));
    const identities = [counterpart.id];
    if (typeof counterpart.display === "string" && counterpart.display.trim())
      identities.push(counterpart.display);
    const projectRaw = (o.metadata as { project?: unknown } | undefined)?.project;
    out.push({
      personId: counterpart.id,
      identities,
      display: typeof counterpart.display === "string" ? counterpart.display : null,
      threadId: o.thread_id ?? o.native_id,
      ts: o.ts,
      initiatedByOwner,
      channel: o.object_kind,
      project: typeof projectRaw === "string" && projectRaw.trim() ? projectRaw : null,
    });
  }
  return out;
}

// ── candidate aggregation ────────────────────────────────────────────────────────────────────────

interface Candidate {
  personId: string;
  identities: string[];
  display: string | null;
  count: number;
  threads: Set<string>;
  ownerInitiated: number;
  latestMs: number;
  channels: Set<string>;
  projects: Map<string, number>;
}

function aggregate(history: readonly SeedHistoryEvent[]): Map<string, Candidate> {
  const byPerson = new Map<string, Candidate>();
  for (const ev of history) {
    if (!ev || typeof ev.personId !== "string" || !ev.personId.trim()) continue;
    const key = normKey(ev.personId);
    let cand = byPerson.get(key);
    if (!cand) {
      cand = {
        personId: ev.personId.trim(),
        identities: [],
        display: null,
        count: 0,
        threads: new Set(),
        ownerInitiated: 0,
        latestMs: -Infinity,
        channels: new Set(),
        projects: new Map(),
      };
      byPerson.set(key, cand);
    }
    cand.count += 1;
    for (const id of ev.identities ?? [ev.personId])
      if (
        typeof id === "string" &&
        id.trim() &&
        !cand.identities.some((x) => normKey(x) === normKey(id))
      )
        cand.identities.push(id.trim());
    if (!cand.identities.some((x) => normKey(x) === normKey(cand.personId)))
      cand.identities.unshift(cand.personId);
    if (!cand.display && typeof ev.display === "string" && ev.display.trim())
      cand.display = ev.display.trim();
    if (ev.threadId) cand.threads.add(String(ev.threadId));
    if (ev.initiatedByOwner) cand.ownerInitiated += 1;
    const ms = Date.parse(ev.ts);
    if (Number.isFinite(ms) && ms > cand.latestMs) cand.latestMs = ms;
    if (ev.channel) cand.channels.add(String(ev.channel));
    if (ev.project) cand.projects.set(ev.project, (cand.projects.get(ev.project) ?? 0) + 1);
  }
  return byPerson;
}

/**
 * The stated confidence formula. Each sub-score is in [0,1] and monotonic in its signal:
 *   frequency    = min(1, count / FREQUENCY_SATURATION)
 *   threadBreadth= min(1, distinctThreads / THREAD_BREADTH_SATURATION)
 *   recency      = exp(-ageDays / RECENCY_TAU_DAYS)   (ageDays measured from `referenceMs`)
 *   initiation   = 1 - |2·ownerInitiatedFraction - 1| (a two-way relationship peaks; one-way decays)
 * confidence = Σ weightᵢ · scoreᵢ, so a higher-signal counterparty always scores ≥ a lower-signal one.
 */
function scoreCandidate(cand: Candidate, referenceMs: number): ConfidenceBreakdown {
  const frequency = clamp01(cand.count / FREQUENCY_SATURATION);
  const threadBreadth = clamp01(cand.threads.size / THREAD_BREADTH_SATURATION);
  const ageDays =
    Number.isFinite(cand.latestMs) && cand.latestMs > -Infinity
      ? Math.max(0, (referenceMs - cand.latestMs) / MS_PER_DAY)
      : Infinity;
  const recency = clamp01(Number.isFinite(ageDays) ? Math.exp(-ageDays / RECENCY_TAU_DAYS) : 0);
  const ownerFrac = cand.count > 0 ? cand.ownerInitiated / cand.count : 0;
  const initiation = clamp01(1 - Math.abs(2 * ownerFrac - 1));
  return {
    frequency: round(frequency),
    threadBreadth: round(threadBreadth),
    recency: round(recency),
    initiation: round(initiation),
  };
}

function confidenceOf(b: ConfidenceBreakdown): number {
  return round(
    CONFIDENCE_WEIGHTS.frequency * b.frequency +
      CONFIDENCE_WEIGHTS.threadBreadth * b.threadBreadth +
      CONFIDENCE_WEIGHTS.recency * b.recency +
      CONFIDENCE_WEIGHTS.initiation * b.initiation,
    4
  );
}

/** Confidence band → relationship tier (1 = closest). A stated, deterministic mapping. */
export function tierForConfidence(confidence: number): 1 | 2 | 3 | 4 {
  if (confidence >= 0.75) return 1;
  if (confidence >= 0.5) return 2;
  if (confidence >= 0.25) return 3;
  return 4;
}

function suggestionId(personKey: string, kind: SeedKind): string {
  return (
    "seed_" +
    createHash("sha256").update(personKey).update("|").update(kind).digest("hex").slice(0, 12)
  );
}

// ── registry read (cold-start skip) ────────────────────────────────────────────────────────────────

/** All normalized identities already present in the runtime registry (skip these — cold-start only). */
export function knownIdentities(root: string): Set<string> {
  const known = new Set<string>();
  const p = registryPath(root);
  if (!existsSync(p)) return known;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { people?: Array<{ ids?: unknown }> };
    for (const person of raw.people ?? [])
      for (const id of Array.isArray(person.ids) ? person.ids : [])
        if (typeof id === "string" && id.trim()) known.add(normKey(id));
  } catch {
    /* malformed registry → treat as empty (fail-open cold-start) */
  }
  return known;
}

// ── generation (pure, deterministic, read-only) ────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Override the recency reference time. Default: the max ts in the history (keeps runs deterministic). */
  referenceMs?: number;
}

/**
 * Mine `history` into confidence-scored suggestions. PURE + DETERMINISTIC: no wall-clock, no random,
 * no writes. Reads only the existing registry (to skip already-known people). Every returned
 * suggestion has `status: "proposed"` — a merge is a separate, explicit act (`merge`).
 */
export function generateSuggestions(
  root: string,
  history: readonly SeedHistoryEvent[],
  opts: GenerateOptions = {}
): SeedSuggestion[] {
  const candidates = aggregate(history);
  const known = knownIdentities(root);
  const referenceMs =
    opts.referenceMs ??
    history.reduce((mx, e) => {
      const ms = Date.parse(e.ts);
      return Number.isFinite(ms) && ms > mx ? ms : mx;
    }, -Infinity);

  const suggestions: SeedSuggestion[] = [];
  for (const cand of candidates.values()) {
    if (cand.count < MIN_SUPPORT_EVENTS) continue; // below min support → noise, not proposed
    if (cand.identities.some((id) => known.has(normKey(id)))) continue; // already seeded → skip
    const breakdown = scoreCandidate(cand, referenceMs);
    const confidence = confidenceOf(breakdown);
    const key = normKey(cand.personId);
    const channels = [...cand.channels].sort().join("/") || "unknown";
    const lastIso =
      Number.isFinite(cand.latestMs) && cand.latestMs > -Infinity
        ? new Date(cand.latestMs).toISOString().slice(0, 10)
        : "unknown";
    const ownerFrac = cand.count > 0 ? cand.ownerInitiated / cand.count : 0;
    const direction =
      ownerFrac >= 0.35 && ownerFrac <= 0.65
        ? "two-way"
        : ownerFrac > 0.65
          ? "outbound-heavy"
          : "inbound-heavy";

    // person — the identity/entity itself.
    suggestions.push({
      id: suggestionId(key, "person"),
      kind: "person",
      evidence_summary: `${cand.count} obs across ${cand.threads.size} thread(s) via ${channels}; last ${lastIso}; ${direction}`,
      confidence,
      breakdown,
      proposed_entry: {
        ids: cand.identities,
        engagement: "active",
        entityFile: true,
        display: cand.display,
      },
      status: "proposed",
    });

    // relationship-tier — a distinct, separately-reviewable decision (the banded tier).
    const tier = tierForConfidence(confidence);
    suggestions.push({
      id: suggestionId(key, "relationship-tier"),
      kind: "relationship-tier",
      evidence_summary: `tier ${tier} from confidence ${confidence.toFixed(2)} (${cand.count} obs, ${cand.threads.size} thread(s))`,
      confidence,
      breakdown,
      proposed_entry: { ids: cand.identities, tier, display: cand.display },
      status: "proposed",
    });

    // project-link — only when the history carries a project hint for this person.
    if (cand.projects.size > 0) {
      const [topProject, hits] = [...cand.projects.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0]!;
      const projectWeight = clamp01(hits / cand.count);
      suggestions.push({
        id: suggestionId(key, "project-link"),
        kind: "project-link",
        evidence_summary: `linked to "${topProject}" via ${hits}/${cand.count} obs`,
        confidence,
        breakdown,
        proposed_entry: {
          ids: cand.identities,
          projectWeight: round(projectWeight),
          project: topProject,
          display: cand.display,
        },
        status: "proposed",
      });
    }
  }

  // Deterministic order: confidence desc, then id asc (stable, independent of input order).
  suggestions.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  return suggestions;
}

// ── seed journal (read + status overlay) ─────────────────────────────────────────────────────────

/** Read the seed journal; malformed lines are skipped (never crash). */
export function readSeedJournal(root: string): SeedJournalEvent[] {
  const p = seedJournalPath(root);
  if (!existsSync(p)) return [];
  const out: SeedJournalEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SeedJournalEvent;
      if (ev && typeof ev.op === "string" && typeof ev.suggestion_id === "string") out.push(ev);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * The current status of each suggestion id, folded from the seed journal: the last merge/reject/
 * unmerge wins. A merge followed by an unmerge is back to `proposed`.
 */
export function foldSeedStatus(events: readonly SeedJournalEvent[]): Map<string, SeedStatus> {
  const status = new Map<string, SeedStatus>();
  for (const ev of events) {
    if (ev.op === "merge") status.set(ev.suggestion_id, "merged");
    else if (ev.op === "reject") status.set(ev.suggestion_id, "rejected");
    else if (ev.op === "unmerge") status.set(ev.suggestion_id, "proposed");
  }
  return status;
}

/** Generate suggestions, then overlay durable merged/rejected status from the seed journal. */
export function readSuggestions(
  root: string,
  history: readonly SeedHistoryEvent[],
  opts: GenerateOptions = {}
): SeedSuggestion[] {
  const suggestions = generateSuggestions(root, history, opts);
  const status = foldSeedStatus(readSeedJournal(root));
  for (const s of suggestions) {
    const st = status.get(s.id);
    if (st) s.status = st;
  }
  return suggestions;
}

// ── merge / reject / unmerge (the ONLY registry/entity writers) ──────────────────────────────────

function readBytesOrNull(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}
function writeAtomic(abs: string, bytes: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + `.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, abs);
}
function removeIfExists(abs: string): void {
  try {
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    /* best-effort */
  }
}
function appendSeedEvent(root: string, ev: SeedJournalEvent): void {
  const p = seedJournalPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ev) + "\n", { flag: "a" });
}

/** Apply a proposed entry onto the parsed registry object (in place), matching by any shared id. */
function applyEntryToRegistry(
  registry: { people: RegistryPerson[] },
  entry: SeedProposedEntry
): void {
  const ids = (entry.ids ?? []).filter((x) => typeof x === "string" && x.trim());
  const idKeys = new Set(ids.map(normKey));
  let person = registry.people.find((p) => (p.ids ?? []).some((id) => idKeys.has(normKey(id))));
  if (!person) {
    person = { ids: [...ids] };
    registry.people.push(person);
  } else {
    for (const id of ids)
      if (!person.ids.some((x) => normKey(x) === normKey(id))) person.ids.push(id);
  }
  if (typeof entry.tier === "number") person.tier = entry.tier;
  if (typeof entry.projectWeight === "number") person.projectWeight = entry.projectWeight;
  if (entry.entityFile === true) person.entityFile = true;
  if (typeof entry.engagement === "string") person.engagement = entry.engagement;
}

function serializeRegistry(registry: { people: RegistryPerson[] }): string {
  return JSON.stringify(registry, null, 2) + "\n";
}

export interface MergeResult {
  status: "merged";
  eventId: string;
  registryPath: string;
  entityPath: string | null;
}

/**
 * Merge one suggestion — the SOLE writer of the registry/entity files. Captures the prior file bytes
 * as the inverse operation, writes the registry patch (and, for a `person` suggestion with
 * `entityFile: true`, a per-person entity file), records a `merge` seed-journal event, and returns
 * the merged status. Throws unless the suggestion is `proposed` (no double-merge, no merging a
 * rejected one). All work happens under the inbox lock.
 */
export function merge(root: string, suggestion: SeedSuggestion): MergeResult {
  if (!suggestion || typeof suggestion.id !== "string")
    throw new SeedValidationError("not a suggestion");
  if (suggestion.status !== "proposed")
    throw new SeedValidationError(
      `can only merge a proposed suggestion (got "${suggestion.status}")`
    );
  return withInboxLock(root, () => {
    const regAbs = registryPath(root);
    const registryPrior = readBytesOrNull(regAbs);
    const registry: { people: RegistryPerson[] } = registryPrior
      ? (() => {
          try {
            const parsed = JSON.parse(registryPrior) as { people?: RegistryPerson[] };
            return { people: Array.isArray(parsed.people) ? parsed.people : [] };
          } catch {
            return { people: [] };
          }
        })()
      : { people: [] };

    applyEntryToRegistry(registry, suggestion.proposed_entry);

    // Entity file only for a `person` suggestion asking for one.
    let entityAbs: string | null = null;
    let entityRel: string | null = null;
    let entityPrior: string | null = null;
    if (suggestion.kind === "person" && suggestion.proposed_entry.entityFile === true) {
      const primary = (suggestion.proposed_entry.ids ?? [])[0] ?? suggestion.id;
      entityRel = entityPathRel(primary);
      entityAbs = path.join(root, entityRel);
      entityPrior = readBytesOrNull(entityAbs);
      const entityDoc = {
        kind: "person",
        ids: suggestion.proposed_entry.ids ?? [],
        display: suggestion.proposed_entry.display ?? null,
        engagement: suggestion.proposed_entry.engagement ?? null,
        evidence_summary: suggestion.evidence_summary,
        seeded_from: suggestion.id,
        seeded_at: new Date().toISOString(),
      };
      writeAtomic(entityAbs, JSON.stringify(entityDoc, null, 2) + "\n");
    }

    writeAtomic(regAbs, serializeRegistry(registry));

    const eventId =
      "sm_" +
      createHash("sha256")
        .update(suggestion.id)
        .update("|merge|")
        .update(String(registryPrior ?? ""))
        .digest("hex")
        .slice(0, 12);
    appendSeedEvent(root, {
      v: SEED_JOURNAL_VERSION,
      op: "merge",
      id: eventId,
      at: new Date().toISOString(),
      suggestion_id: suggestion.id,
      kind: suggestion.kind,
      inverse: {
        registry: registryPrior,
        entity: entityRel ? { path_rel: entityRel, bytes: entityPrior } : null,
      },
    });
    suggestion.status = "merged";
    return { status: "merged", eventId, registryPath: regAbs, entityPath: entityAbs };
  });
}

export interface RejectResult {
  status: "rejected";
  eventId: string;
}

/** Reject one suggestion. Writes NO registry/entity file — only a `reject` seed-journal event. */
export function reject(root: string, suggestion: SeedSuggestion): RejectResult {
  if (!suggestion || typeof suggestion.id !== "string")
    throw new SeedValidationError("not a suggestion");
  if (suggestion.status !== "proposed")
    throw new SeedValidationError(
      `can only reject a proposed suggestion (got "${suggestion.status}")`
    );
  return withInboxLock(root, () => {
    const eventId =
      "sr_" +
      createHash("sha256").update(suggestion.id).update("|reject").digest("hex").slice(0, 12);
    appendSeedEvent(root, {
      v: SEED_JOURNAL_VERSION,
      op: "reject",
      id: eventId,
      at: new Date().toISOString(),
      suggestion_id: suggestion.id,
      kind: suggestion.kind,
    });
    suggestion.status = "rejected";
    return { status: "rejected", eventId };
  });
}

export interface UnmergeResult {
  status: "unmerged";
  reversed: string;
}

/**
 * Reverse the most recent, not-yet-reversed merge of `suggestionId`, restoring the registry and
 * entity file to their EXACT prior bytes (or removing a file that did not exist before). The
 * restore is byte-identical — a merge→unmerge round-trip leaves the files as they were.
 */
export function unmerge(root: string, suggestionId: string): UnmergeResult {
  return withInboxLock(root, () => {
    const events = readSeedJournal(root);
    const reversed = new Set<string>();
    for (const ev of events) if (ev.op === "unmerge" && ev.reverses) reversed.add(ev.reverses);
    let target: SeedJournalEvent | null = null;
    for (const ev of events)
      if (ev.op === "merge" && ev.suggestion_id === suggestionId && !reversed.has(ev.id))
        target = ev;
    if (!target) throw new SeedValidationError(`no un-reversed merge found for "${suggestionId}"`);

    const inv = target.inverse;
    const regAbs = registryPath(root);
    if (inv) {
      if (inv.registry === null) removeIfExists(regAbs);
      else writeAtomic(regAbs, inv.registry);
      if (inv.entity) {
        const entAbs = path.join(root, inv.entity.path_rel);
        if (inv.entity.bytes === null) removeIfExists(entAbs);
        else writeAtomic(entAbs, inv.entity.bytes);
      }
    }
    appendSeedEvent(root, {
      v: SEED_JOURNAL_VERSION,
      op: "unmerge",
      id:
        "su_" +
        createHash("sha256").update(target.id).update("|unmerge").digest("hex").slice(0, 12),
      at: new Date().toISOString(),
      suggestion_id: suggestionId,
      kind: target.kind,
      reverses: target.id,
    });
    return { status: "unmerged", reversed: target.id };
  });
}

// ── evaluation (precision / recall vs a reviewed ground-truth set; reported, not gated) ────────────

export interface SeedEvaluation {
  suggestedPeople: number;
  groundTruthInHistory: number;
  truePositives: number;
  precision: number;
  recall: number;
}

/**
 * Precision/recall of the `person` suggestions against a reviewed ground-truth identity set (the
 * I-04 labeled registry doubles as the evaluation set). A suggested person is a true positive when
 * any of its identities matches a ground-truth identity. Recall is measured only over ground-truth
 * identities that actually appear in `history` (cold-start can't recover a person never seen).
 */
export function evaluateSuggestions(
  suggestions: readonly SeedSuggestion[],
  history: readonly SeedHistoryEvent[],
  groundTruthIdentities: readonly string[]
): SeedEvaluation {
  const gtKeys = new Set(groundTruthIdentities.map(normKey));
  const historyKeys = new Set<string>();
  for (const e of history) {
    for (const id of e.identities ?? [e.personId])
      if (typeof id === "string") historyKeys.add(normKey(id));
  }
  const gtInHistory = [...gtKeys].filter((k) => historyKeys.has(k));

  const people = suggestions.filter((s) => s.kind === "person");
  let tp = 0;
  const matchedGt = new Set<string>();
  for (const s of people) {
    const keys = (s.proposed_entry.ids ?? []).map(normKey);
    const hitKeys = keys.filter((k) => gtKeys.has(k));
    if (hitKeys.length > 0) {
      tp += 1;
      // Credit EVERY ground-truth identity this true-positive suggestion covers (a registry person
      // carries several ids); crediting only the first would deflate recall as a measurement artifact.
      for (const k of hitKeys) matchedGt.add(k);
    }
  }
  const precision = people.length > 0 ? round(tp / people.length, 4) : 0;
  const recall = gtInHistory.length > 0 ? round(matchedGt.size / gtInHistory.length, 4) : 0;
  return {
    suggestedPeople: people.length,
    groundTruthInHistory: gtInHistory.length,
    truePositives: tp,
    precision,
    recall,
  };
}

/** List the merged/rejected/proposed suggestions plus a proposed count — a small CLI convenience. */
export function summarizeStatuses(suggestions: readonly SeedSuggestion[]): {
  proposed: number;
  merged: number;
  rejected: number;
} {
  let proposed = 0;
  let merged = 0;
  let rejected = 0;
  for (const s of suggestions) {
    if (s.status === "merged") merged += 1;
    else if (s.status === "rejected") rejected += 1;
    else proposed += 1;
  }
  return { proposed, merged, rejected };
}

/** All entity files currently on disk (for tooling/tests). Missing dir → []. */
export function listEntityFiles(root: string): string[] {
  const dir = entitiesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort();
}
