/** Quiet, scan-first queue. Ranking and protection still determine order; they are not UI chrome. */

import { Bot, CalendarDays, Hash, Mail, MessageCircle, Send, Terminal } from "lucide-react";
import { cn } from "../../lib/cn";
import { deriveAskState, type AskOverdueState, type InboxItem, type InboxView } from "./types";
import { itemLabel, itemSnippet, ageLabel } from "./presenters";
import { COMMS_CHANNEL_LABELS, channelForItem, type CommsChannel } from "./channel-filter";

export function sourceFor(item: InboxItem) {
  if (item.origin === "agent-event") {
    return { label: item.source || "Agent", Glyph: Terminal };
  }
  const channel = channelForItem(item);
  if (channel === "calendar") return { label: "Calendar", Glyph: CalendarDays };
  if (channel === "telegram") return { label: "Telegram", Glyph: Send };
  if (channel === "slack") return { label: "Slack", Glyph: Hash };
  if (channel === "whatsapp") return { label: "WhatsApp", Glyph: MessageCircle };
  if (channel === "gmail") return { label: "Gmail", Glyph: Mail };
  return { label: item.source || "Other", Glyph: Mail };
}

function overdueTitle(overdue: AskOverdueState) {
  const minutes = Math.max(1, Math.floor(overdue.overdue_by_ms / 60_000));
  if (overdue.delivery_attempts === 0) return `waiting ${minutes}m · phone alert not sent`;
  const noun = overdue.delivery_attempts === 1 ? "delivery attempt" : "delivery attempts";
  return `waiting ${minutes}m · alert not opened after ${overdue.delivery_attempts} ${noun}`;
}

export function telegramLaneLabel(view: InboxView) {
  const status = view.notify?.lane.status;
  if (status === "disabled") return "Telegram alerts off";
  if (status === "configured") return "Telegram alerts armed";
  if (status === "delivery_ok") return "Telegram alert delivered";
  if (status === "degraded") return "Some Telegram alerts failed";
  if (status === "failed") return "Telegram alerts failed";
  if (status === "unavailable") return "Telegram alerts unavailable";
  return "Telegram sends alerts only";
}

export function telegramInboundLabel(view: InboxView) {
  const status = view.freshness?.sources.telegram;
  if (!status || status === "outbound_only") return null;
  if (status === "ready") return "Telegram inbox connected";
  if (status === "degraded") return "Telegram inbox partly connected";
  if (status === "failed") return "Telegram inbox refresh failed";
  if (status === "unavailable") return "Telegram inbox not connected";
  return "Telegram inbox checking";
}

function stateLabel(item: InboxItem) {
  const state = deriveAskState(item);
  if (state === "action_pending") return "Pending";
  if (state === "delivery_failed" || state === "reopened_failed") return "Failed";
  if (state === "outcome_unknown") return "Unknown";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function refreshLabel(view: InboxView) {
  const refresh = view.freshness;
  if (!refresh) return null;
  if (refresh.status === "refreshing" && !refresh.last_success_at) return "Updating…";
  if (refresh.status === "failed" || refresh.status === "unavailable") return refresh.error;
  if (refresh.last_success_at) {
    const prefix = refresh.status === "degraded" ? "Partly updated" : "Updated";
    return `${prefix} ${ageLabel(refresh.last_success_at)}${refresh.status === "degraded" ? " · some sources unavailable" : ""}`;
  }
  return null;
}

function QueueRow({
  item,
  selected,
  onSelect,
  overdue,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (id: string) => void;
  overdue?: AskOverdueState;
}) {
  const { label: source, Glyph } = sourceFor(item);
  const summary = itemSnippet(item);
  const state = stateLabel(item);
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={selected}
      className={cn(
        "group flex w-full gap-3 border-l-2 border-b border-l-transparent border-b-border-visible px-3 py-3 text-left transition-colors hover:bg-secondary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        selected && "border-l-[var(--accent-line)] bg-[var(--accent-soft)]"
      )}
    >
      <span className="relative mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border-visible bg-muted text-muted-foreground">
        <Glyph size={15} strokeWidth={1.8} />
        {item.protected && (
          <span
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card bg-primary"
            aria-label="protected"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {itemLabel(item)}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{ageLabel(item.ts)}</span>
        </span>
        {summary && (
          <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{source}</span>
          {item.account && <span className="truncate">· {item.account}</span>}
          {overdue && (
            <span
              className="shrink-0 rounded-full border border-border-visible px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={overdueTitle(overdue)}
            >
              Alert not opened
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-foreground/75">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full bg-muted-foreground",
                state === "Failed" && "bg-destructive",
                state === "Pending" && "bg-[var(--aios-amber)]",
                state === "Open" && "bg-[var(--green)]"
              )}
            />
            {state}
          </span>
        </span>
        <span className="sr-only">Why now: {item.why}</span>
      </span>
    </button>
  );
}

export interface CommsQueueProps {
  view: InboxView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  channel?: CommsChannel;
  /** A fetch error while the last-good view stays rendered (poll or detail refresh failure). */
  error?: string | null;
}

export function CommsQueue({
  view,
  selectedId,
  onSelect,
  channel = "all",
  error,
}: CommsQueueProps) {
  const protectedItems = view.items.filter((item) => item.protected);
  const rest = view.items.filter((item) => !item.protected);
  const freshness = refreshLabel(view);
  const inboundTelegram = telegramInboundLabel(view);

  return (
    <section className="flex h-full min-h-0 w-[348px] shrink-0 flex-col border-r border-border-visible bg-card max-lg:w-[316px]">
      <header className="border-b border-border-visible px-3 py-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">
          {COMMS_CHANNEL_LABELS[channel]}
        </h1>
        {error && (
          <p className="mt-0.5 text-[11px] text-[var(--aios-amber)]" role="status">
            Refresh failed — showing the last good read. {error}
          </p>
        )}
        {freshness && (
          <p
            className={cn(
              "mt-0.5 text-[11px] text-muted-foreground",
              (view.freshness?.status === "failed" || view.freshness?.status === "degraded") &&
                "text-[var(--aios-amber)]",
              view.freshness?.status === "unavailable" && "text-muted-foreground"
            )}
            role={view.freshness?.error ? "status" : undefined}
          >
            {freshness}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <Mail size={18} className="mb-2 text-muted-foreground" />
            <p className="text-[13px] font-medium text-foreground">
              Nothing needs attention in {COMMS_CHANNEL_LABELS[channel]}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              New matching messages will appear here.
            </p>
          </div>
        ) : (
          <>
            {protectedItems.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
                overdue={view.notify?.overdue[item.id]}
              />
            ))}
            {protectedItems.length > 0 && rest.length > 0 && (
              <div role="separator" aria-label="protected partition" className="h-1 bg-muted/50" />
            )}
            {rest.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
                overdue={view.notify?.overdue[item.id]}
              />
            ))}
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-visible px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Bot size={12} /> {telegramLaneLabel(view)}
        </span>
        {inboundTelegram && (
          <span className="inline-flex items-center gap-1.5">
            <Send size={12} /> {inboundTelegram}
          </span>
        )}
      </footer>
    </section>
  );
}
