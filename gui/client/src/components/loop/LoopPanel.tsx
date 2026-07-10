import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { MarkdownBlock } from "../ui/MarkdownBlock";
import { cn } from "../../lib/cn";
import type {
  DailyItem,
  DailyOrientation,
  LoopCadence,
  LoopMetrics,
  MetricResult,
  RunManifest,
  WeeklyCloseoutResponse,
} from "../../types/protocol";

/**
 * Operator Loop panel (AIO-318). Four read/run surfaces over the loop CLI:
 *   • Daily     — C4 orientation: what's blocked / owed / changed today (GET /api/loop/daily)
 *   • Collect   — C1 run manifest for a cadence (GET /api/loop/collect)
 *   • Weekly    — C5 closeout: run the offline drafter, render the owner brief (POST /api/loop/weekly)
 *   • Telemetry — C8 dogfood metrics (GET /api/loop/telemetry)
 * Writeback (C6) and remote/LLM drafting stay CLI-only. All calls are buffered request/response.
 */

const WRAP = "flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";
const BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const BTN_PRIMARY = cn(
  BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)]"
);
const TABS: { key: LoopTab; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "collect", label: "Collect" },
  { key: "weekly", label: "Weekly closeout" },
  { key: "telemetry", label: "Telemetry" },
];
type LoopTab = "daily" | "collect" | "weekly" | "telemetry";

function TierBadge({ tier }: { tier: string }) {
  return <span className="ml-auto font-mono text-[11px] text-muted-foreground">[{tier}]</span>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="self-start text-xs text-destructive">error: {message}</div>
      {onRetry && (
        <button className={BTN} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-3/4 rounded-md" />
      <Skeleton className="h-6 w-2/3 rounded-md" />
      <Skeleton className="h-6 w-1/2 rounded-md" />
    </div>
  );
}

function ExitCodeWarning({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))] px-3 py-2 text-xs text-destructive">
      <AlertTriangle size={14} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/* ── Daily (C4) ── */

function DailyItemRow({ item }: { item: DailyItem }) {
  const annot =
    item.stale != null
      ? `${item.stale}d stale`
      : item.due
        ? `due ${item.due}`
        : item.changeType
          ? item.changeType
          : null;
  return (
    <li className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary">
      <span className="font-mono text-[11px] uppercase text-muted-foreground">{item.kind}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{item.summary}</span>
      {annot && <span className="font-mono text-[11px] text-muted-foreground">{annot}</span>}
      <TierBadge tier={item.tier} />
    </li>
  );
}

