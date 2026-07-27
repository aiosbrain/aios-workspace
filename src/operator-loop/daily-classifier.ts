import type { AskSeverity } from "./asks/store.js";
import { artifactKey, diffSignals } from "./changes.js";
import { isOpenStatus } from "./continuity.js";
import type { BuildDailyOptions, DailyItem, DailyOrientation } from "./daily.js";
import {
  DAILY_SCOPE,
  END_OF_TIME,
  STALE_CARRYOVER_DAYS,
  askItem,
  baseItem,
  byAskOldest,
  byBlocked,
  byChanged,
  byOccurredAt,
  byOccurredAtDesc,
  byOwed,
  byQueued,
  changeAtOf,
  dayOf,
  finish,
  inWindow,
  isDueByToday,
  looksBlocked,
  needsReply,
  staleDaysOf,
  strOrNull,
  strOrUndef,
  transcriptReviewForAudience,
} from "./daily-helpers.js";
import { visibleTiers, type Audience } from "./ledger.js";
import { runtimeByTag } from "./time/runtime.js";

export function buildDailyOrientation(opts: BuildDailyOptions): {
  orientation: DailyOrientation;
  nextSnapshot: ReturnType<typeof diffSignals>["next"];
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
  const { changes, next } = diffSignals({
    prior: opts.prior,
    signals: opts.manifest.signals,
    now,
    scope: DAILY_SCOPE,
  });
  const visible = visibleTiers(audience);
  const changedE: Array<{ item: DailyItem; changeAt: string }> = [];
  const blockedE: Array<{ item: DailyItem; stale: number }> = [];
  const owedE: Array<{ item: DailyItem; dueDay: string }> = [];
  const calendarE: Array<{ item: DailyItem; occurredAt: string }> = [];
  const replyE: Array<{ item: DailyItem; occurredAt: string }> = [];

  for (const sig of opts.manifest.signals) {
    const payload = sig.payload ?? {};
    const change = changes.get(artifactKey(sig));
    const changeType = hasPrior
      ? (change?.changeType ?? "added")
      : inWindow(sig.occurredAt, win.from, win.to)
        ? "added"
        : "unchanged";
    const isChanged = changeType === "added" || changeType === "modified";
    if (sig.kind === "carryover") {
      const stale = staleDaysOf(payload.createdAt, generatedAt, staleDays);
      if (stale != null || looksBlocked(sig.summary, payload.status, payload.title)) {
        blockedE.push({
          item: baseItem(sig, { due: strOrNull(payload.due), stale: stale ?? undefined }),
          stale: stale ?? 0,
        });
      } else {
        owedE.push({
          item: baseItem(sig, { due: strOrNull(payload.due) }),
          dueDay: dayOf(strOrNull(payload.due)) ?? END_OF_TIME,
        });
      }
      continue;
    }
    if (sig.kind === "task") {
      if (!isOpenStatus(strOrUndef(payload.status))) continue;
      const labels = Array.isArray(payload.labels) ? payload.labels : [];
      if (looksBlocked(sig.summary, payload.status, ...labels)) {
        blockedE.push({ item: baseItem(sig, { due: strOrNull(payload.due) }), stale: 0 });
      } else if (isDueByToday(payload.due, todayDay)) {
        owedE.push({
          item: baseItem(sig, { due: strOrNull(payload.due) }),
          dueDay: dayOf(strOrNull(payload.due)) ?? END_OF_TIME,
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
      if (looksBlocked(sig.summary, payload.status)) {
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
    if (sig.kind !== "comms") continue;
    if (sig.source === "calendar") {
      if (inWindow(sig.occurredAt, win.from, win.to)) {
        calendarE.push({ item: baseItem(sig, {}), occurredAt: sig.occurredAt });
      }
      continue;
    }
    const waitingOn = strOrNull(payload.waitingOn);
    if (needsReply(sig, waitingOn)) {
      replyE.push({ item: baseItem(sig, {}), occurredAt: sig.occurredAt });
      continue;
    }
    if (waitingOn || looksBlocked(sig.summary)) {
      blockedE.push({ item: baseItem(sig, { due: strOrNull(payload.dueAt) }), stale: 0 });
    }
  }

  const withheld = [changedE, blockedE, owedE, calendarE, replyE].reduce(
    (total, entries) => total + entries.filter((entry) => !visible.has(entry.item.tier)).length,
    0
  );
  const changedS = finish(
    changedE.filter((entry) => visible.has(entry.item.tier)),
    byChanged
  );
  const blockedS = finish(
    blockedE.filter((entry) => visible.has(entry.item.tier)),
    byBlocked
  );
  const owedS = finish(
    owedE.filter((entry) => visible.has(entry.item.tier)),
    byOwed
  );
  const calendarS = finish(
    calendarE.filter((entry) => visible.has(entry.item.tier)),
    byOccurredAt
  );
  const replyS = finish(
    replyE.filter((entry) => visible.has(entry.item.tier)),
    byOccurredAtDesc
  );
  const attentionE: Array<{ item: DailyItem; createdAt: string }> = [];
  const queuedE: Array<{ item: DailyItem; createdAt: string; severity: AskSeverity }> = [];
  if (audience === "owner") {
    for (const ask of opts.asks ?? []) {
      if (ask.status !== "open") continue;
      const item = askItem(ask);
      if (ask.severity === "blocker") attentionE.push({ item, createdAt: ask.createdAt });
      else queuedE.push({ item, createdAt: ask.createdAt, severity: ask.severity });
    }
  }
  const attentionS = finish(attentionE, byAskOldest);
  const queuedS = finish(queuedE, byQueued);
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  const ranByTag = runtimeByTag(
    opts.manifest.signals
      .filter((signal) => visible.has(signal.tier))
      .filter((signal) => signal.kind === "time")
      .filter((signal) => {
        const occurred = Date.parse(signal.occurredAt);
        return Number.isFinite(occurred) && occurred >= fromMs && occurred <= toMs;
      })
      .map((signal) => ({
        tag: typeof signal.payload?.tag === "string" ? signal.payload.tag : "engineering",
        durationMin:
          typeof signal.payload?.durationMin === "number" ? signal.payload.durationMin : 0,
      }))
  );
  const transcriptReview = transcriptReviewForAudience(audience, opts.transcriptReview);
  const orientation: DailyOrientation = {
    member: opts.manifest.member,
    window: { cadence: "daily", from: win.from, to: win.to },
    generatedAt,
    audience,
    attention: attentionS.items,
    queuedAsks: queuedS.items,
    changed: changedS.items,
    blocked: blockedS.items,
    owedToday: owedS.items,
    calendar: calendarS.items,
    commsNeedingReply: replyS.items,
    ranByTag,
    counts: {
      attention: attentionS.total,
      queuedAsks: queuedS.total,
      changed: changedS.total,
      blocked: blockedS.total,
      owedToday: owedS.total,
      calendar: calendarS.total,
      commsNeedingReply: replyS.total,
      withheld,
      excluded: opts.manifest.excluded.length,
    },
    excluded: audience === "owner" ? opts.manifest.excluded : [],
    ...(transcriptReview === undefined ? {} : { transcriptReview }),
  };
  return { orientation, nextSnapshot: next };
}
