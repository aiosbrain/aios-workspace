import { useCallback, useEffect, useState } from "react";
import { TerminalFrame } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { cn } from "../../lib/cn";
import { LoaderCircle } from "lucide-react";
import type { PushResponse, ReviewItem, ReviewResponse } from "../../types/protocol";

type PushableItem = ReviewItem & { state: "new" | "modified" };

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const REV_BTN_PRIMARY = cn(
  REV_BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)]"
);
const REVIEW = "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";

type Operation = "refresh" | "dry-run" | "sync" | null;

function BusyLabel({ active, children }: { active: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {active && <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Team Brain sync panel: pick eligible files, dry-run, then sync them deliberately. */
export function ReviewPanel() {
  const { api } = useConnection();
  const [plan, setPlan] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [output, setOutput] = useState("");
  const [operation, setOperation] = useState<Operation>(null);

  const load = useCallback(
    async (showBusy = true) => {
      if (showBusy) setOperation("refresh");
      setError(null);
      // Don't clear `output` here: load() also runs as the post-push status refresh,
      // and wiping it would hide the push transcript the user just produced. The next
      // user action (a dry-run/push) clears it via push()'s own setOutput("").
      try {
        const data = await api.get<ReviewResponse>("/api/review");
        setPlan(data);
        // default: select every pushable (new + modified) file
        const all = [...(data.items.new || []), ...(data.items.modified || [])].map((i) => i.rel);
        setSelected(new Set(all));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (showBusy) setOperation(null);
      }
    },
    [api]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (rel: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const push = async (dryRun: boolean) => {
    setOperation(dryRun ? "dry-run" : "sync");
    setOutput("");
    try {
      const data = await api.post<PushResponse>("/api/push", { paths: [...selected], dryRun });
      setOutput(data.output || data.error || "(no output)");
      // Surface the push outcome as a toast (the terminal output keeps the detail).
      if (!dryRun) {
        if (data.ok) {
          toast.success(
            `Synced ${selected.size} item${selected.size === 1 ? "" : "s"} to Team Brain`
          );
          await load(false); // refresh status after a real push without replacing the sync spinner
        } else {
          toast.error(`Team Brain sync failed${data.error ? `: ${data.error}` : ""}`, {
            duration: 10_000,
          });
        }
      }
    } catch (e) {
      setOutput(`error: ${(e as Error).message}`);
      if (!dryRun)
        toast.error(`Team Brain sync failed: ${(e as Error).message}`, { duration: 10_000 });
    }
    setOperation(null);
  };

  if (error)
    return (
      <div className={REVIEW}>
        <div className="self-center bg-transparent p-0.5 text-xs text-destructive">
          error: {error}
        </div>
        <button className={REV_BTN} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  if (!plan)
    return (
      <div className={REVIEW}>
        <Skeleton className="mb-3 h-8 w-full rounded-md" />
        <Skeleton className="mb-2 h-6 w-3/4 rounded-md" />
        <Skeleton className="mb-2 h-6 w-2/3 rounded-md" />
        <Skeleton className="h-6 w-1/2 rounded-md" />
      </div>
    );

  const pushable: PushableItem[] = [
    ...(plan.items.new || []).map((i) => ({ ...i, state: "new" as const })),
    ...(plan.items.modified || []).map((i) => ({ ...i, state: "modified" as const })),
  ];

  const busy = operation !== null;
  const clean = plan.items.clean || [];
  const blocked = plan.items.blocked || [];

  return (
    <div className={REVIEW} aria-busy={busy}>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border-visible bg-background py-2 font-mono text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="font-sans text-sm text-foreground">Team Brain Sync</strong>
          <span className="truncate">
            {plan.project} → {plan.brain_url || "offline"}
          </span>
        </span>
        <span className="flex gap-2">
          <button className={REV_BTN} onClick={() => void load()} disabled={busy}>
            <BusyLabel active={operation === "refresh"}>Refresh</BusyLabel>
          </button>
          <button className={REV_BTN} onClick={() => push(true)} disabled={busy || !selected.size}>
            <BusyLabel active={operation === "dry-run"}>Dry-run</BusyLabel>
          </button>
          <button
            className={REV_BTN_PRIMARY}
            onClick={() => push(false)}
            disabled={busy || !selected.size}
          >
            <BusyLabel active={operation === "sync"}>{`Sync ${selected.size} selected`}</BusyLabel>
          </button>
        </span>
      </div>

      {output && (
        <TerminalFrame
          filename={
            operation === "dry-run" || operation === "sync" ? "Team Brain sync…" : "Team Brain sync"
          }
          status={operation === "dry-run" || operation === "sync" ? "live" : "static"}
          code={output}
        />
      )}

      <section
        className="overflow-hidden rounded-lg border border-border-visible bg-card"
        aria-labelledby="review-needs-review"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-visible px-3 py-2.5">
          <span>
            <h2 id="review-needs-review" className="text-[13px] font-semibold text-foreground">
              Needs review{" "}
              <span className="font-mono text-muted-foreground">({pushable.length})</span>
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Checked items are included in this run. Uncheck anything that should stay local.
            </p>
          </span>
          {pushable.length > 0 && (
            <span className="flex gap-2">
              <button
                type="button"
                className={REV_BTN}
                onClick={() => setSelected(new Set(pushable.map((item) => item.rel)))}
                disabled={busy || selected.size === pushable.length}
              >
                Select all
              </button>
              <button
                type="button"
                className={REV_BTN}
                onClick={() => setSelected(new Set())}
                disabled={busy || selected.size === 0}
              >
                Exclude all
              </button>
            </span>
          )}
        </header>
        {pushable.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing needs review — all eligible files are synced.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
            {pushable.map((i) => (
              <li key={i.rel}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary">
                  <input
                    type="checkbox"
                    checked={selected.has(i.rel)}
                    onChange={() => toggle(i.rel)}
                    disabled={busy}
                  />
                  <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
                    {i.rel}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                    [{i.kind || "unknown"}, {i.tier || "unclassified"}]{" "}
                    {i.state === "new" ? "NEW" : "MOD"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="rounded-lg border border-border-visible bg-card px-3 py-2.5">
        <summary className="cursor-pointer text-xs font-semibold text-foreground">
          Synced <span className="font-mono text-muted-foreground">({clean.length})</span>
        </summary>
        {clean.length ? (
          <div className="mt-2 flex flex-col gap-1 border-t border-border-visible pt-2">
            {clean.map((item) => (
              <div key={item.rel} className="font-mono text-xs text-muted-foreground">
                {item.rel}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No locally clean files reported.</p>
        )}
      </details>

      <details
        className="rounded-lg border border-border-visible bg-card px-3 py-2.5"
        open={blocked.length > 0}
      >
        <summary className="cursor-pointer text-xs font-semibold text-destructive">
          Blocked <span className="font-mono">({blocked.length})</span> — never sync
        </summary>
        {blocked.length ? (
          <div className="mt-2 flex flex-col gap-1 border-t border-border-visible pt-2">
            {blocked.map((item) => (
              <div key={item.rel} className="font-mono text-xs text-muted-foreground">
                {item.rel} — {item.reason}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No files are blocked from sync.</p>
        )}
      </details>
    </div>
  );
}
