/**
 * Presenters (I-14 / AIO-395) — pure item → display-string helpers shared by the queue and the detail
 * pane, so a row and its detail never disagree. Content shown here is admin-tier local (synthetic in the
 * fixture harness); these functions never reshape the underlying contract, they only read it.
 */

import type { InboxItem, OutboxState } from "./types";

export interface SendPresentation {
  label: "Sending…" | "Sent ✓" | "Confirming…" | "Failed";
  tooltip: string;
  tone: "pending" | "success" | "danger";
}

/** The only user-facing vocabulary for durable/local Gmail send state. */
export function presentSendState(state: OutboxState): SendPresentation {
  if (state === "sent") {
    return { label: "Sent ✓", tooltip: "Accepted by Gmail", tone: "success" };
  }
  if (state === "reconciled") {
    return { label: "Sent ✓", tooltip: "Found in Gmail Sent", tone: "success" };
  }
  if (state === "outcome_unknown") {
    return {
      label: "Confirming…",
      tooltip: "Checking Gmail Sent before any retry",
      tone: "pending",
    };
  }
  if (state === "failed") {
    return { label: "Failed", tooltip: "Gmail did not accept the send", tone: "danger" };
  }
  return { label: "Sending…", tooltip: "Sending through Gmail", tone: "pending" };
}

/** The row's primary label — a runtime/ask title for agents, a sender/account for threads. */
export function itemLabel(item: InboxItem): string {
  if (item.origin === "agent-event") {
    return (item.ask?.title as string) || item.source || (item.ask?.kind as string) || "Agent ask";
  }
  const parts = item.observation?.participants;
  const from = parts?.find((p) => p.role === "from") ?? parts?.[0];
  return from?.display || from?.id || item.account || item.source || "Message";
}

/** A one-line snippet for the row body. */
export function itemSnippet(item: InboxItem): string {
  if (item.origin === "agent-event") return (item.ask?.title as string) || "";
  return (item.observation?.snippet as string) || "";
}

/** Dim tag meta for a row (origin, source/account, coarse bucket). project:* renders violet in the UI. */
export function itemMeta(item: InboxItem): string[] {
  const meta: string[] = [];
  meta.push(item.origin === "agent-event" ? "agent-ask" : item.source || "thread");
  if (item.source && item.origin === "agent-event") meta.push(`runtime:${item.source}`);
  if (item.account) meta.push(item.account);
  meta.push(item.bucket);
  return meta;
}

/** Compact relative-age label — best-effort, never throws. Timezone polish is deferred (spec §Scope). */
export function ageLabel(ts: string, now: Date = new Date()): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const m = Math.floor(Math.max(0, now.getTime() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
