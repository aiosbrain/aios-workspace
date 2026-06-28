// Shared utility-class strings for the connector / personality cards. Used by the
// Integrations hub and the Agent settings personality grid so both stay in sync.
import { cn } from "../../lib/cn";

export const INT_GRID = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3";
export const INT_CARD =
  "flex flex-col gap-2 rounded-xl border border-border-visible bg-card p-3.5 shadow-card";
export const INT_CARD_WIRED =
  "border-[color-mix(in_srgb,var(--aios-accent)_50%,var(--aios-border-visible))]";
export const INT_CONNECT =
  "rounded-md bg-primary px-3 py-[5px] text-[13px] font-semibold text-primary-foreground cursor-pointer enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)]";
export const SKELETON_CARD = "h-[120px] rounded-xl bg-muted opacity-60";

export const intCard = (wired: boolean) => cn(INT_CARD, wired && INT_CARD_WIRED);
