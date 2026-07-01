// Deterministic agent-runtime derivation from session events (AIO-139).
//
// No presence inference: runtime is the active wall-clock of a work block, where a block is a run
// of events with no idle gap larger than `idleGapMin`. Concurrency SUMS (parallel terminals = the
// leverage number); there is no cross-session union (that belonged to attended effort, deferred).

import { createHash } from "node:crypto";
import type { SessionEvent } from "./session-log.js";

export type Tag = "engineering" | "strategy" | "communication" | "admin" | "research" | "meetings";
export const TAGS: readonly Tag[] = [
  "engineering",
  "strategy",
  "communication",
  "admin",
  "research",
  "meetings",
];

export interface WorkBlock {
  id: string; // opaque: sha256(cwdRealpath + '#' + startIso).slice(0,10)
  sessionId: string;
  cwdRealpath: string; // canonical repo path (most-frequent non-null cwd among the block's events)
  gitBranch: string | null;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  runtimeMin: number;
  tag: Tag;
  toolCounts: Record<string, number>;
}

export interface DeriveOptions {
  nowMs: number;
  idleGapMin: number;
}

/** Segment session events into finalized work blocks. Pure. */
export function deriveBlocks(events: SessionEvent[], opts: DeriveOptions): WorkBlock[] {
  const idleMs = opts.idleGapMin * 60_000;
  const finalizeBefore = opts.nowMs - idleMs; // blocks whose last event is newer are still "open"

  // Group by session, then segment each session's timeline on idle gaps.
  const bySession = new Map<string, SessionEvent[]>();
  for (const e of events) {
    const arr = bySession.get(e.sessionId);
    if (arr) arr.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const blocks: WorkBlock[] = [];
  for (const [sessionId, evs] of bySession) {
    evs.sort((a, b) => a.tsMs - b.tsMs);
    let run: SessionEvent[] = [];
    const flush = () => {
      const b = finalizeRun(sessionId, run, finalizeBefore);
      if (b) blocks.push(b);
      run = [];
    };
    for (const e of evs) {
      const last = run[run.length - 1];
      if (last && e.tsMs - last.tsMs > idleMs) flush();
      run.push(e);
    }
    flush();
  }
  return blocks;
}

/** Build a finalized block from a contiguous run, or null if it must be dropped
 *  (no repo, zero-length, or still open). */
function finalizeRun(
  sessionId: string,
  run: SessionEvent[],
  finalizeBefore: number
): WorkBlock | null {
  if (run.length < 2) return null; // single-event → zero-length, dropped

  const first = run[0]!;
  const last = run[run.length - 1]!;
  const startMs = first.tsMs;
  const endMs = last.tsMs;

  // Open-session rule: an ongoing block (last event within the idle window of "now") is not
  // finalized — it would keep growing and cannot be confirmed.
  if (endMs > finalizeBefore) return null;

  const runtimeMin = Math.round((endMs - startMs) / 60_000);
  if (runtimeMin <= 0) return null; // zero-length after rounding

  const cwdRealpath = dominantCwd(run);
  if (!cwdRealpath) return null; // no attributable repo

  const toolCounts: Record<string, number> = {};
  for (const e of run) {
    if (e.toolName) toolCounts[e.toolName] = (toolCounts[e.toolName] ?? 0) + 1;
  }
  const gitBranch = run.find((e) => e.gitBranch)?.gitBranch ?? null;

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const id = createHash("sha256").update(`${cwdRealpath}#${startIso}`).digest("hex").slice(0, 10);
  const tag = tagBlock({ cwdRealpath, toolCounts });

  return {
    id,
    sessionId,
    cwdRealpath,
    gitBranch,
    startMs,
    endMs,
    startIso,
    endIso,
    runtimeMin,
    tag,
    toolCounts,
  };
}

/** Most-frequent non-null cwd realpath among a run's events (deterministic on ties by first-seen). */
function dominantCwd(run: SessionEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const e of run) {
    if (e.cwdRealpath) counts.set(e.cwdRealpath, (counts.get(e.cwdRealpath) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [p, n] of counts) {
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/** Deterministic tag heuristic from tool-mix + path. Imperfect by design; reconcile corrects it. */
export function tagBlock(input: { cwdRealpath: string; toolCounts: Record<string, number> }): Tag {
  const scores: Record<Tag, number> = {
    engineering: 0,
    strategy: 0,
    communication: 0,
    admin: 0,
    research: 0,
    meetings: 0,
  };
  for (const [name, n] of Object.entries(input.toolCounts)) {
    const low = name.toLowerCase();
    if (/slack|gmail|whatsapp|mattermost|email|wacli|bird/.test(low)) scores.communication += n;
    else if (/granola|calendar|gcal|\bmeet\b/.test(low)) scores.meetings += n;
    else if (/websearch|webfetch|fetch|tavily|firecrawl|browser|navigate/.test(low))
      scores.research += n;
    else if (/edit|write|bash|notebook/.test(low)) scores.engineering += n;
    // Read/Grep/Glob/Task/etc. → neutral
  }
  const p = input.cwdRealpath.toLowerCase();
  if (/0-context|roadmap|strateg/.test(p)) scores.strategy += 1;
  if (/\.github|\/ci(\/|$)|settings|chore/.test(p)) scores.admin += 1;

  let best: Tag = "engineering";
  let bestScore = 0;
  for (const tag of TAGS) {
    if (scores[tag] > bestScore) {
      best = tag;
      bestScore = scores[tag];
    }
  }
  return best;
}

export interface TagTotal {
  tag: string;
  durationMin: number;
}

/** Sum durations per tag → { tag, durationMin } sorted by minutes desc (ties by tag).
 *  The ONLY shape that reaches a shareable digest — no repo, id, path, or session. */
export function runtimeByTag(items: Array<{ tag: string; durationMin: number }>): TagTotal[] {
  const sums = new Map<string, number>();
  for (const it of items) {
    const m = Number.isFinite(it.durationMin) ? it.durationMin : 0;
    sums.set(it.tag, (sums.get(it.tag) ?? 0) + m);
  }
  return [...sums.entries()]
    .map(([tag, durationMin]) => ({ tag, durationMin }))
    .sort((a, b) => b.durationMin - a.durationMin || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** Minutes → "H.Hh" for display. */
export function formatHours(min: number): string {
  return `${(min / 60).toFixed(1)}h`;
}
