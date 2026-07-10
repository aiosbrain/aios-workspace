// C8 — loop telemetry + dogfood instrumentation. Local-only, admin-tier operational data.
//
// The loop already writes its artifacts under `.aios/loop/`; C8 appends an event ledger next to
// them and reads it back into the six V1 exit-criteria metrics. Like the C7 continuity store, the
// ledger lives under `.aios/loop/` so it inherits the "never synced" boundary (gitignored, outside
// sync_include). Every event is tagged `tier:"admin"` — it is owner-only and never leaves the box.
//
// Two invariants shape the code:
//   • WRITES are best-effort — a telemetry failure must never break a loop run (errors swallowed).
//   • READS fail CLOSED for metric confidence — corrupt/unknown lines surface as warnings and null
//     the metrics they could silently corrupt, rather than showing a false green.
//
// See docs/v1-operator-loop/c8-telemetry.md and docs/ENGINEERING-CONSTITUTION.md §4/§5.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Cadence } from "./signal.js";

export const TELEMETRY_EVENTS_REL = ".aios/loop/telemetry/events.jsonl";
export const TELEMETRY_ENV = "AIOS_LOOP_TELEMETRY";
export const TELEMETRY_VERSION = 1;

const DAY_MS = 86_400_000;
const DISABLED = new Set(["0", "off", "false", "no"]);

// Exit-criteria thresholds (single-sourced so the CLI + rubric can reference them).
export const THRESHOLDS = {
  wallClockMedianMin: 20, // median weekly closeout < 20 min
  verifierShippableRate: 0.9, // >= 90% of accepted runs
  nextWeekActionAcceptance: 0.7, // >= 70% of approval-decided runs
  consecutiveCleanWeeklies: 3, // >= 3 consecutive leak-free weekly runs
  tierLeakCount: 0, // == 0 shipped leaks (product-ending)
} as const;

/** Forward-compat: unknown kinds are ignored (never counted), per the constitution. */
export type TelemetryKind =
  | "daily.run"
  | "weekly.run"
  | "weekly.verify"
  | "weekly.shipped"
  | "weekly.approve"
  | (string & {});

export interface TelemetryEvent {
  v: 1;
  kind: TelemetryKind;
  tier: "admin"; // ALWAYS admin — owner-only operational data
  runId: string; // = closeout/manifest stamp; joins .aios/loop/closeouts/<stamp>/
  cadence: Cadence;
  at: string; // ISO event time
  member: string;
  project: string;
  payload: Record<string, unknown>;
}

/** The shape callers pass to `recordEvent` — `v`/`tier` are stamped for you; `at` defaults to now. */
export interface TelemetryEventInput {
  kind: TelemetryKind;
  runId: string;
  cadence: Cadence;
  member: string;
  project: string;
  payload?: Record<string, unknown>;
  at?: string;
}

// ── write side (best-effort) ────────────────────────────────────────────────────────────────────

/**
 * Recording is ON by default; `AIOS_LOOP_TELEMETRY` in {0,off,false,no} (trimmed, lower-cased)
 * disables it. Any other value (incl. unset) → enabled.
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[TELEMETRY_ENV] ?? "")
    .trim()
    .toLowerCase();
  return !DISABLED.has(raw);
}

/**
 * Append one event to the local JSONL ledger. No-op when telemetry is disabled. Best-effort:
 * ALL I/O errors are swallowed — telemetry must never fail a loop run. Returns true iff a line
 * was written.
 */
export function recordEvent(
  root: string,
  input: TelemetryEventInput,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!telemetryEnabled(env)) return false;
  try {
    const event: TelemetryEvent = {
      v: TELEMETRY_VERSION,
      kind: input.kind,
      tier: "admin",
      runId: input.runId,
      cadence: input.cadence,
      at: input.at ?? new Date().toISOString(),
      member: input.member,
      project: input.project,
      payload: input.payload ?? {},
    };
    const abs = path.join(root, TELEMETRY_EVENTS_REL);
    mkdirSync(path.dirname(abs), { recursive: true });
    appendFileSync(abs, JSON.stringify(event) + "\n");
    return true;
  } catch {
    return false; // never throw
  }
}

// ── read side (fails closed) ─────────────────────────────────────────────────────────────────────

