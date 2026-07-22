import { useState } from "react";
import { LoaderCircle, MailSearch } from "lucide-react";
import { useConnection } from "../../state/cockpit";
import { cn } from "../../lib/cn";
import type { CostConfigResponse, CostEmailScanResponse } from "../../types/protocol";
import { buildInvoiceImportPatch, rowsFromScan, type InvoiceImportRow } from "./cost-email-import";

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const INPUT =
  "w-20 rounded-[6px] border border-border-visible bg-background px-2 py-1 text-right font-mono text-[12px] tabular-nums text-foreground disabled:opacity-40";

export function CostEmailImport({
  period,
  onImported,
}: {
  period: string;
  onImported: () => void | Promise<void>;
}) {
  const { api } = useConnection();
  const [scan, setScan] = useState<CostEmailScanResponse | null>(null);
  const [rows, setRows] = useState<InvoiceImportRow[]>([]);
  const [busy, setBusy] = useState<"scan" | "save" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const scanGmail = async () => {
    setBusy("scan");
    setStatus(null);
    try {
      const result = await api.post<CostEmailScanResponse>("/api/costs/email-scan", { period });
      setScan(result);
      setRows(rowsFromScan(result.candidates));
      if (!result.accounts.length) setStatus("No Gmail account is configured in gog yet.");
    } catch (error) {
      setStatus((error as Error).message);
    }
    setBusy(null);
  };

  const saveSelected = async () => {
    const built = buildInvoiceImportPatch(rows, period);
    if ("error" in built) {
      setStatus(built.error);
      return;
    }
    setBusy("save");
    setStatus(null);
    try {
      const result = await api.post<CostConfigResponse>("/api/costs/config", built.patch);
      if (!result.ok) setStatus((result.errors ?? ["save failed"]).join("; "));
      else {
        setStatus("Selected invoice actuals saved");
        await onImported();
      }
    } catch (error) {
      setStatus((error as Error).message);
    }
    setBusy(null);
  };

  const updateRow = (id: string, patch: Partial<InvoiceImportRow>) => {
    setStatus(null);
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="rounded-lg border border-border-visible bg-secondary/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-foreground">Find provider invoices</div>
          <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">
            Read-only Gmail metadata scan via gog for {period}. Email bodies and attachments stay
            out of the GUI. Nothing is recorded until you select and save a candidate.
          </p>
        </div>
        <button className={REV_BTN} onClick={scanGmail} disabled={busy != null}>
          <span className="flex items-center gap-1.5">
            {busy === "scan" ? (
              <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <MailSearch size={14} aria-hidden="true" />
            )}
            {busy === "scan" ? "Scanning…" : "Scan Gmail"}
          </span>
        </button>
      </div>

      {scan && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[11px] text-muted-foreground">
            Accounts: {scan.accounts.length ? scan.accounts.join(", ") : "none"}. Connect another
            mailbox in gog, then scan again to include it.
          </div>
          {rows.length === 0 ? (
            <div className="rounded-md border border-border-visible px-3 py-2 text-[12px] text-muted-foreground">
              No verified provider invoice emails found for {period}. You can still enter exact
              figures above.
            </div>
          ) : (
            rows.map((row) => (
              <label
                key={row.id}
                className={cn(
                  "grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-3 py-2",
                  row.selected
                    ? "border-[var(--accent-line)] bg-[var(--accent-soft)]"
                    : "border-border-visible bg-background/40"
                )}
              >
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={(event) => updateRow(row.id, { selected: event.target.checked })}
                  aria-label={`Import ${row.label} invoice from ${row.date}`}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-foreground">
                    <span className="font-medium">{row.label}</span>
                    <span className="text-muted-foreground">{row.kind}</span>
                    <span className="text-muted-foreground">{row.date}</span>
                  </span>
                  <span
                    className="block truncate text-[11px] text-muted-foreground"
                    title={row.subject}
                  >
                    {row.subject} · {row.account}
                  </span>
                </span>
                <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
                  $
                  <input
                    className={INPUT}
                    inputMode="decimal"
                    value={row.amount}
                    placeholder="amount"
                    onChange={(event) => updateRow(row.id, { amount: event.target.value })}
                    aria-label={`${row.label} invoice amount in US dollars`}
                  />
                </span>
              </label>
            ))
          )}
          {scan.warnings.map((warning) => (
            <div key={warning} className="text-[11px] text-amber-500">
              {warning}
            </div>
          ))}
          {rows.length > 0 && (
            <div className="flex items-center gap-3">
              <button className={REV_BTN} onClick={saveSelected} disabled={busy != null}>
                {busy === "save" ? "Saving…" : "Save selected actuals"}
              </button>
              <span className="text-[11px] text-muted-foreground">
                Metered charges from the same provider are summed for {period}.
              </span>
            </div>
          )}
        </div>
      )}
      {status && (
        <div
          className={cn(
            "mt-2 text-[11px]",
            status.includes("saved") ? "text-muted-foreground" : "text-destructive"
          )}
          role="status"
        >
          {status}
        </div>
      )}
    </div>
  );
}
