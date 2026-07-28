/**
 * Today console — the ranking + collapse model behind the Operator Loop's action queue.
 *
 * The C4 daily payload arrives pre-split into seven buckets (attention / queuedAsks / blocked /
 * owedToday / calendar / commsNeedingReply / changed). Rendering those buckets as seven headed
 * lists is what made the panel unreadable: every row looked alike, nothing said what KIND of
 * thing it was, and the ordering carried no urgency. This module folds them into ONE ranked
 * queue where each row knows its lane (how urgent + what it is) and its action (what you can do
 * about it right now).
 *
 * Three jobs, all pure so they can be tested without a DOM or a server:
 *   • classify  — bucket → lane, and recover the ask severity the CLI packs into the summary
 *   • collapse  — fold identical rows (the idle-ask leak minted seven "waiting for your input")
 *   • rank      — blockers first, then by how late, so the top of the list is the next thing to do
 *
 * `changed` is deliberately NOT surfaced here: it is a diff feed for the audit view, not work
 * owed by the operator. Keeping it out is the difference between a queue and a log.
 */

import type { DailyItem, DailyOrientation } from "../../types/protocol";

/** What kind of pressure a row carries. Order of declaration IS the ranking order. */
export const TODAY_LANES = [
  "blocker",
  "overdue",
  "blocked",
  "due",
  "reply",
  "decision",
  "event",
] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

/** The one action a row offers, or "none" for context-only rows (calendar). */
export type TodayAction = "resolve-ask" | "complete-task" | "none";

export interface TodayRow {
  /** Stable across refreshes: lane + kind + title, so React keys survive a poll. */
  key: string;
  lane: TodayLane;
  /** Signal kind from the loop (`ask` | `task` | `carryover` | `comms` | …). */
  kind: string;
  /** Human title, with the CLI's `[severity]` suffix stripped off. */
  title: string;
  tier: string;
  path: string;
  row?: string;
  due?: string | null;
  overdueDays?: number;
  staleDays?: number;
  action: TodayAction;
  /** Ask ids folded into this row — resolving it closes every one. */
  askIds: string[];
  /** tasks.md row key, when the row is a completable task. */
  taskRowKey?: string;
  /** How many identical items collapsed into this row (1 = not collapsed). */
  count: number;
}

export const LANE_LABEL: Record<TodayLane, string> = {
  blocker: "Blocker",
  overdue: "Overdue",
  blocked: "Blocked",
  due: "Due today",
  reply: "Needs reply",
  decision: "Decision",
  event: "Today",
};

/**
 * The CLI packs severity into the summary as a trailing `[blocker]` / `[decision]` / `[fyi]`
 * (see `askItem` in daily-helpers.ts). Strip it for display — the lane already conveys severity,
 * and the raw suffix is noise in a queue.
 */
export function stripSeveritySuffix(summary: string): string {
  return summary.replace(/\s*\[(?:blocker|decision|fyi)\]\s*$/i, "").trim();
}

/** A tasks-file signal carries its `row_key` in `ref.row`, which is what makes it completable. */
function taskRowKeyOf(item: DailyItem, kind: string): string | undefined {
  if (kind !== "task" && kind !== "carryover") return undefined;
  return item.ref.row || undefined;
}

function rowFor(item: DailyItem, lane: TodayLane): TodayRow {
  const kind = item.kind;
  const isAsk = kind === "ask";
  const title = isAsk ? stripSeveritySuffix(item.summary) : item.summary;
  const taskRowKey = taskRowKeyOf(item, kind);
  const askId = isAsk ? item.ref.row : undefined;
  return {
    key: `${lane}:${kind}:${title}`,
    lane,
    kind,
    title,
    tier: item.tier,
    path: item.ref.path,
    row: item.ref.row,
    due: item.due ?? null,
    overdueDays: item.overdueDays,
    staleDays: item.stale,
    action: isAsk ? "resolve-ask" : taskRowKey ? "complete-task" : "none",
    askIds: askId ? [askId] : [],
    taskRowKey,
    count: 1,
  };
}

