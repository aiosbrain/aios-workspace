import { fmtK } from "../../lib/format";
import { useRuntime } from "../../state/cockpit";
import { useSession } from "../../state/cockpit";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

/**
 * Approximate context occupancy = the prompt fed on the latest turn (fresh input +
 * cached tokens), out of the runtime's window. Hidden entirely for runtimes that
 * don't report token usage (capabilities.tokenUsage === false).
 */
export function ContextMeter() {
  const { capabilities } = useRuntime();
  const { usage } = useSession();

  if (!capabilities.tokenUsage || !capabilities.contextWindow) return null;
  const window = capabilities.contextWindow;

  const ctx = usage
    ? (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0)
    : null;
  const pct = ctx == null ? 0 : Math.min(100, Math.round((ctx / window) * 100));
  // Violet through the comfortable range; warm to amber as the window fills.
  const fill =
    pct >= 90 ? "var(--aios-amber)" : pct >= 75 ? "var(--aios-fuchsia)" : "var(--aios-violet)";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="ctx-meter">
            <div className="ctx-bar">
              <div className="ctx-fill" style={{ width: `${pct}%`, background: fill }} />
            </div>
            <span>context (est.) {ctx == null ? "—" : `~${fmtK(ctx)} / ${fmtK(window)}`}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {usage ? (
            <div className="flex flex-col gap-0.5 font-mono text-xs">
              <span>input: {fmtK(usage.input_tokens)}</span>
              <span>cache read: {fmtK(usage.cache_read_input_tokens)}</span>
              <span>cache write: {fmtK(usage.cache_creation_input_tokens)}</span>
              <span>output: {fmtK(usage.output_tokens)}</span>
            </div>
          ) : (
            <span>No usage reported yet — send a turn.</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
