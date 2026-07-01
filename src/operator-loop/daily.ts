// C4 — the daily light loop. A fast, read-only, local orientation answering exactly three
// questions: what CHANGED since the last run, what's BLOCKED, and what I OWE today.
//
// `buildDailyOrientation` is a PURE classifier over a manifest + the prior change-snapshot;
// `runDaily` is the thin filesystem wrapper the CLI and the cockpit both call. No verifier,
// no LLM, no sync, no approval gate. The ONLY write is the local change-snapshot (changes.ts,
// under .aios/loop/state/ — never synced). C6 owns all writeback and any mutation of the
// continuity store; C4 only READS it. See docs/v1-operator-loop/c4-daily.md.

import { collect } from "./collector.js";
import { isOpenStatus } from "./continuity.js";
import { visibleTiers, type Audience } from "./ledger.js";
import type { RunManifest } from "./manifest.js";
import type { EvidenceRef, Signal, Tier } from "./signal.js";
import type { Exclusion } from "./sources/types.js";
import {
  artifactKey,
  diffSignals,
  readSnapshot,
  writeSnapshot,
  type ChangeType,
  type SignalChange,
  type SnapshotStore,
} from "./changes.js";
import { runtimeByTag, type TagTotal } from "./time/runtime.js";

/** Snapshot scope for the daily cadence (keeps a baseline independent of the weekly one). */
export const DAILY_SCOPE = "daily";
/** A carried-over action still open after this many days reads as a stale blocker, not owed. */
export const STALE_CARRYOVER_DAYS = 7;
/** Per-section display cap — the daily is "seconds to read". `counts` keep the true totals. */
const SECTION_CAP = 7;

// Word-boundary match (so "unblocked" / "unpaused" do NOT match — the boundary before the
// keyword fails when preceded by "un"). Applied to freeform status/label/title text.
const BLOCKED_RE = /\b(blocked|blocker|waiting|stalled|paused|on[-\s]hold)\b/i;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})/;

export interface DailyItem {
  kind: string;
  summary: string;
  tier: Tier;
  ref: EvidenceRef; // light evidence: path (+ row)
  due?: string | null; // owed/blocked annotation
  stale?: number; // whole days outstanding (Blocked carryovers only)
  changeType?: ChangeType; // "added" | "modified" (Changed items only)
}

export interface DailyOrientation {
  member: string;
  window: { cadence: "daily"; from: string; to: string };
  generatedAt: string;
  audience: Audience;
  changed: DailyItem[]; // capped to SECTION_CAP; counts.changed is the true total
  blocked: DailyItem[];
  owedToday: DailyItem[];
  /** "What agents ran" in the daily window — aggregate { tag, durationMin } only (no repo/id/path),
   *  audience-filtered like every other section. Empty when time capture hasn't run. */
  ranByTag: TagTotal[];
  counts: { changed: number; blocked: number; owedToday: number; excluded: number };
  /** Full list only for the owner; [] for a shareable (--as) view — an unresolved-tier ref
   *  path can itself leak above-tier info, and it has no tier to filter on. */
  excluded: Exclusion[];
}

export interface BuildDailyOptions {
  manifest: RunManifest; // an UNWINDOWED daily-kind manifest = all current state
  prior: SnapshotStore | null;
  audience?: Audience; // default "owner" (all tiers)
  staleDays?: number; // default STALE_CARRYOVER_DAYS
}

/** PURE. "Today" is derived from `manifest.generatedAt` (no external `now` — the manifest is
 *  the contract), so a saved manifest is fully deterministic. */
