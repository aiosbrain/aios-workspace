/**
 * AskCard (I-14 / AIO-395) — a TerminalFrame-based card for one queue item, rendered in a specific
 * display state. The full I-13 state vocabulary is representable: open/snoozed/resolved,
 * action_pending, receipted, delivery_failed, outcome_unknown, STALE, and reopened-with-failed-action.
 *
 * Design-system discipline (DESIGN.md): the state chip uses violet for the pending badge, amber for
 * staleness/unknown, destructive for failures, emerald for a receipt — lime stays rationed to the one
 * live TerminalFrame status dot, so a card never spends the screen's single lime accent on chrome.
 */

import { Terminal, Mail, Check, AlertTriangle, Clock, XCircle, RotateCcw } from "lucide-react";
import type { ComponentType } from "react";
import { TerminalFrame } from "@aios-alpha/ui";
import { cn } from "../../lib/cn";
import { ASK_CARD_STATE_LABELS, type AskCardState } from "./types";

const CHIP =
  "inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)]";

// Per-state chip tone + glyph. Violet = pending badge; amber = attention/unknown; destructive = failure;
// emerald = receipted; muted = terminal/neutral states.
const STATE_TONE: Record<AskCardState, { cls: string; Icon: ComponentType<{ size?: number }> }> = {
  open: { cls: "text-muted-foreground border-border-visible", Icon: Terminal },
  snoozed: { cls: "text-muted-foreground border-border-visible", Icon: Clock },
  resolved: { cls: "text-muted-foreground border-border-visible", Icon: Check },
  action_pending: { cls: "text-primary border-[var(--accent-line)]", Icon: Clock },
  receipted: {
    cls: "text-[var(--green)] border-[color-mix(in_srgb,var(--aios-emerald)_45%,var(--aios-border-visible))]",
    Icon: Check,
  },
  delivery_failed: {
    cls: "text-destructive border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))]",
    Icon: XCircle,
  },
  outcome_unknown: {
    cls: "text-[var(--aios-amber)] border-[color-mix(in_srgb,var(--aios-amber)_45%,var(--aios-border-visible))]",
    Icon: AlertTriangle,
  },
  stale: {
    cls: "text-[var(--aios-amber)] border-[color-mix(in_srgb,var(--aios-amber)_45%,var(--aios-border-visible))]",
    Icon: AlertTriangle,
  },
  reopened_failed: {
    cls: "text-destructive border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))]",
    Icon: RotateCcw,
  },
};

/** The compact state pill — reused by the queue rows and the card header so tones never drift. */
export function StateChip({ state, className }: { state: AskCardState; className?: string }) {
  const tone = STATE_TONE[state];
  return (
    <span className={cn(CHIP, tone.cls, className)} data-ask-state={state}>
      <tone.Icon size={11} />
      {ASK_CARD_STATE_LABELS[state]}
    </span>
  );
}

export interface AskCardProps {
  state: AskCardState;
  /** Row title — an ask title or a runtime/sender label. Content is synthetic in fixtures. */
  title: string;
  /** Channel/runtime the item came from (e.g. "claude-code", "email"). */
  source?: string | null;
  /** The I-04 "why now" string for this row. */
  why?: string;
  /** The terminal body — the ask/thread summary the card frames. */
  body: string;
  /** Dim tag meta line (e.g. ["agent-ask", "project:aios", "blocks-session"]). */
  meta?: string[];
  /** Short age/time label. */
  timeLabel?: string;
  /** Agent escalation vs comms thread — picks the header glyph. */
  origin?: "agent-event" | "thread-state";
}

export function AskCard({
  state,
  title,
  source,
  why,
  body,
  meta = [],
  timeLabel,
  origin = "agent-event",
}: AskCardProps) {
  const HeaderGlyph = origin === "agent-event" ? Terminal : Mail;
  // The one live accent: only a genuinely in-flight action animates the lime status dot.
  const frameStatus = state === "action_pending" ? "live" : "static";

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border-visible bg-card p-3"
      data-ask-state={state}
    >
      <div className="flex items-center gap-2">
        <HeaderGlyph size={15} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {title}
        </span>
        {timeLabel && (
          <span className="font-mono text-[11px] text-muted-foreground">{timeLabel}</span>
        )}
        <StateChip state={state} />
      </div>

      <TerminalFrame filename={source || title} status={frameStatus} code={body} />

      {(meta.length > 0 || why) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {meta.map((m) => (
            <span key={m} className={m.startsWith("project:") ? "text-primary" : undefined}>
              {m}
            </span>
          ))}
          {why && <span className="text-muted-foreground">· {why}</span>}
        </div>
      )}
    </div>
  );
}
