import { fmtK } from "../../lib/format";
import { useRuntime, useSession } from "../../state/cockpit";
import type { Usage } from "../../types/protocol";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { estimateContext } from "./context-usage";

function UsageDetails({ label, usage }: { label: string; usage: Usage }) {
  return (
    <div className="flex flex-col gap-0.5">
      <strong className="font-sans text-[11px] font-semibold text-foreground">{label}</strong>
      <span>input: {fmtK(usage.input_tokens)}</span>
      <span>cache read: {fmtK(usage.cache_read_input_tokens)}</span>
      <span>cache write: {fmtK(usage.cache_creation_input_tokens)}</span>
      <span>output: {fmtK(usage.output_tokens)}</span>
    </div>
  );
}

/** Current prompt occupancy is shown separately from cumulative session usage. */
export function ContextMeter() {
  const { capabilities } = useRuntime();
  const { usage, sessionUsage } = useSession();

  if (!capabilities.tokenUsage || !capabilities.contextWindow) return null;
  const window = capabilities.contextWindow;
  const estimate = estimateContext(usage, window);
  const pct = estimate.percent;
  const fill =
    pct >= 90 ? "var(--aios-amber)" : pct >= 75 ? "var(--aios-fuchsia)" : "var(--aios-violet)";
  const label = !estimate.valid
    ? "context estimate unavailable"
    : estimate.tokens == null
      ? "context (est.) —"
      : `context (est.) ~${fmtK(estimate.tokens)} / ${fmtK(window)}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-end gap-2 px-5 pt-1 font-mono text-[11px] text-muted-foreground">
            <div className="h-[5px] w-[90px] overflow-hidden rounded-[3px] bg-secondary">
              <div
                className="h-full rounded-[3px] transition-[width] duration-300 ease-[ease]"
                style={{ width: `${pct}%`, background: fill }}
              />
            </div>
            <span>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {usage || sessionUsage ? (
            <div className="flex gap-4 font-mono text-xs">
              {usage && <UsageDetails label="Current context estimate" usage={usage} />}
              {sessionUsage && <UsageDetails label="Session totals" usage={sessionUsage} />}
              {!estimate.valid && (
                <span className="max-w-[220px] font-sans text-[11px] text-muted-foreground">
                  The runtime reported more prompt tokens than its advertised window, so the meter
                  is intentionally hidden.
                </span>
              )}
            </div>
          ) : (
            <span>No usage reported yet — send a turn.</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
