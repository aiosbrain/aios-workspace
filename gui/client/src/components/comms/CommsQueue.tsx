/**
 * CommsQueue (I-14 / AIO-395) — the ranked queue, left half of the Command Deck split-screen.
 *
 * Renders the three trust affordances the design ruling makes load-bearing: the PROTECTED PARTITION
 * (protected rows above a visible separator), a per-row "why now" string (I-04), and the ranker version
 * + honest staleness in the header. Read-only; selecting a row drives the detail pane.
 */

import { Terminal, Mail, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/cn";
import { StateChip } from "./AskCard";
import { deriveAskState, type InboxItem, type InboxView } from "./types";
import { itemLabel, itemSnippet, itemMeta, ageLabel } from "./presenters";

const EYEBROW =
  "px-1 pb-1 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground";

function QueueRow({
  item,
  selected,
  onSelect,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const Glyph = item.origin === "agent-event" ? Terminal : Mail;
  const state = deriveAskState(item);
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={selected}
      className={cn(
        "flex w-full flex-col gap-1 border-l-2 border-transparent px-3 py-2 text-left hover:bg-secondary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        selected && "border-l-[var(--accent-line)] bg-[var(--accent-soft)]"
      )}
    >
      <div className="flex items-center gap-2">
        {item.protected && (
          <span
            className="h-[6px] w-[6px] shrink-0 rounded-full bg-primary"
            aria-label="protected"
          />
        )}
        <Glyph size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {itemLabel(item)}
        </span>
        <StateChip state={state} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {ageLabel(item.ts)}
        </span>
      </div>
      {itemSnippet(item) && (
        <p className="truncate pl-4 text-[12px] text-muted-foreground">{itemSnippet(item)}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 pl-4 font-mono text-[11px] text-muted-foreground">
        {itemMeta(item).map((m) => (
          <span key={m} className={m.startsWith("runtime:") ? "text-primary" : undefined}>
            {m}
          </span>
        ))}
        {/* the per-row "why now" string (I-04) — every surfaced item owes the user its reason. */}
        <span className="text-muted-foreground">· {item.why}</span>
      </div>
    </button>
  );
}

export interface CommsQueueProps {
  view: InboxView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function CommsQueue({ view, selectedId, onSelect }: CommsQueueProps) {
  const protectedItems = view.items.filter((i) => i.protected);
  const rest = view.items.filter((i) => !i.protected);
  const stale = view.staleness.stale;
  const channels = new Set(
    view.items.filter((i) => i.origin === "thread-state").map((i) => i.source || i.account)
  ).size;
  const agentAsks = view.items.filter((i) => i.origin === "agent-event").length;

  return (
    <div className="flex h-full min-h-0 w-[360px] shrink-0 flex-col border-r border-border-visible bg-card">
      <div className="border-b border-border-visible px-3 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="font-display text-lg tracking-[var(--aios-tracking-snug)] text-foreground">
            Queue
          </h1>
          <span className="font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
            ranked · {view.ranker_version}
          </span>
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          {view.items.length} items · {channels} channels · {agentAsks} agent asks
        </div>
        {stale && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--aios-amber)_45%,var(--aios-border-visible))] bg-secondary px-2 py-1 text-[11px] text-[var(--aios-amber)]">
            <AlertTriangle size={12} />
            <span>
              Read model is STALE — newest observation{" "}
              {view.staleness.newest_observation_ts
                ? ageLabel(view.staleness.newest_observation_ts)
                : "?"}{" "}
              old (SLO {Math.round(view.staleness.slo_ms / 60000)}m)
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {protectedItems.length > 0 && (
          <>
            <div className={cn(EYEBROW, "pt-2 text-primary")}>
              Protected · approvals & unbreakables
            </div>
            {protectedItems.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
        {/* the protected-partition separator — protected always renders above this line. */}
        <div
          className="my-1 border-t border-border-visible"
          role="separator"
          aria-label="protected partition"
        />
        <div className={EYEBROW}>Ranked by attention</div>
        {rest.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">Nothing below the line.</p>
        ) : (
          rest.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