/**
 * Fold rows sharing a key into one, summing the count and unioning the ask ids.
 *
 * This is what tames a runaway hook: seven abandoned sessions each minted an identical
 * "Claude is waiting for your input" blocker, and the panel dutifully rendered seven rows. One
 * row with a ×7 badge is the honest presentation, and resolving it closes all seven at once.
 * Non-ask rows key on lane+kind+title too, so a genuine duplicate task never double-counts.
 */
export function collapseRows(rows: readonly TodayRow[]): TodayRow[] {
  const byKey = new Map<string, TodayRow>();
  for (const row of rows) {
    const existing = byKey.get(row.key);
    if (!existing) {
      byKey.set(row.key, { ...row, askIds: [...row.askIds] });
      continue;
    }
    existing.count += row.count;
    for (const id of row.askIds) if (!existing.askIds.includes(id)) existing.askIds.push(id);
    // Keep the worst case visible when duplicates disagree on lateness.
    if ((row.overdueDays ?? -1) > (existing.overdueDays ?? -1))
      existing.overdueDays = row.overdueDays;
  }
  return [...byKey.values()];
}

const LANE_RANK: Record<TodayLane, number> = Object.fromEntries(
  TODAY_LANES.map((lane, i) => [lane, i])
) as Record<TodayLane, number>;

/**
 * Rank: lane first, then most-overdue, then most-stale, then title for a stable order.
 * A stable tiebreak matters — the list re-renders on every refresh and rows must not shuffle.
 */
export function rankRows(rows: readonly TodayRow[]): TodayRow[] {
  return [...rows].sort((a, b) => {
    const lane = LANE_RANK[a.lane] - LANE_RANK[b.lane];
    if (lane !== 0) return lane;
    const overdue = (b.overdueDays ?? 0) - (a.overdueDays ?? 0);
    if (overdue !== 0) return overdue;
    const stale = (b.staleDays ?? 0) - (a.staleDays ?? 0);
    if (stale !== 0) return stale;
    return a.title.localeCompare(b.title);
  });
}

/** Build the full ranked, collapsed queue from a C4 daily payload. */
export function buildTodayQueue(daily: DailyOrientation): TodayRow[] {
  const rows: TodayRow[] = [
    ...daily.attention.map((i) => rowFor(i, "blocker")),
    ...daily.blocked.map((i) => rowFor(i, "blocked")),
    // The owed bucket admits everything due on or before today; overdueDays is what splits it.
    ...daily.owedToday.map((i) => rowFor(i, (i.overdueDays ?? 0) > 0 ? "overdue" : "due")),
    ...daily.commsNeedingReply.map((i) => rowFor(i, "reply")),
    ...daily.queuedAsks.map((i) => rowFor(i, "decision")),
    ...daily.calendar.map((i) => rowFor(i, "event")),
  ];
  return rankRows(collapseRows(rows));
}

/** Counts per lane, for the summary strip above the queue. */
export function laneCounts(rows: readonly TodayRow[]): Array<{ lane: TodayLane; count: number }> {
  return TODAY_LANES.map((lane) => ({
    lane,
    count: rows.filter((r) => r.lane === lane).reduce((n, r) => n + r.count, 0),
  })).filter((entry) => entry.count > 0);
}

/**
 * The prompt handed to the chat agent when the operator picks "Ask". It carries the evidence
 * ref so the agent can open the source instead of guessing which file the row came from.
 */
export function askPromptFor(row: TodayRow): string {
  const where = row.row ? `${row.path}#${row.row}` : row.path;
  return `From my operator loop (${LANE_LABEL[row.lane].toLowerCase()}): "${row.title}"\nEvidence: ${where}\n\nGive me the context on this and what you'd suggest I do about it.`;
}