export type ParseReason = "malformed-json" | "unknown-version" | "missing-fields" | "unreadable";
export interface ParseWarning {
  phase: "parse";
  line: number;
  reason: ParseReason;
  runId?: string; // set when the bad line still exposes a string runId (attributable)
}
export interface ReadResult {
  events: TelemetryEvent[];
  warnings: ParseWarning[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Read + parse the JSONL ledger. NEVER silently drops a non-empty line — every skipped line yields
 * a ParseWarning. Blank lines are ignored (not warnings). Cross-event facts (e.g. orphan approvals)
 * are NOT detected here — they are semantic and belong to `computeMetrics`.
 */
export function readEvents(root: string): ReadResult {
  const abs = path.join(root, TELEMETRY_EVENTS_REL);
  const out: ReadResult = { events: [], warnings: [] };
  if (!existsSync(abs)) return out;

  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    // The ledger EXISTS but can't be read — that is NOT "no data". Emit an unattributable
    // data-quality warning (no runId) so computeMetrics degrades the product-ending metrics to
    // met:null instead of falsely reporting zero leaks / a passing streak (fail closed).
    out.warnings.push({ phase: "parse", line: 0, reason: "unreadable" });
    return out;
  }

  const lines = raw.split(/\r?\n/);
  lines.forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return; // blank → ignore

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      out.warnings.push({ phase: "parse", line, reason: "malformed-json" });
      return;
    }

    // A parseable non-object (array/number/string) can't be an event, but may still be indexable —
    // grab a runId only from a record.
    const runId = isRecord(parsed) ? asStr(parsed.runId) : undefined;

    if (!isRecord(parsed)) {
      out.warnings.push({ phase: "parse", line, reason: "missing-fields" });
      return;
    }
    if (parsed.v !== TELEMETRY_VERSION) {
      out.warnings.push({ phase: "parse", line, reason: "unknown-version", runId });
      return;
    }

    const kind = asStr(parsed.kind);
    const rid = asStr(parsed.runId);
    const cadence = asStr(parsed.cadence);
    const at = asStr(parsed.at);
    const member = asStr(parsed.member);
    const project = asStr(parsed.project);
    const okCadence = cadence === "daily" || cadence === "weekly";
    // `at` must be a PARSEABLE timestamp — a non-parseable one would otherwise pass here and then
    // silently drop out of the window filter in computeMetrics with no warning, falsely improving
    // the metrics. Reject it as a (attributable) missing-fields warning instead.
    const okAt = !!at && Number.isFinite(Date.parse(at));
    if (!kind || !rid || !okCadence || !okAt || !member || !project || !isRecord(parsed.payload)) {
      out.warnings.push({ phase: "parse", line, reason: "missing-fields", runId });
      return;
    }

    out.events.push({
      v: TELEMETRY_VERSION,
      kind,
      tier: "admin",
      runId: rid,
      cadence,
      at,
      member,
      project,
      payload: parsed.payload,
    });
  });

  return out;
}

// ── aggregation ──────────────────────────────────────────────────────────────────────────────────

export type WarnPhase = "parse" | "semantic";
export interface Warning {
  phase: WarnPhase;
  reason: string;
  line?: number;
  runId?: string;
  at?: string;
  detail?: string;
}

export interface MetricResult {
  label: string;
  value: number | null;
  unit: string;
  threshold: string;
  met: boolean | null; // null = insufficient / degraded data (never a false green)
  sampleSize: number;
  note?: string;
}

export interface LoopMetrics {
  tierLeakCount: MetricResult;
  weeklyWallClock: MetricResult;
  verifierShippableRate: MetricResult;
  nextWeekActionAcceptance: MetricResult;
  dailyRunFrequency: MetricResult;
  consecutiveCleanWeeklies: MetricResult;
  breakdown: {
    weeklyRuns: number;
    dailyRuns: number;
    verifier: { pass: number; corrected: number; failed: number };
    leakWithheldTotal: number;
    dataQuality: {
      corruptLines: number;
      unknownVersionLines: number;
      missingFieldLines: number;
      unattributableGaps: number;
      degradedRunIds: string[];
    };
  };
  warnings: Warning[];
  window: { from: string; to: string; days: number | null };
}

export interface ComputeOptions {
  now?: Date;
  windowDays?: number | null; // undefined → 14; null → whole ledger
  dailySourceWired?: boolean; // shipped CLI passes true; a build without C4 daily passes false
}

