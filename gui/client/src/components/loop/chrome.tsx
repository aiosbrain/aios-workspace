import { AlertTriangle } from "lucide-react";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../../lib/cn";

/**
 * Small chrome shared by the Operator Loop views.
 *
 * Extracted when WeeklyView moved out of LoopPanel: both need the same loading skeleton and the
 * same non-zero-exit warning, and a second copy of either would drift the moment one was styled.
 * LoopPanel can't export them to WeeklyView — LoopPanel imports WeeklyView, so that would be a
 * cycle.
 */

/** Panel-level buttons. Row-level controls use the compact button defined by each view. */
export const LOOP_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
export const LOOP_BTN_PRIMARY = cn(
  LOOP_BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)]"
);

export function LoadingRows() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-3/4 rounded-md" />
      <Skeleton className="h-6 w-2/3 rounded-md" />
      <Skeleton className="h-6 w-1/2 rounded-md" />
    </div>
  );
}

export function ExitCodeWarning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))] px-3 py-2 text-xs text-destructive">
      <AlertTriangle size={14} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}
