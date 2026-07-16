import type { AnalysisCacheMeta } from "../../types/protocol";
import { fmtAge } from "../../lib/format";

/**
 * Subtle "updated Xs ago / refreshing" indicator for panels served by the shared
 * 30-day analysis cache (AIO-453). When the last background refresh failed the
 * snapshot is labeled stale and the error is exposed in the tooltip — the panel
 * keeps rendering the last-good data underneath.
 */
export function Freshness({ meta, busy }: { meta: AnalysisCacheMeta; busy?: boolean }) {
  if (meta.ageMs == null) return null;
  return (
    <span
      className="font-mono text-[10px] text-muted-foreground"
      title={meta.lastError ? `last refresh failed: ${meta.lastError}` : undefined}
    >
      updated {fmtAge(meta.ageMs)} ago
      {(busy || meta.refreshing) && <> · refreshing…</>}
      {meta.lastError && <span className="text-destructive"> · stale</span>}
    </span>
  );
}
