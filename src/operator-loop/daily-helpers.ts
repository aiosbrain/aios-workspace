import type { Ask, AskSeverity } from "./asks/store.js";
import { ASKS_STORE_REL } from "./asks/store.js";
import type { SignalChange } from "./changes.js";
import type { Audience } from "./ledger.js";
import type { Signal } from "./signal.js";
import type { DailyItem, TranscriptReviewCounts } from "./daily.js";

export const DAILY_SCOPE = "daily";
export const STALE_CARRYOVER_DAYS = 7;
const SECTION_CAP = 7;
export const END_OF_TIME = "9999-12-31";

const BLOCKED_RE = /\b(blocked|blocker|waiting|stalled|paused|on[-\s]hold)\b/i;
const NEEDS_REPLY_RE = /\b(needs?|needing|awaiting)\s+(?:a\s+)?repl(?:y|ies)\b/i;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})/;
const QUEUED_SEVERITY_RANK: Record<AskSeverity, number> = {
  blocker: 0,
  decision: 1,
  fyi: 2,
};

export function transcriptReviewForAudience(
  audience: Audience,
  counts: TranscriptReviewCounts | undefined
): TranscriptReviewCounts | undefined {
  if (audience !== "owner" || counts === undefined) return undefined;
  const total =
    counts.pendingStages +
    counts.decisions +
    counts.tasks +
    counts.failedRubric +
    counts.gradingErrors +
    counts.unreadableStages;
  return total > 0 ? counts : undefined;
}

export function askItem(ask: Ask): DailyItem {
  return {
    kind: "ask",
    summary: `${ask.title} [${ask.severity}]`,
    tier: ask.tier,
    ref: { path: ASKS_STORE_REL, row: ask.id, tier: ask.tier },
  };
}

export function byAskOldest(
  a: { item: DailyItem; createdAt: string },
  b: { item: DailyItem; createdAt: string }
): number {
  return cmpStr(a.createdAt, b.createdAt) || cmpStr(a.item.ref.row, b.item.ref.row);
}

export function byQueued(
  a: { item: DailyItem; createdAt: string; severity: AskSeverity },
  b: { item: DailyItem; createdAt: string; severity: AskSeverity }
): number {
  return (
    QUEUED_SEVERITY_RANK[a.severity] - QUEUED_SEVERITY_RANK[b.severity] ||
    -cmpStr(a.createdAt, b.createdAt) ||
    cmpStr(a.item.ref.row, b.item.ref.row)
  );
}

export function baseItem(sig: Signal, extra: Partial<DailyItem>): DailyItem {
  const item: DailyItem = { kind: sig.kind, summary: sig.summary, tier: sig.tier, ref: sig.ref };
  if (extra.due !== undefined) item.due = extra.due;
  if (extra.stale !== undefined) item.stale = extra.stale;
  if (extra.changeType !== undefined) item.changeType = extra.changeType;
  return item;
}

export function inWindow(occurredAt: string, fromIso: string, toIso: string): boolean {
  const occurred = Date.parse(occurredAt);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(occurred) || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  return occurred >= from && occurred <= to;
}

export function changeAtOf(change: SignalChange | undefined, fallback: string): string {
  return change?.lastChangedAt ?? fallback;
}

export function looksBlocked(...fields: readonly unknown[]): boolean {
  return fields.some((field) => typeof field === "string" && BLOCKED_RE.test(field));
}

export function needsReply(sig: Signal, waitingOn: string | null): boolean {
  if (sig.source !== "email" && sig.source !== "slack") return false;
  const normalizedWaitingOn = waitingOn?.toLowerCase();
  const explicitlyMine = normalizedWaitingOn === "me" || normalizedWaitingOn === "owner";
  const direction = sig.payload?.direction;
  if (explicitlyMine) return direction !== "outbound";
  return direction === "inbound" && NEEDS_REPLY_RE.test(sig.summary);
}

export function dayOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = DAY_RE.exec(value);
  const day = match?.[1];
  if (!day) return null;
  const instant = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(instant)) return null;
  return new Date(instant).toISOString().slice(0, 10) === day ? day : null;
}

export function isDueByToday(due: unknown, todayDay: string): boolean {
  const dueDay = dayOf(typeof due === "string" ? due : null);
  return dueDay != null && dueDay <= todayDay;
}

export function staleDaysOf(
  createdAt: unknown,
  generatedAt: string,
  thresholdDays: number
): number | null {
  const createdDay = dayOf(typeof createdAt === "string" ? createdAt : null);
  const generatedDay = dayOf(generatedAt);
  if (!createdDay || !generatedDay) return null;
  const created = Date.parse(`${createdDay}T00:00:00.000Z`);
  const generated = Date.parse(`${generatedDay}T00:00:00.000Z`);
  if (!Number.isFinite(created) || !Number.isFinite(generated)) return null;
  const days = Math.floor((generated - created) / 86_400_000);
  return days > thresholdDays ? days : null;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function strOrUndef(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function finish<T extends { item: DailyItem }>(
  entries: T[],
  compare: (a: T, b: T) => number
): { items: DailyItem[]; total: number } {
  const sorted = [...entries].sort(compare);
  return { items: sorted.slice(0, SECTION_CAP).map((entry) => entry.item), total: entries.length };
}

function cmpStr(a?: string, b?: string): number {
  const left = a ?? "";
  const right = b ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function byRef(a: { item: DailyItem }, b: { item: DailyItem }): number {
  return cmpStr(a.item.ref.path, b.item.ref.path) || cmpStr(a.item.ref.row, b.item.ref.row);
}

export function byChanged(
  a: { item: DailyItem; changeAt: string },
  b: { item: DailyItem; changeAt: string }
): number {
  return -cmpStr(a.changeAt, b.changeAt) || byRef(a, b);
}

export function byBlocked(
  a: { item: DailyItem; stale: number },
  b: { item: DailyItem; stale: number }
): number {
  return b.stale - a.stale || byRef(a, b);
}

export function byOwed(
  a: { item: DailyItem; dueDay: string },
  b: { item: DailyItem; dueDay: string }
): number {
  return cmpStr(a.dueDay, b.dueDay) || byRef(a, b);
}

export function byOccurredAt(
  a: { item: DailyItem; occurredAt: string },
  b: { item: DailyItem; occurredAt: string }
): number {
  return cmpStr(a.occurredAt, b.occurredAt) || byRef(a, b);
}

export function byOccurredAtDesc(
  a: { item: DailyItem; occurredAt: string },
  b: { item: DailyItem; occurredAt: string }
): number {
  return -cmpStr(a.occurredAt, b.occurredAt) || byRef(a, b);
}
