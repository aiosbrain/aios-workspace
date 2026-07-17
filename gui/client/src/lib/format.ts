import type { Usage } from "../types/protocol";

/** Compact token count: 1500 → "1.5k", 42000 → "42k". */
export function fmtK(n: number | undefined | null): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
}

/** USD with adaptive precision: <$0.10 → 4dp, else 2dp. */
export function fmtUsd(n: number): string {
  return `$${Number(n).toFixed(n < 0.1 ? 4 : 2)}`;
}

/** Compact snapshot age for the analysis-cache freshness indicator: "12s" / "5m" / "2h". */
export function fmtAge(ageMs: number): string {
  const s = Math.max(0, Math.round(Number(ageMs) / 1000)) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/**
 * The "turn done" meta line, shared by the live stream and transcript replay so they
 * read identically. `cost_usd` may be cumulative across a session — show a per-turn
 * delta when it clearly is (prevCost>0, non-negative), else treat it as the turn's cost.
 * Cost is only included when the runtime reports it (number), so cost-less runtimes
 * degrade naturally.
 */
export function formatResultMeta(
  usage: Usage | null | undefined,
  cost_usd: number | null | undefined,
  prevCost: number
): string {
  const parts: string[] = [];
  if (usage) {
    parts.push(`${fmtK(usage.input_tokens || 0)} in / ${fmtK(usage.output_tokens || 0)} out`);
  }
  if (typeof cost_usd === "number") {
    const delta = cost_usd - prevCost;
    parts.push(
      prevCost > 0 && delta >= 0
        ? `+${fmtUsd(delta)} (session ${fmtUsd(cost_usd)})`
        : fmtUsd(cost_usd)
    );
  }
  return `turn done${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}
