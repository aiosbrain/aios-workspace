import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { MarkdownBlock } from "../ui/MarkdownBlock";
import { cn } from "../../lib/cn";
import { TodayView } from "./TodayView";
import type {
  LoopCadence,
  LoopMetrics,
  MetricResult,
  RunManifest,
  WeeklyCloseoutResponse,
} from "../../types/protocol";

/**
 * Operator Loop panel (AIO-318). One action surface plus three audit surfaces over the loop CLI:
 *   • Today     — the ranked action queue (see TodayView): C4 orientation folded into one list
 *                 where each row can be resolved, completed, or handed to the agent
 *   • Signals   — C1 run manifest for a cadence (GET /api/loop/collect)
 *   • Weekly    — C5 closeout: run the offline drafter, render the owner brief (POST /api/loop/weekly)
 *   • Telemetry — C8 dogfood metrics (GET /api/loop/telemetry)
 *
 * Writes are limited to the two the operator needs to clear a row — `POST /api/asks/resolve` and
 * the existing `POST /api/tasks/edit`, both wrapping the same CLI the terminal uses. Writeback
 * (C6) and remote/LLM drafting remain CLI-only consent actions. All calls are request/response.
 */

const WRAP = "flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";
const BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const BTN_PRIMARY = cn(
  BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)]"
);
/**
 * Today is the operator surface; the rest are audit surfaces over the same pipeline.
 *
 * "Daily" and "Collect" were peer tabs showing the same signals at two pipeline stages (C4
 * classified vs C1 raw), which read as two competing to-do lists. Grouping makes the hierarchy
 * explicit: you WORK in Today, you INSPECT in the audit group. `hint` is rendered inline in each
 * audit view so a tab never has to be explained by someone who already knows the pipeline.
 */
const TABS: { key: LoopTab; label: string; group: "act" | "audit"; hint?: string }[] = [
  { key: "today", label: "Today", group: "act" },
  {
    key: "collect",
    label: "Signals",
    group: "audit",
    hint: "C1 — every signal collected for the window, before any classification. The raw input Today is built from.",
  },
  {
    key: "weekly",
    label: "Weekly closeout",
    group: "audit",
    hint: "C5 — drafts the owner brief and per-audience digests from this week's signals. Runs offline; no network egress.",
  },
  {
    key: "telemetry",
    label: "Telemetry",
    group: "audit",
    hint: "C8 — is the loop itself healthy? Each metric is a habit target, not a performance score.",
  },
];
type LoopTab = "today" | "collect" | "weekly" | "telemetry";

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

/** The one-line "what am I looking at" note above each audit view. */
function TabHint({ tab }: { tab: LoopTab }) {
  const hint = TABS.find((t) => t.key === tab)?.hint;
  if (!hint) return null;
  return (
    <p className="-mt-1 max-w-[64ch] text-[12px] leading-relaxed text-muted-foreground">{hint}</p>
  );
}

export function LoopPanel() {
  const [tab, setTab] = useState<LoopTab>("today");
  const act = TABS.filter((t) => t.group === "act");
  const audit = TABS.filter((t) => t.group === "audit");
  const tabButton = (t: (typeof TABS)[number]) => (
    <button
      key={t.key}
      className={cn(
        "rounded-[8px] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
        tab === t.key && "bg-[var(--accent-soft)] text-foreground"
      )}
      aria-current={tab === t.key ? "page" : undefined}
      onClick={() => setTab(t.key)}
    >
      {t.label}
    </button>
  );

  return (
    <div className={WRAP}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border-visible pb-2">
        {act.map(tabButton)}
        <span
          className="mx-2 h-4 w-px shrink-0 bg-border-visible"
          role="separator"
          aria-orientation="vertical"
        />
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
          Audit
        </span>
        {audit.map(tabButton)}
      </div>
      <TabHint tab={tab} />
      {tab === "today" && <TodayView />}
      {tab === "collect" && <CollectView />}
      {tab === "weekly" && <WeeklyView />}
      {tab === "telemetry" && <TelemetryView />}
    </div>
  );
}