export function buildDailyOrientation(opts: BuildDailyOptions): {
  orientation: DailyOrientation;
  nextSnapshot: SnapshotStore;
} {
  const audience: Audience = opts.audience ?? "owner";
  const staleDays = opts.staleDays ?? STALE_CARRYOVER_DAYS;
  const generatedAt = opts.manifest.generatedAt;
  const now = new Date(generatedAt);
  const todayDay = dayOf(generatedAt) ?? generatedAt.slice(0, 10);
  const win = opts.manifest.window;
  const hasPrior =
    opts.prior != null &&
    opts.prior.scope === DAILY_SCOPE &&
    Object.keys(opts.prior.artifacts).length > 0;

  // 1) Baseline diff over the FULL owner-complete signal set — never the --as projection — so
  //    the recorded snapshot is a correct owner baseline regardless of the requested audience.
  const { changes, next } = diffSignals({
    prior: opts.prior,
    signals: opts.manifest.signals,
    now,
    scope: DAILY_SCOPE,
  });

  // 2) Audience filter for DISPLAY only (owner is a natural no-op).
  const visible = visibleTiers(audience);
  const signals = opts.manifest.signals.filter((s) => visible.has(s.tier));

  const changedE: Array<{ item: DailyItem; changeAt: string }> = [];
  const blockedE: Array<{ item: DailyItem; stale: number }> = [];
  const owedE: Array<{ item: DailyItem; dueDay: string }> = [];

  for (const sig of signals) {
    const p = sig.payload ?? {};
    const change = changes.get(artifactKey(sig));
    const changeType = placementChange(change, sig, hasPrior, win.from, win.to);
    const isChanged = changeType === "added" || changeType === "modified";

    // 3) One section per signal, precedence Blocked > Owed > Changed.
    if (sig.kind === "carryover") {
      const stale = staleDaysOf(p.createdAt, generatedAt, staleDays);
      if (stale != null || looksBlocked(sig.summary, p.status, p.title)) {
        blockedE.push({
          item: baseItem(sig, { due: strOrNull(p.due), stale: stale ?? undefined }),
          stale: stale ?? 0,
        });
      } else {
        owedE.push({
          item: baseItem(sig, { due: strOrNull(p.due) }),
          dueDay: dayOf(strOrNull(p.due)) ?? END_OF_TIME,
        });
      }
      continue;
    }

    if (sig.kind === "task") {
      if (!isOpenStatus(strOrUndef(p.status))) continue; // closed → omit
      const labels = Array.isArray(p.labels) ? p.labels : [];
      if (looksBlocked(sig.summary, p.status, ...labels)) {
        blockedE.push({ item: baseItem(sig, { due: strOrNull(p.due) }), stale: 0 });
      } else if (isDueByToday(p.due, todayDay)) {
        owedE.push({
          item: baseItem(sig, { due: strOrNull(p.due) }),
          dueDay: dayOf(strOrNull(p.due)) ?? END_OF_TIME,
        });
      } else if (isChanged) {
        changedE.push({
          item: baseItem(sig, { changeType }),
          changeAt: changeAtOf(change, generatedAt),
        });
      }
      continue;
    }

    if (sig.kind === "deliverable") {
      if (looksBlocked(sig.summary, p.status)) {
        blockedE.push({ item: baseItem(sig, {}), stale: 0 });
      } else if (isChanged) {
        changedE.push({
          item: baseItem(sig, { changeType }),
          changeAt: changeAtOf(change, generatedAt),
        });
      }
      continue;
    }

    if (sig.kind === "decision") {
      if (isChanged) {
        changedE.push({
          item: baseItem(sig, { changeType }),
          changeAt: changeAtOf(change, generatedAt),
        });
      }
      continue;
    }

    if (sig.kind === "comms") {
      // "What's blocked / waiting on someone" — a comms item is a blocker when it names who
      // it's waiting on, or reads as blocked/waiting in its summary. Non-waiting activity is
      // not a daily blocker (it's just chatter) → ignored. (AIO-140 acceptance.)
      const waitingOn = strOrNull(p.waitingOn);
      if (waitingOn || looksBlocked(sig.summary)) {
        blockedE.push({ item: baseItem(sig, { due: strOrNull(p.dueAt) }), stale: 0 });
      }
      continue;
    }
    // Any other / unknown kind → ignore (forward-compat: consumers ignore kinds they don't know).
  }

  const changedS = finish(changedE, byChanged);
  const blockedS = finish(blockedE, byBlocked);
  const owedS = finish(owedE, byOwed);

  // Time (agent runtime): "what agents ran" in the daily window. Explicit kind:"time" handling —
  // the main loop above ignores it (no changed/blocked/owed semantics). Aggregate { tag,
  // durationMin } ONLY, from the already-audience-filtered signals; no repo/id/path is surfaced.
  const winFromMs = Date.parse(win.from);
  const winToMs = Date.parse(win.to);
  const ranByTag = runtimeByTag(
    signals
      .filter((s) => s.kind === "time")
      .filter((s) => {
        const t = Date.parse(s.occurredAt);
        return Number.isFinite(t) && t >= winFromMs && t <= winToMs;
      })
      .map((s) => ({
        tag: typeof s.payload?.tag === "string" ? s.payload.tag : "engineering",
        durationMin: typeof s.payload?.durationMin === "number" ? s.payload.durationMin : 0,
      }))
  );

  const orientation: DailyOrientation = {
    member: opts.manifest.member,
    window: { cadence: "daily", from: win.from, to: win.to },
    generatedAt,
    audience,
    changed: changedS.items,
    blocked: blockedS.items,
    owedToday: owedS.items,
    ranByTag,
    counts: {
      changed: changedS.total,
      blocked: blockedS.total,
      owedToday: owedS.total,
      excluded: opts.manifest.excluded.length,
    },
    excluded: audience === "owner" ? opts.manifest.excluded : [],
  };
  return { orientation, nextSnapshot: next };
}

export interface RunDailyOptions {
  root: string;
  now?: Date;
  member?: string;
  audience?: Audience; // default "owner"
  staleDays?: number;
  record?: boolean; // default true; only the owner view ever records (see below)
}

/** Filesystem wrapper: read prior snapshot → collect the full current state → classify →
 *  (owner only) persist the advanced baseline. Returns the orientation for CLI/cockpit render. */
