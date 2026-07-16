/** Quiet, scan-first queue. Ranking and protection still determine order; they are not UI chrome. */

import { Bot, CalendarDays, Mail, Terminal } from "lucide-react";
import { cn } from "../../lib/cn";
import { deriveAskState, type InboxItem, type InboxView } from "./types";
import { itemLabel, itemSnippet, ageLabel } from "./presenters";

function sourceFor(item: InboxItem) {
  if (item.origin === "agent-event") {
    return { label: item.source || "Agent", Glyph: Terminal };
  }
  if (item.observation?.object_kind === "calendar-event" || item.source === "calendar") {
    return { label: "Calendar", Glyph: CalendarDays };
  }
  return { label: "Gmail", Glyph: Mail };
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
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (id: string) => void;
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
}

export function CommsQueue({ view, selectedId, onSelect }: CommsQueueProps) {
  const protectedItems = view.items.filter((item) => item.protected);
  const rest = view.items.filter((item) => !item.protected);
  const freshness = refreshLabel(view);

  return (
    <section className="flex h-full min-h-0 w-[348px] shrink-0 flex-col border-r border-border-visible bg-card max-lg:w-[316px]">
      <header className="border-b border-border-visible px-3 py-3">
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Inbox</h1>
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
            <p className="text-[13px] font-medium text-foreground">Nothing needs attention</p>
            <p className="mt-1 text-[12px] text-muted-foreground">New messages will appear here.</p>
          </div>
        ) : (
          <>
            {protectedItems.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
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
              />
            ))}
          </>
        )}
      </div>

      <footer className="flex items-center gap-1.5 border-t border-border-visible px-3 py-2 text-[11px] text-muted-foreground">
        <Bot size={12} /> Telegram sends alerts only
      </footer>
    </section>
  );
}
