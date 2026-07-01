// Shared utility-class strings for the connector / personality cards. Used by the
// Integrations hub and the Agent settings personality grid so both stay in sync.
import { cn } from "../../lib/cn";

export const INT_GRID = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3";
export const INT_CARD =
  "flex flex-col gap-2 rounded-xl border border-border-visible bg-card p-3.5 shadow-card";
export const INT_CARD_WIRED =
  "border-[color-mix(in_srgb,var(--aios-accent)_50%,var(--aios-border-visible))]";
export const INT_CONNECT =
  "cursor-pointer rounded-md bg-primary px-3 py-[5px] text-[13px] font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)] disabled:cursor-default disabled:opacity-40";
export const SKELETON_CARD = "h-[120px] rounded-xl bg-muted opacity-60";

export const intCard = (wired: boolean) => cn(INT_CARD, wired && INT_CARD_WIRED);

// Integrations / Skills panel shell (also used inside the Settings scroll area).
export const INTEGRATIONS_ROOT =
  "flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-[18px]";
export const INT_HEAD = "flex items-start justify-between gap-4";
export const INT_HEAD_H2 =
  "m-0 font-display text-[length:var(--aios-text-h3)] font-normal tracking-[var(--aios-tracking-snug)]";
export const INT_SUB = "mt-1 max-w-[60ch] text-[13px] text-muted-foreground";
export const INT_PROGRESS = "whitespace-nowrap font-mono text-xs text-muted-foreground";
export const INT_FOOT = "text-xs text-muted-foreground";
export const INT_SECTION = "mt-1.5 mb-[-2px] text-[13px] font-semibold text-foreground";
export const INT_SECTION_MUTED = "mt-3.5 mb-[-2px] text-[13px] font-medium text-muted-foreground";
export const META_ERROR = "self-center bg-transparent p-0.5 text-xs text-destructive";
