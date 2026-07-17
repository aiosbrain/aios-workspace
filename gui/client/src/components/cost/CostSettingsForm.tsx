// Owner-entered actuals form (AIO-457) — the presentational half of the Costs
// Settings surface plus its pure form helpers. Lives apart from CostPanel so it
// has NO cockpit-state dependency and node-env tests can render it directly
// (same pattern as the comms component tests).

import { cn } from "../../lib/cn";
import type { CostConfigResponse } from "../../types/protocol";

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const CARD = "rounded-lg border border-border-visible bg-secondary/40 px-4 py-3";
const INPUT =
  "w-24 rounded-[6px] border border-border-visible bg-background px-2 py-1 text-right font-mono text-[12px] tabular-nums text-foreground disabled:opacity-40";

/** null = leave unset; NaN = invalid input. */
export function parseUsd(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export type CostSettingsFormValues = Record<"claude" | "cursor" | "codex" | "anthropic", string>;

export const EMPTY_FORM: CostSettingsFormValues = {
  claude: "",
  cursor: "",
  codex: "",
  anthropic: "",
};

/** Hydrate the form from the server's editable config (same values the ledger reads). */
export function formFromConfig(cfg: CostConfigResponse, period: string): CostSettingsFormValues {
  const s = (v: number | null | undefined) => (v != null ? String(v) : "");
  return {
    claude: s(cfg.subscriptions.claude),
    cursor: s(cfg.subscriptions.cursor),
    codex: s(cfg.subscriptions.codex),
    anthropic: s(cfg.metered.anthropic?.[period]),
  };
}

/**
 * Build the POST /api/costs/config patch from a HYDRATED form. Only ever called
 * after a successful config GET — a blank field then genuinely means "unset",
 * never "failed to load", so posting null can't wipe unseen state.
 */
export function buildConfigPatch(
  form: CostSettingsFormValues,
  period: string
): { patch: object } | { error: string } {
  const parsed = {} as Record<keyof CostSettingsFormValues, number | null>;
  for (const key of ["claude", "cursor", "codex", "anthropic"] as const) {
    const v = parseUsd(form[key]);
    if (Number.isNaN(v)) return { error: `"${form[key]}" isn't a valid USD amount` };
    parsed[key] = v;
  }
  return {
    patch: {
      subscriptions: { claude: parsed.claude, cursor: parsed.cursor, codex: parsed.codex },
      metered: { anthropic: { [period]: parsed.anthropic } },
    },
  };
}

const SUB_FIELDS = [
  { key: "claude", label: "Claude subscription" },
  { key: "cursor", label: "Cursor subscription" },
  { key: "codex", label: "Codex subscription" },
] as const;

/**
 * Presentational settings form. Until `loaded` is true the fields and Save are
 * disabled — saving an unhydrated (all-blank) form would post explicit nulls
 * and delete the owner's existing config.
 */
export function CostSettingsForm({
  period,
  form,
  loaded,
  loadError,
  status,
  busy,
  onChange,
  onSave,
  onRetry,
}: {
  period: string;
  form: CostSettingsFormValues;
  loaded: boolean;
  loadError: string | null;
  status: string | null;
  busy: boolean;
  onChange: (key: keyof CostSettingsFormValues, value: string) => void;
  onSave: () => void;
  onRetry: () => void;
}) {
  return (
    <div className={CARD}>
      <div className="mb-1 text-[13px] font-semibold text-foreground">Enter exact actuals</div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Owner-entered figures override everything else and live only in{" "}
        <code className="font-mono">.aios/cost-config.json</code> on this machine. Blank = unset
        (falls back to billing, then a detected plan, then honest “unknown”).
      </p>
      {loadError && (
        <p className="mb-3 text-[11px] text-destructive">
          Couldn’t load the current config ({loadError}) — editing is disabled so a save can’t wipe
          your existing entries.{" "}
          <button className="underline" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
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
              disabled={!loaded}
              value={form[f.key]}
              onChange={(e) => onChange(f.key, e.target.value)}
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
            disabled={!loaded}
            value={form.anthropic}
            onChange={(e) => onChange("anthropic", e.target.value)}
            aria-label={`Exact Anthropic API spend for ${period} in US dollars`}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className={REV_BTN} onClick={onSave} disabled={busy || !loaded}>
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
