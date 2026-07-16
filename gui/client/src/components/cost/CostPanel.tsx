import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { Freshness } from "../ui/freshness";
import { cn } from "../../lib/cn";
import type { CostConfigResponse, CostResponse } from "../../types/protocol";
import { CostBarChart, colorFor, usd } from "./CostBarChart";

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const PANEL = "flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4";
const CARD = "rounded-lg border border-border-visible bg-secondary/40 px-4 py-3";
const INPUT =
  "w-24 rounded-[6px] border border-border-visible bg-background px-2 py-1 text-right font-mono text-[12px] tabular-nums text-foreground";

const SOURCE_LABEL: Record<string, string> = {
  config: "owner-entered",
  billing: "billed",
  detected: "detected plan",
  session: "session",
};
const currentPeriod = () => new Date().toISOString().slice(0, 7);

/** null = leave unset; NaN = invalid input. */
function parseUsd(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

const SUB_FIELDS = [
  { key: "claude", label: "Claude subscription" },
  { key: "cursor", label: "Cursor subscription" },
  { key: "codex", label: "Codex subscription" },
] as const;

/** Owner-entered actuals editor — writes .aios/cost-config.json via the server. */
function CostSettings({
  period,
  onSaved,
}: {
  period: string;
  onSaved: () => void | Promise<void>;
}) {
  const { api } = useConnection();
  const [form, setForm] = useState<Record<string, string>>({
    claude: "",
    cursor: "",
    codex: "",
    anthropic: "",
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<CostConfigResponse>("/api/costs/config")
      .then((cfg) => {
        if (!alive) return;
        setForm({
          claude: cfg.subscriptions.claude != null ? String(cfg.subscriptions.claude) : "",
          cursor: cfg.subscriptions.cursor != null ? String(cfg.subscriptions.cursor) : "",
          codex: cfg.subscriptions.codex != null ? String(cfg.subscriptions.codex) : "",
          anthropic:
            cfg.metered.anthropic?.[period] != null ? String(cfg.metered.anthropic[period]) : "",
        });
      })
      .catch((e) => setStatus(`config load failed: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
  }, [api, period]);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setStatus(null);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const save = async () => {
    const parsed: Record<string, number | null> = {};
    for (const key of ["claude", "cursor", "codex", "anthropic"]) {
      const v = parseUsd(form[key]);
      if (Number.isNaN(v)) {
        setStatus(`"${form[key]}" isn't a valid USD amount`);
        return;
      }
      parsed[key] = v;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.post<CostConfigResponse>("/api/costs/config", {
        subscriptions: { claude: parsed.claude, cursor: parsed.cursor, codex: parsed.codex },
        metered: { anthropic: { [period]: parsed.anthropic } },
      });
      if (!res.ok) {
        setStatus((res.errors ?? ["save failed"]).join("; "));
      } else {
        setStatus("saved");
        await onSaved();
      }
    } catch (e) {
      setStatus((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className={CARD}>
      <div className="mb-1 text-[13px] font-semibold text-foreground">Enter exact actuals</div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Owner-entered figures override everything else and live only in{" "}
        <code className="font-mono">.aios/cost-config.json</code> on this machine. Blank = unset
        (falls back to billing, then a detected plan, then honest “unknown”).
      </p>
      <div className="flex flex-col gap-2">
        {SUB_FIELDS.map((f) => (
          <label
            key={f.key}
            className="flex items-center justify-between gap-3 text-[12px] text-foreground"
          >
            <span>
              {f.label} <span className="text-muted-foreground">($/mo)</span>
            </span>
            <input
              className={INPUT}
              inputMode="decimal"
              placeholder="—"
              value={form[f.key]}
              onChange={set(f.key)}
              aria-label={`${f.label} in US dollars per month`}
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-3 text-[12px] text-foreground">
          <span>
            Anthropic API spend <span className="text-muted-foreground">({period}, $)</span>
          </span>
          <input
            className={INPUT}
            inputMode="decimal"
            placeholder="—"
            value={form.anthropic}
            onChange={set("anthropic")}
            aria-label={`Exact Anthropic API spend for ${period} in US dollars`}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className={REV_BTN} onClick={save} disabled={busy}>
          Save
        </button>
        {status && (
          <span
            className={cn(
              "text-[11px]",
              status === "saved" ? "text-muted-foreground" : "text-destructive"
            )}
          >
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

/** Cost panel: ACTUAL spend only — owner config > billing > detected subscription > unknown. */
export function CostPanel() {
  const { api } = useConnection();
  const [data, setData] = useState<CostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
  // Hard cap the loop at ~30s so a server bug can never produce an infinite poll —
  // after that we rely on the next navigation or a manual Refresh.
  const pollDeadline = useRef(0);
  useEffect(() => {
    if (!data?.refreshing) {
      pollDeadline.current = 0;
      return;
    }
    if (!pollDeadline.current) pollDeadline.current = Date.now() + 30_000;
    if (Date.now() > pollDeadline.current) return;
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

  const period = data.period || currentPeriod();
  const unknown = data.by_provider.filter((p) => p.total_usd == null);

  return (
    <div className={PANEL}>
      {/* header — current-month actual total */}
      <div className="flex items-center justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
        <span>
          {period} actual spend {usd(data.totals.month_usd)}
          {unknown.length > 0 && " (+ unknown)"}
        </span>
        <span className="flex items-center gap-3">
          <Freshness meta={data} busy={busy} />
          <button className={REV_BTN} onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? "Close settings" : "Settings"}
          </button>
          <button className={REV_BTN} onClick={load} disabled={busy}>
            Refresh
          </button>
        </span>
      </div>
      {error && <div className="text-[11px] text-destructive">refresh failed: {error}</div>}

      {/* configuration completeness */}
      {!data.config_status.complete && (
        <div className={cn(CARD, "text-[11px] text-muted-foreground")}>
          No actual-spend source for{" "}
          <span className="text-foreground">{data.config_status.unknown.join(", ")}</span> — usage
          was detected, but no owner-entered amount, billing data, or subscription exists. Enter the
          real figure in Settings; nothing is estimated in the meantime.
        </div>
      )}

      {showSettings && <CostSettings period={period} onSaved={load} />}

      {/* actual ledger lines */}
      {data.lines.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No actual spend recorded for {period}. Enter subscriptions or exact metered spend in
          Settings.
        </div>
      ) : (
        <div className={CARD}>
          <div className="mb-2 text-[13px] font-semibold text-foreground">
            Ledger — {period} (actuals only)
          </div>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-muted-foreground">
                <th className="py-1 font-normal">Provider</th>
                <th className="py-1 font-normal">Kind</th>
                <th className="py-1 font-normal">Source</th>
                <th className="py-1 text-right font-normal">USD</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr
                  key={`${l.provider}-${l.kind}-${i}`}
                  className="border-t border-border-visible/60 text-foreground"
                >
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: colorFor(l.provider, i) }}
                      />
                      {l.label}
                    </span>
                  </td>
                  <td className="py-1.5 text-muted-foreground">{l.kind}</td>
                  <td className="py-1.5 text-muted-foreground" title={l.note}>
                    {SOURCE_LABEL[l.source] ?? l.source}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{usd(l.amount_usd)}</td>
                </tr>
              ))}
              <tr className="border-t border-border-visible text-foreground">
                <td className="py-1.5 font-semibold" colSpan={3}>
                  Total
                </td>
                <td className="py-1.5 text-right font-mono font-semibold tabular-nums">
                  {usd(data.totals.month_usd)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* provider chart — fixed height regardless of provider count */}
      <div className={CARD}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">
            Actual spend by provider
          </span>
          <span className="text-[11px] text-muted-foreground">{period}</span>
        </div>
        <CostBarChart rows={data.by_provider} period={period} />
        {unknown.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Not charted (unknown, never estimated): {unknown.map((p) => p.label).join(", ")}
          </p>
        )}
      </div>

      {data.cursor_error && (
        <div className="text-[11px] text-muted-foreground">
          Cursor billing unavailable ({data.cursor_error}) — sign in to Cursor or enter a
          subscription in Settings.
        </div>
      )}
      {data.anthropic_error && (
        <div className="text-[11px] text-muted-foreground">
          Anthropic admin cost report unavailable ({data.anthropic_error}) — enter exact API spend
          in Settings.
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Actual financial spend only — owner-entered figures beat billing APIs, which beat a detected
        subscription; anything else shows as unknown. Token usage is never converted to money here.
      </p>
    </div>
  );
}