function DailySection({ title, items }: { title: string; items: DailyItem[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-1 pb-0.5 font-mono text-[11px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
        {title} ({items.length})
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((it, i) => (
          <DailyItemRow key={`${it.ref.path}:${it.ref.row ?? i}`} item={it} />
        ))}
      </ul>
    </div>
  );
}

function DailyView() {
  const { api } = useConnection();
  const [data, setData] = useState<DailyOrientation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await api.get<DailyOrientation>("/api/loop/daily"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingRows />;

  const empty =
    !data.attention.length &&
    !data.blocked.length &&
    !data.owedToday.length &&
    !data.changed.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          {data.member} · {data.window.from.slice(0, 10)} → {data.window.to.slice(0, 10)}
        </span>
        <button className={BTN} onClick={load}>
          Refresh
        </button>
      </div>
      {empty ? (
        <div className="m-auto max-w-[440px] py-8 text-center text-muted-foreground">
          Nothing blocked, owed, or changed today.
        </div>
      ) : (
        <>
          <DailySection title="Attention" items={data.attention} />
          <DailySection title="Blocked" items={data.blocked} />
          <DailySection title="Owed today" items={data.owedToday} />
          <DailySection title="Changed" items={data.changed} />
        </>
      )}
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        counts — attention {data.counts.attention} · blocked {data.counts.blocked} · owed{" "}
        {data.counts.owedToday} · changed {data.counts.changed} · excluded {data.counts.excluded}
      </div>
    </div>
  );
}

/* ── Collect (C1) ── */

function CollectView() {
  const { api } = useConnection();
  const [cadence, setCadence] = useState<LoopCadence>("weekly");
  const [data, setData] = useState<RunManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (c: LoopCadence) => {
      setError(null);
      setData(null);
      try {
        setData(await api.get<RunManifest>(`/api/loop/collect?cadence=${c}`));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [api]
  );

  useEffect(() => {
    load(cadence);
  }, [load, cadence]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {(["daily", "weekly"] as LoopCadence[]).map((c) => (
          <button
            key={c}
            className={cn(
              BTN,
              cadence === c && "border-[var(--accent-line)] bg-[var(--accent-soft)]"
            )}
            onClick={() => setCadence(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => load(cadence)} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <>
          <div className="font-mono text-xs text-muted-foreground">
            {data.member} / {data.project} · {data.window.from.slice(0, 10)} →{" "}
            {data.window.to.slice(0, 10)} · {data.signals.length} signals · {data.excluded.length}{" "}
            excluded
          </div>
          {data.signals.length === 0 ? (
            <div className="m-auto max-w-[440px] py-8 text-center text-muted-foreground">
              No signals collected for this window.
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {data.signals.map((s, i) => (
                <li
                  key={`${s.ref.path}:${s.ref.row ?? i}`}
                  className="flex items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary"
                >
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {s.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {s.summary}
                  </span>
                  <TierBadge tier={s.tier} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/* ── Weekly closeout (C5) ── */

function WeeklyView() {
  const { api } = useConnection();
  const [data, setData] = useState<WeeklyCloseoutResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.post<WeeklyCloseoutResponse>("/api/loop/weekly", {});
      setData(res);
      if (res.cliExitCode === 1) {
        toast.warning("Closeout drafted, but an audience is not shippable");
      } else {
        toast.success("Weekly closeout drafted");
      }
    } catch (e) {
      toast.error(`Closeout failed: ${(e as Error).message}`, { duration: 10_000 });
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          Runs the offline drafter locally — no network egress.
        </span>
        <button className={BTN_PRIMARY} onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run closeout"}
        </button>
      </div>

      {!data ? (
        busy ? (
          <LoadingRows />
        ) : (
          <div className="m-auto max-w-[440px] py-8 text-center text-muted-foreground">
            Run a weekly closeout to draft the owner brief and per-audience digests.
          </div>
        )
      ) : (
        <>
          {data.cliExitCode === 1 && (
            <ExitCodeWarning text="At least one audience digest is not shippable — review before sharing." />
          )}
          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
            <span>run {data.runStamp}</span>
            {data.audiences.map((a) => (
              <span
                key={a.audience}
                className={cn(
                  "rounded-sm border border-border-visible px-1.5 py-px",
                  a.shippable ? "text-foreground" : "text-destructive"
                )}
              >
                {a.audience}: {a.status}
              </span>
            ))}
          </div>
          <div className="assistant-prose rounded-xl border border-border-visible bg-card px-3.5 py-2.5">
            <MarkdownBlock>{data.briefMarkdown}</MarkdownBlock>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Telemetry (C8) ── */

function MetricRow({ metric }: { metric: MetricResult }) {
  const met = metric.met;
  const mark = met === true ? "✓" : met === false ? "✗" : "—";
  const markClass =
    met === true ? "text-lime" : met === false ? "text-destructive" : "text-muted-foreground";
  return (
    <li className="flex items-center gap-3 rounded-[8px] px-2 py-1.5 hover:bg-secondary">
      <span className={cn("w-4 shrink-0 text-center font-mono", markClass)}>{mark}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{metric.label}</span>
      <span className="font-mono text-[12px] text-foreground">
        {metric.value ?? "—"}
        <span className="text-muted-foreground"> {metric.unit}</span>
      </span>
      <span className="w-28 text-right font-mono text-[11px] text-muted-foreground">
        {metric.threshold}
      </span>
    </li>
  );
}

function TelemetryView() {
  const { api } = useConnection();
  const [data, setData] = useState<LoopMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await api.get<LoopMetrics>("/api/loop/telemetry"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingRows />;

  const metrics: MetricResult[] = [
    data.tierLeakCount,
    data.weeklyWallClock,
    data.verifierShippableRate,
    data.nextWeekActionAcceptance,
    data.dailyRunFrequency,
    data.consecutiveCleanWeeklies,
  ];

  return (
    <div className="flex flex-col gap-3">
      {data.cliExitCode === 2 && (
        <ExitCodeWarning text="A shipped tier leak was recorded — investigate immediately." />
      )}
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          {data.window.days == null ? "all-time" : `${data.window.days}d`} ·{" "}
          {data.breakdown.weeklyRuns} weekly · {data.breakdown.dailyRuns} daily
        </span>
        <button className={BTN} onClick={load}>
          Refresh
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {metrics.map((m) => (
          <MetricRow key={m.label} metric={m} />
        ))}
      </ul>
    </div>
  );
}

/* ── Panel shell ── */

export function LoopPanel() {
  const [tab, setTab] = useState<LoopTab>("daily");
  return (
    <div className={WRAP}>
      <div className="flex items-center gap-1 border-b border-border-visible pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={cn(
              "rounded-[8px] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
              tab === t.key && "bg-[var(--accent-soft)] text-foreground"
            )}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "daily" && <DailyView />}
      {tab === "collect" && <CollectView />}
      {tab === "weekly" && <WeeklyView />}
      {tab === "telemetry" && <TelemetryView />}
    </div>
  );
}