export function runDaily(opts: RunDailyOptions): DailyOrientation {
  const audience: Audience = opts.audience ?? "owner";
  const prior = readSnapshot(opts.root, DAILY_SCOPE);
  const manifest = collect({
    root: opts.root,
    cadence: "daily",
    member: opts.member,
    now: opts.now,
    window: false, // change detection + complete owed/blocked over ALL current signals
  });
  const { orientation, nextSnapshot } = buildDailyOrientation({
    manifest,
    prior,
    audience,
    staleDays: opts.staleDays,
  });
  // The one local write: advance the owner baseline. NEVER on a shareable (--as) view — that
  // would silently consume changes the owner's next run should see — and never when record===false.
  if (audience === "owner" && opts.record !== false) {
    writeSnapshot(opts.root, nextSnapshot);
  }
  return orientation;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const END_OF_TIME = "9999-12-31"; // sorts undated owed items last

function baseItem(sig: Signal, extra: Partial<DailyItem>): DailyItem {
  const item: DailyItem = { kind: sig.kind, summary: sig.summary, tier: sig.tier, ref: sig.ref };
  if (extra.due !== undefined) item.due = extra.due;
  if (extra.stale !== undefined) item.stale = extra.stale;
  if (extra.changeType !== undefined) item.changeType = extra.changeType;
  return item;
}

/**
 * The change classification used for SECTION PLACEMENT. With a prior baseline, use the real
 * diff. On the first run (no baseline) fall back to the 24h window so day one shows "what
 * happened today" instead of flooding with the whole workspace as "added".
 */
function placementChange(
  change: SignalChange | undefined,
  sig: Signal,
  hasPrior: boolean,
  fromIso: string,
  toIso: string
): ChangeType {
  if (hasPrior) return change?.changeType ?? "added";
  return inWindow(sig.occurredAt, fromIso, toIso) ? "added" : "unchanged";
}

function inWindow(occurredAt: string, fromIso: string, toIso: string): boolean {
  const t = Date.parse(occurredAt);
  const f = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(t) || !Number.isFinite(f) || !Number.isFinite(to)) return false;
  return t >= f && t <= to;
}

function changeAtOf(change: SignalChange | undefined, fallback: string): string {
  return change?.lastChangedAt ?? fallback;
}

/** True if any freeform field contains a blocked/waiting keyword (word-boundary, un-safe). */
function looksBlocked(...fields: unknown[]): boolean {
  return fields.some((f) => typeof f === "string" && BLOCKED_RE.test(f));
}

/** ISO calendar day (YYYY-MM-DD) of a string, or null if it isn't a valid leading ISO date. */
function dayOf(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const m = DAY_RE.exec(s);
  const day = m?.[1];
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === day ? day : null;
}

/** Positive-form overdue/due-today test: a VALID due day on/ before today. Lexical ISO compare
 *  (TZ-free, inclusive of today). A malformed/absent due can never satisfy it → treated as no due. */
function isDueByToday(due: unknown, todayDay: string): boolean {
  const d = dayOf(typeof due === "string" ? due : null);
  return d != null && d <= todayDay;
}

/** Whole days a carryover has been outstanding, but only when it exceeds the threshold; a
 *  missing/malformed createdAt is NOT stale (returns null), never throws. */
function staleDaysOf(
  createdAt: unknown,
  generatedAt: string,
  thresholdDays: number
): number | null {
  const createdDay = dayOf(typeof createdAt === "string" ? createdAt : null);
  const generatedDay = dayOf(generatedAt);
  if (!createdDay || !generatedDay) return null;
  const c = Date.parse(`${createdDay}T00:00:00.000Z`);
  const now = Date.parse(`${generatedDay}T00:00:00.000Z`);
  if (!Number.isFinite(c) || !Number.isFinite(now)) return null;
  const days = Math.floor((now - c) / 86_400_000);
  return days > thresholdDays ? days : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function finish<T extends { item: DailyItem }>(
  entries: T[],
  cmp: (a: T, b: T) => number
): { items: DailyItem[]; total: number } {
  entries.sort(cmp);
  return { items: entries.slice(0, SECTION_CAP).map((e) => e.item), total: entries.length };
}

function cmpStr(a?: string, b?: string): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
function byRef(a: { item: DailyItem }, b: { item: DailyItem }): number {
  return cmpStr(a.item.ref.path, b.item.ref.path) || cmpStr(a.item.ref.row, b.item.ref.row);
}
function byChanged(
  a: { item: DailyItem; changeAt: string },
  b: { item: DailyItem; changeAt: string }
): number {
  return -cmpStr(a.changeAt, b.changeAt) || byRef(a, b); // most-recently-changed first
}
function byBlocked(
  a: { item: DailyItem; stale: number },
  b: { item: DailyItem; stale: number }
): number {
  return b.stale - a.stale || byRef(a, b); // most-stale first
}
function byOwed(
  a: { item: DailyItem; dueDay: string },
  b: { item: DailyItem; dueDay: string }
): number {
  return cmpStr(a.dueDay, b.dueDay) || byRef(a, b); // soonest/overdue first, undated last
}