interface WeeklyGroup {
  runId: string;
  run?: TelemetryEvent;
  verifies: TelemetryEvent[];
  shippeds: TelemetryEvent[];
  approves: TelemetryEvent[];
  degraded: boolean;
  endedAt: number; // sort key (ms)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function isWeekday(ms: number): boolean {
  const g = new Date(ms).getDay();
  return g >= 1 && g <= 5;
}

/** Mon–Fri local dates in [fromMs, toMs] inclusive; DST-safe (steps by calendar day). */
function workingDaysBetween(fromMs: number, toMs: number): number {
  const start = new Date(fromMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(toMs);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  for (let t = start.getTime(); t <= end.getTime();) {
    if (isWeekday(t)) count++;
    const nd = new Date(t);
    nd.setDate(nd.getDate() + 1);
    t = nd.getTime();
  }
  return count;
}

function eventMs(e: TelemetryEvent): number {
  const t = Date.parse(e.at);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Reduce the event ledger to the six V1 exit-criteria metrics. Pure — no I/O. Degrades to
 * `met:null` (never a false green) when data quality cannot support a trustworthy result.
 */
export function computeMetrics(read: ReadResult, opts: ComputeOptions = {}): LoopMetrics {
  const toMs = (opts.now ?? new Date()).getTime();
  const windowDays = opts.windowDays === undefined ? 14 : opts.windowDays;
  const dailySourceWired = opts.dailySourceWired ?? false;

  const allTimes = read.events.map(eventMs).filter((t) => Number.isFinite(t));
  const fromMs =
    windowDays === null
      ? allTimes.length
        ? Math.min(...allTimes)
        : toMs
      : toMs - windowDays * DAY_MS;

  const inWindow = read.events.filter((e) => {
    const t = eventMs(e);
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  });

  // ── group weekly events by runId; collect daily.run separately ──
  const groups = new Map<string, WeeklyGroup>();
  const dailyRunEvents: TelemetryEvent[] = [];
  const ensure = (runId: string): WeeklyGroup => {
    let g = groups.get(runId);
    if (!g) {
      g = { runId, verifies: [], shippeds: [], approves: [], degraded: false, endedAt: NaN };
      groups.set(runId, g);
    }
    return g;
  };
  for (const e of inWindow) {
    switch (e.kind) {
      case "daily.run":
        dailyRunEvents.push(e);
        break;
      case "weekly.run":
        ensure(e.runId).run = e;
        break;
      case "weekly.verify":
        ensure(e.runId).verifies.push(e);
        break;
      case "weekly.shipped":
        ensure(e.runId).shippeds.push(e);
        break;
      case "weekly.approve":
        ensure(e.runId).approves.push(e);
        break;
      default:
        break; // unknown kind → ignored
    }
  }

  // ── attribute parse warnings; unattributable ones cause global blindness ──
  const degradedRunIds = new Set<string>();
  let unattributableGaps = 0;
  let corruptLines = 0;
  let unknownVersionLines = 0;
  let missingFieldLines = 0;
  for (const w of read.warnings) {
    if (w.reason === "unknown-version") unknownVersionLines++;
    else if (w.reason === "missing-fields") missingFieldLines++;
    else corruptLines++; // malformed-json OR an unreadable ledger
    if (w.runId && groups.has(w.runId)) degradedRunIds.add(w.runId);
    else unattributableGaps++;
  }
  for (const id of degradedRunIds) {
    const g = groups.get(id);
    if (g) g.degraded = true;
  }

  const warnings: Warning[] = read.warnings.map((w) => ({
    phase: "parse",
    reason: w.reason,
    line: w.line,
    runId: w.runId,
  }));

  // ── finalize weekly groups (sort key + orphan detection) ──
  const earliestApproveMs = (g: WeeklyGroup): number =>
    Math.min(...g.approves.map(eventMs).filter((t) => Number.isFinite(t)));

  const weeklyGroups: WeeklyGroup[] = [];
  for (const g of groups.values()) {
    // Orphan approve: an approval with no matching weekly.run in-window → semantic warning, excluded.
    if (!g.run && g.approves.length) {
      const at = g.approves
        .map((a) => a.at)
        .sort()
        .at(0);
      warnings.push({
        phase: "semantic",
        reason: "orphan-approve",
        runId: g.runId,
        at,
        detail: `weekly.approve for run ${g.runId} has no weekly.run in window — excluded from acceptance + wall-clock`,
      });
    }
    if (g.run || g.verifies.length || g.shippeds.length) {
      const ended = asNumEndedAt(g.run) ?? (g.run ? eventMs(g.run) : NaN);
      g.endedAt = Number.isFinite(ended)
        ? ended
        : Math.max(
            ...[...g.verifies, ...g.shippeds, ...g.approves]
              .map(eventMs)
              .filter((t) => Number.isFinite(t))
          );
      weeklyGroups.push(g);
    }
  }
  weeklyGroups.sort((a, b) => a.endedAt - b.endedAt);

  const completed = weeklyGroups.filter((g) => g.run && !g.degraded);

  // ── tier-leak count (product-ending) ──
  const shippedEvents = weeklyGroups.flatMap((g) => g.shippeds);
  const shippedLeaks = shippedEvents.filter((s) => asBool(s.payload.tierLeak) === true).length;
  const leakGlobalBlind = unattributableGaps > 0;
  const tierLeakCount: MetricResult = {
    label: "Tier-leak count (shipped)",
    value: shippedLeaks,
    unit: "leaks",
    threshold: "== 0",
    met: leakGlobalBlind ? null : shippedLeaks === THRESHOLDS.tierLeakCount,
    sampleSize: shippedEvents.length,
    note: leakGlobalBlind
      ? `data quality: ${unattributableGaps} unreadable line(s) — cannot certify zero`
      : degradedRunIds.size
        ? `${degradedRunIds.size} run(s) degraded (leak status unverified for: ${[...degradedRunIds].join(", ")})`
        : undefined,
  };

  // ── clean weekly runs + consecutive streak ──
  const audiencesOf = (g: WeeklyGroup): string[] => asStrArr(g.run?.payload.audiences);
  const isClean = (g: WeeklyGroup): boolean => {
    if (g.degraded || !g.run) return false;
    if (asBool(g.run.payload.anyFailed) !== false) return false;
    const auds = audiencesOf(g);
    for (const aud of auds) {
      const v = g.verifies.find((e) => asStr(e.payload.audience) === aud);
      if (!v || asStr(v.payload.status) === "failed" || asBool(v.payload.shippable) !== true)
        return false;
    }
    if (g.shippeds.some((s) => asBool(s.payload.tierLeak) === true)) return false;
    return true;
  };
  // The TAIL streak — consecutive clean runs ending at the MOST RECENT weekly run — not the
  // best streak anywhere. `clean, clean, clean, leaked` must report 0, not 3: the exit criterion
  // is "are we currently on a clean run", so a later non-clean or degraded weekly resets it.
  // (`weeklyGroups` is sorted ascending by endedAt, so we walk backward from the end.)
  const weeklyRunsForStreak = weeklyGroups.filter((g) => g.run);
  let tailStreak = 0;
  for (let i = weeklyRunsForStreak.length - 1; i >= 0; i--) {
    const g = weeklyRunsForStreak[i];
    if (g && isClean(g)) tailStreak++;
    else break;
  }
  const consecutiveCleanWeeklies: MetricResult = {
    label: "Consecutive clean weeklies",
    value: tailStreak,
    unit: "runs",
    threshold: ">= 3",
    met: leakGlobalBlind ? null : tailStreak >= THRESHOLDS.consecutiveCleanWeeklies,
    sampleSize: completed.length,
    note: leakGlobalBlind ? "data quality: unreadable line(s) — streak unverifiable" : undefined,
  };

  // ── verifier shippable rate (per completed run) ──
  const verifierTally = { pass: 0, corrected: 0, failed: 0 };
  for (const g of weeklyGroups)
    for (const v of g.verifies) {
      const st = asStr(v.payload.status);
      if (st === "pass") verifierTally.pass++;
      else if (st === "corrected") verifierTally.corrected++;
      else if (st === "failed") verifierTally.failed++;
    }
  const verifierClean = (g: WeeklyGroup): boolean => {
    const auds = audiencesOf(g);
    if (!auds.length) return false;
    return auds.every((aud) => {
      const v = g.verifies.find((e) => asStr(e.payload.audience) === aud);
      return !!v && asStr(v.payload.status) !== "failed" && asBool(v.payload.shippable) === true;
    });
  };
  const verifDenom = completed.length;
  const verifNumer = completed.filter(verifierClean).length;
  const verifierShippableRate: MetricResult = {
    label: "Verifier shippable rate",
    value: verifDenom ? verifNumer / verifDenom : null,
    unit: "rate",
    threshold: ">= 0.90",
    met: verifDenom ? verifNumer / verifDenom >= THRESHOLDS.verifierShippableRate : null,
    sampleSize: verifDenom,
    note: verifDenom ? undefined : "no completed weekly runs yet",
  };

  // ── next-week-action acceptance (per approval-decided run) ──
  const approvalDecided = completed.filter((g) => g.approves.length > 0);
  const acceptedActions = (g: WeeklyGroup): Set<string> => {
    const keys = new Set<string>();
    for (const a of g.approves) for (const k of asStrArr(a.payload.taskRowsWritten)) keys.add(k);
    return keys;
  };
  const acceptNumer = approvalDecided.filter((g) => acceptedActions(g).size > 0).length;
  const acceptDenom = approvalDecided.length;
  const nextWeekActionAcceptance: MetricResult = {
    label: "Next-week-action acceptance",
    value: acceptDenom ? acceptNumer / acceptDenom : null,
    unit: "rate",
    threshold: ">= 0.70",
    met: acceptDenom ? acceptNumer / acceptDenom >= THRESHOLDS.nextWeekActionAcceptance : null,
    sampleSize: acceptDenom,
    note: acceptDenom ? undefined : "pending approvals",
  };

  // ── weekly wall-clock (ritual span; CLI-duration fallback) ──
  let ritualSamples = 0;
  let proxySamples = 0;
  const minutes: number[] = [];
  for (const g of completed) {
    const run = g.run as TelemetryEvent;
    const startedAt = Date.parse(asStr(run.payload.startedAt) ?? "");
    let ms: number | undefined;
    if (g.approves.length && Number.isFinite(startedAt)) {
      const approveMs = earliestApproveMs(g);
      if (Number.isFinite(approveMs) && approveMs >= startedAt) {
        ms = approveMs - startedAt;
        ritualSamples++;
      }
    }
    if (ms === undefined) {
      const dur = asNum(run.payload.durationMs);
      if (dur !== undefined) {
        ms = dur;
        proxySamples++;
      }
    }
    if (ms !== undefined) minutes.push(ms / 60000);
  }
  const medMin = minutes.length ? median(minutes) : null;
  const weeklyWallClock: MetricResult = {
    label: "Weekly closeout wall-clock (median)",
    value: medMin === null ? null : Math.round(medMin * 10) / 10,
    unit: "min",
    threshold: "< 20",
    met: medMin === null ? null : medMin < THRESHOLDS.wallClockMedianMin,
    sampleSize: minutes.length,
    note: minutes.length
      ? `${ritualSamples} ritual-span / ${proxySamples} CLI-proxy`
      : "no completed weekly runs yet",
  };

  // ── daily-run frequency (habit signal) ──
  const dailyDays = new Set(dailyRunEvents.map((e) => localDateKey(eventMs(e))));
  const workingDays = workingDaysBetween(fromMs, toMs);
  const dailyRunFrequency: MetricResult = {
    label: "Daily-run frequency",
    value: dailyDays.size,
    unit: "days",
    threshold: ">= majority of working days",
    met: !dailySourceWired
      ? null
      : workingDays > 0
        ? dailyDays.size >= Math.ceil(workingDays / 2)
        : null,
    sampleSize: workingDays,
    note: !dailySourceWired
      ? "no daily source wired"
      : `${dailyDays.size}/${workingDays} working days`,
  };

  const leakWithheldTotal = weeklyGroups
    .flatMap((g) => g.verifies)
    .reduce((sum, v) => sum + (asNum(v.payload.leakWithheld) ?? 0), 0);

  return {
    tierLeakCount,
    weeklyWallClock,
    verifierShippableRate,
    nextWeekActionAcceptance,
    dailyRunFrequency,
    consecutiveCleanWeeklies,
    breakdown: {
      weeklyRuns: completed.length,
      dailyRuns: dailyRunEvents.length,
      verifier: verifierTally,
      leakWithheldTotal,
      dataQuality: {
        corruptLines,
        unknownVersionLines,
        missingFieldLines,
        unattributableGaps,
        degradedRunIds: [...degradedRunIds],
      },
    },
    warnings,
    window: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days: windowDays,
    },
  };
}

/** weekly.run.payload.endedAt as ms, or undefined. Kept small to keep the group loop readable. */
function asNumEndedAt(run: TelemetryEvent | undefined): number | undefined {
  if (!run) return undefined;
  const t = Date.parse(asStr(run.payload.endedAt) ?? "");
  return Number.isFinite(t) ? t : undefined;
}
