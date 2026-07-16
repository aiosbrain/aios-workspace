import { useCallback, useEffect, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { Freshness } from "../ui/freshness";
import { cn } from "../../lib/cn";
import { buildTrendSeries } from "../../lib/maturity";
import type { MaturityResponse } from "../../types/protocol";

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const PANEL = "flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4";
const CARD = "rounded-lg border border-border-visible bg-secondary/40 px-4 py-3";

/** SHADOW badge — CE never syncs, is uncalibrated, and lives only on this machine. */
function ShadowBadge() {
  return (
    <span className="rounded-full border border-border-visible bg-secondary px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
      shadow · uncalibrated · local-only
    </span>
  );
}

const pt = (p: { x: number; y: number }) => `${p.x},${p.y}`;

/** Agentic Maturity panel: 5 AM axis bars, a CE shadow card, a 30-day trend, and tips. */
export function MaturityPanel() {
  const { api } = useConnection();
  const [plan, setPlan] = useState<MaturityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const data = await api.get<MaturityResponse>("/api/maturity");
      setPlan(data);
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
    if (!plan?.refreshing) return;
    const t = window.setTimeout(load, 2500);
    return () => window.clearTimeout(t);
  }, [plan, load]);

  // Full-panel error only before the first data lands — after that the last-good
  // content stays visible and failures surface via the Freshness indicator.
  if (error && !plan)
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
  if (!plan)
    return (
      <div className={PANEL}>
        <Skeleton className="mb-3 h-8 w-full rounded-md" />
        <Skeleton className="mb-2 h-6 w-3/4 rounded-md" />
        <Skeleton className="mb-2 h-6 w-2/3 rounded-md" />
        <Skeleton className="h-6 w-1/2 rounded-md" />
      </div>
    );

  const trend = buildTrendSeries(plan.days);
  const ceLabel = plan.ce_band === null ? "Uncalibrated" : `${plan.ce_band} / 4`;

  return (
    <div className={PANEL}>
      {/* (a) header */}
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          Spine {plan.spine ?? "—"} · overall {plan.overall === null ? "—" : `${plan.overall} / 4`}
          {plan.window && (
            <>
              {" "}
              · {plan.window.since} → {plan.window.until}
            </>
          )}
        </span>
        <span className="flex items-center gap-3">
          <Freshness meta={plan} busy={busy} />
          <button className={REV_BTN} onClick={load} disabled={busy}>
            Refresh
          </button>
        </span>
      </div>
      {error && <div className="text-[11px] text-destructive">refresh failed: {error}</div>}

      {/* (b) 5 AM axis bars */}
      <div className="flex flex-col gap-2.5">
        {plan.axes.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No maturity signals yet — do some agent work, then refresh.
          </div>
        ) : (
          plan.axes.map((a) => (
            <div key={a.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="font-medium text-foreground">{a.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{a.score} / 4</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-violet"
                  style={{ width: `${(Math.max(0, Math.min(4, a.score)) / 4) * 100}%` }}
                />
              </div>
              <span className="text-[11px] text-muted-foreground">{a.gloss}</span>
            </div>
          ))
        )}
      </div>

      {/* (c) CE shadow card */}
      <div className={cn(CARD, "bg-secondary text-muted-foreground")}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-foreground">Cognitive Ergonomics</span>
          <ShadowBadge />
        </div>
        <div className="font-mono text-[13px] text-lime">{ceLabel}</div>
        {plan.ce_band === null ? (
          <p className="mt-1 text-[11px]">
            Baseline needed — run a full analyze cycle to calibrate.
          </p>
        ) : (
          <p className="mt-1 text-[11px]">
            A local read on operating rhythm. It never enters your maturity score and never syncs to
            the brain.
          </p>
        )}
      </div>

      {/* (d) 30-day trend */}
      <div className={CARD}>
        <div className="mb-2 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">30-day trend</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-violet" /> AM (overall)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-lime" /> CE (shadow)
          </span>
        </div>
        <svg
          viewBox={`0 0 ${trend.width} ${trend.height}`}
          className="w-full"
          role="img"
          aria-label="30-day Agentic Maturity and Cognitive Ergonomics trend"
        >
          {/* dotted 0–4 grid + y labels */}
          {trend.gridY.map((y, i) => (
            <g key={i}>
              <line
                x1={24}
                x2={trend.width - 8}
                y1={y}
                y2={y}
                stroke="var(--aios-border-visible)"
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <text x={4} y={y + 3} fontSize={9} fill="var(--aios-fg-muted)">
                {4 - i}
              </text>
            </g>
          ))}
          {/* AM polyline (violet, continuous) */}
          {trend.am.length > 0 && (
            <polyline
              fill="none"
              stroke="var(--aios-violet)"
              strokeWidth={1.5}
              points={trend.am.map(pt).join(" ")}
            />
          )}
          {/* CE polylines (lime, one per contiguous segment → null days are gaps) */}
          {trend.ceSegments.map((seg, i) => (
            <polyline
              key={i}
              fill="none"
              stroke="var(--aios-accent)"
              strokeWidth={1.5}
              points={seg.map(pt).join(" ")}
            />
          ))}
        </svg>
      </div>

      {/* (e) tips card */}
      {(plan.guidance.weakest || plan.guidance.ergonomics_tip) && (
        <div className={cn(CARD, "flex flex-col gap-2")}>
          {plan.guidance.weakest && (
            <div>
              <div className="text-[13px] font-semibold text-foreground">
                Biggest opportunity{plan.weakest ? `: ${plan.weakest}` : ""}
              </div>
              <p className="text-[12px] text-muted-foreground">{plan.guidance.weakest.gloss}</p>
              <p className="mt-1 text-[12px] text-foreground">{plan.guidance.weakest.steps[0]}</p>
            </div>
          )}
          {plan.guidance.ergonomics_tip && (
            <p className="text-[12px] text-muted-foreground">
              <span className="text-lime">Cognitive ergonomics:</span>{" "}
              {plan.guidance.ergonomics_tip}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
