import { useCallback, useEffect, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { Freshness } from "../ui/freshness";
import { cn } from "../../lib/cn";
import type { CostResponse, CostSpendDay, CostTokenDay } from "../../types/protocol";

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const PANEL = "flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4";
const CARD = "rounded-lg border border-border-visible bg-secondary/40 px-4 py-3";

// Provider colors mirror the Team Brain cost charts so both surfaces read as one system.
const PROVIDER_COLOR: Record<string, string> = {
  claude: "#7c3aed",
  cursor: "#3b82f6",
  codex: "#4ade80",
  opencode: "#f59e0b",
};
const CYCLE = ["#7c3aed", "#3b82f6", "#4ade80", "#f59e0b", "#2dd4bf", "#d946ef"];
function colorFor(provider: string, i: number): string {
  return PROVIDER_COLOR[provider] ?? CYCLE[i % CYCLE.length];
}
const TOKEN_COLOR = { input: "#3b82f6", output: "#7c3aed", cache_read: "#2dd4bf" };

const usd = (n: number) => `$${n.toFixed(2)}`;

const CHART_H = 150;
const PAD_T = 8;
const PAD_B = 18;

/** A dependency-free stacked vertical bar chart (matches the GUI's hand-rolled SVG style). */
function StackedBars<T extends { date: string }>({
  rows,
  series,
  colorOf,
  label,
}: {
  rows: T[];
  series: string[];
  colorOf: (key: string, i: number) => string;
  label: string;
}) {
  const totals = rows.map((r) => series.reduce((s, k) => s + Number(r[k as keyof T] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const step = 100 / Math.max(1, rows.length);
  const barW = Math.min(step * 0.7, 4);
  const plotH = CHART_H - PAD_T - PAD_B;

  return (
    <svg
      viewBox={`0 0 100 ${CHART_H}`}
      className="w-full"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = PAD_T + plotH * f;
        return (
          <line
            key={i}
            x1={0}
            x2={100}
            y1={y}
            y2={y}
            stroke="var(--aios-border-visible)"
            strokeWidth={0.3}
            strokeDasharray="0.6 0.9"
          />
        );
      })}
      {rows.map((r, ri) => {
        const cx = step * ri + step / 2;
        let yTop = PAD_T + plotH;
        return (
          <g key={r.date}>
            {series.map((k, si) => {
              const v = Number(r[k as keyof T] ?? 0);
              if (v <= 0) return null;
              const h = (v / max) * plotH;
              yTop -= h;
              return (
                <rect
                  key={k}
                  x={cx - barW / 2}
                  y={yTop}
                  width={barW}
                  height={h}
                  fill={colorOf(k, si)}
                >
                  <title>{`${r.date} · ${k}: ${v.toLocaleString("en-US")}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Cost panel: this-workspace spend across all four providers (Cursor billed; others estimate/session). */
export function CostPanel() {
  const { api } = useConnection();
  const [data, setData] = useState<CostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setData(await api.get<CostResponse>("/api/costs"));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // Stale-while-revalidate: while the server refreshes in the background, poll for
  // the fresh snapshot (each poll is a warm cache hit; stops once refreshing clears).
  useEffect(() => {
    if (!data?.refreshing) return;
    const t = window.setTimeout(load, 2500);
    return () => window.clearTimeout(t);
  }, [data, load]);

  // Full-panel error only before the first data lands — after that the last-good
  // content stays visible and failures surface via the Freshness indicator.
  if (error && !data)
    return (
      <div className={PANEL}>
        <div className="self-center bg-transparent p-0.5 text-xs text-destructive">
          error: {error}
        </div>
        <button className={cn(REV_BTN, "self-center")} onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!data)
    return (
      <div className={PANEL}>
        <Skeleton className="mb-3 h-8 w-full rounded-md" />
        <Skeleton className="mb-2 h-24 w-full rounded-md" />
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    );

  const spend: CostSpendDay[] = data.spendByDay ?? [];
  const tokens: CostTokenDay[] = data.tokensByDay ?? [];
  const hasSpend = spend.length > 0 && data.providers.length > 0;
  const hasTokens = tokens.some((t) => t.input || t.output || t.cache_read);

  return (
    <div className={PANEL}>
      {/* header */}
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          Total {usd(data.totals.cost_usd)}
          {data.window && (
            <>
              {" "}
              · {data.window.since} → {data.window.until}
            </>
          )}
        </span>
        <span className="flex items-center gap-3">
          <Freshness meta={data} busy={busy} />
          <button className={REV_BTN} onClick={load} disabled={busy}>
            Refresh
          </button>
        </span>
      </div>
      {error && <div className="text-[11px] text-destructive">refresh failed: {error}</div>}

      {/* flat subscription (real spend, not per-token) */}
      {data.plan?.monthly_usd != null && (
        <div className={CARD}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-foreground">
              Claude {data.plan.label}
              <span className="ml-1.5 font-normal text-muted-foreground">subscription</span>
            </span>
            <span className="font-mono text-foreground">
              ${data.plan.monthly_usd.toFixed(0)}/mo
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Flat fee — the estimates below are API-equivalent value, not this bill.
            {data.plan.source === "keychain" &&
              " Plan detected from login; override in .aios/cost-config.json if wrong."}
          </p>
        </div>
      )}

      {/* per-provider tiles with provenance */}
      {data.by_provider.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No provider spend yet — do some agent work, then refresh.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.by_provider.map((p, i) => (
            <div key={p.provider} className={CARD}>
              <div className="mb-1 flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: colorFor(p.provider, i) }}
                />
                <span className="text-[13px] font-semibold text-foreground">{p.label}</span>
              </div>
              <div className="font-mono text-lg text-foreground">
                {p.estimated ? "~" : ""}
                {usd(p.cost_usd)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {p.events} {p.source === "billing" ? "events" : "turns"} ·{" "}
                {p.source === "billing" ? "billed" : p.source === "session" ? "session" : "est."}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.cursor_error && (
        <div className="text-[11px] text-muted-foreground">
          Cursor billing unavailable ({data.cursor_error}) — sign in to Cursor to include it.
        </div>
      )}

      {/* daily spend, stacked by provider */}
      <div className={CARD}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">Daily spend by provider</span>
          <Legend
            items={data.providers.map((p, i) => ({ key: p, label: p, color: colorFor(p, i) }))}
          />
        </div>
        {hasSpend ? (
          <StackedBars
            rows={spend}
            series={data.providers}
            colorOf={colorFor}
            label="Daily spend by provider"
          />
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No spend in this window.
          </div>
        )}
      </div>

      {/* daily tokens, stacked by kind */}
      <div className={CARD}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">Daily tokens</span>
          <Legend
            items={[
              { key: "input", label: "Input", color: TOKEN_COLOR.input },
              { key: "output", label: "Output", color: TOKEN_COLOR.output },
              { key: "cache_read", label: "Cache read", color: TOKEN_COLOR.cache_read },
            ]}
          />
        </div>
        {hasTokens ? (
          <StackedBars
            rows={tokens}
            series={["input", "output", "cache_read"]}
            colorOf={(k) => TOKEN_COLOR[k as keyof typeof TOKEN_COLOR]}
            label="Daily tokens by kind"
          />
        ) : (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No token activity in this window.
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        This workspace only. Cursor is authoritative billing; Claude and Codex are token estimates;
        Opencode is per-message session cost. Push to the brain with{" "}
        <code className="font-mono">aios analyze --push</code> to see team totals.
      </p>
    </div>
  );
}
