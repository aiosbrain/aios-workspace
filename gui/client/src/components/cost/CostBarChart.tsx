import type { CostProviderActual } from "../../types/protocol";

// Provider colors mirror the Team Brain cost charts so both surfaces read as one system.
const PROVIDER_COLOR: Record<string, string> = {
  claude: "#7c3aed",
  anthropic: "#a78bfa",
  cursor: "#3b82f6",
  codex: "#4ade80",
  opencode: "#f59e0b",
};
const CYCLE = ["#7c3aed", "#3b82f6", "#4ade80", "#f59e0b", "#2dd4bf", "#d946ef"];
export function colorFor(provider: string, i: number): string {
  return PROVIDER_COLOR[provider] ?? CYCLE[i % CYCLE.length];
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Fixed total height — layout never shifts with provider count (AIO-457). */
export const COST_CHART_H = 150;
const AXIS_H = 16;
const PAD_T = 4;

/** Round up to a "nice" axis ceiling (1/2/2.5/5 × power of ten). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

const fmtTick = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * Dependency-free horizontal provider bar chart of ACTUAL month spend.
 * Fixed 150px height regardless of provider count, labeled USD x-axis,
 * tabular figures, and a full text equivalent in the aria-label. Providers
 * whose actual spend is unknown are never drawn (no synthesized bars).
 */
export function CostBarChart({ rows, period }: { rows: CostProviderActual[]; period: string }) {
  const known = rows.filter(
    (r): r is CostProviderActual & { total_usd: number } => r.total_usd != null
  );
  const max = niceCeil(Math.max(1, ...known.map((r) => r.total_usd)));
  const plotH = COST_CHART_H - PAD_T - AXIS_H;
  const slot = plotH / Math.max(1, known.length);
  const barH = Math.max(4, Math.min(12, slot - 13));
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const textEquivalent =
    `Actual spend by provider for ${period}: ` +
    (known.length ? known.map((r) => `${r.label} ${usd(r.total_usd)}`).join(", ") : "none") +
    rows
      .filter((r) => r.total_usd == null)
      .map((r) => `; ${r.label} unknown`)
      .join("");

  return (
    <svg
      width="100%"
      height={COST_CHART_H}
      role="img"
      aria-label={textEquivalent}
      className="tabular-nums"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {/* USD x-axis: gridlines + labels */}
      {ticks.map((f) => (
        <g key={f}>
          <line
            x1={`${f * 100}%`}
            x2={`${f * 100}%`}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="var(--aios-border-visible)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
          <text
            x={`${f * 100}%`}
            y={COST_CHART_H - 4}
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
            fontSize={9}
            fill="var(--aios-muted-foreground, currentColor)"
          >
            {fmtTick(max * f)}
          </text>
        </g>
      ))}
      {known.map((r, i) => {
        const rowTop = PAD_T + slot * i;
        const w = Math.max(0.5, (r.total_usd / max) * 100);
        return (
          <g key={r.provider}>
            <text x={0} y={rowTop + 9} fontSize={10} fill="var(--aios-foreground, currentColor)">
              {r.label}
            </text>
            <text
              x="100%"
              y={rowTop + 9}
              textAnchor="end"
              fontSize={10}
              fill="var(--aios-foreground, currentColor)"
            >
              {usd(r.total_usd)}
            </text>
            <rect
              x={0}
              y={rowTop + 12}
              width={`${w}%`}
              height={barH}
              rx={1.5}
              fill={colorFor(r.provider, i)}
            >
              <title>{`${r.label}: ${usd(r.total_usd)} (${r.status})`}</title>
            </rect>
          </g>
        );
      })}
      {known.length === 0 && (
        <text
          x="50%"
          y={PAD_T + plotH / 2}
          textAnchor="middle"
          fontSize={11}
          fill="var(--aios-muted-foreground, currentColor)"
        >
          No actual spend recorded for {period}.
        </text>
      )}
    </svg>
  );
}
