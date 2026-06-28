import { useCallback, useEffect, useState } from "react";
import { TerminalFrame } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { cn } from "../../lib/cn";
import type { PushResponse, ReviewItem, ReviewResponse } from "../../types/protocol";

type PushableItem = ReviewItem & { state: "new" | "modified" };

const REV_BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const REV_BTN_PRIMARY = cn(
  REV_BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-violet)]",
);
const REVIEW = "flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";

/** Review-and-push panel: pick eligible files, dry-run, then push to the team brain. */
export function ReviewPanel() {
  const { api } = useConnection();
  const [plan, setPlan] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
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
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (rel: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const push = async (dryRun: boolean) => {
    setBusy(true);
    setOutput("");
    try {
      const data = await api.post<PushResponse>("/api/push", { paths: [...selected], dryRun });
      setOutput(data.output || data.error || "(no output)");
      // Surface the push outcome as a toast (the terminal output keeps the detail).
      if (!dryRun) {
        if (data.ok) {
          toast.success(
            `Pushed ${selected.size} item${selected.size === 1 ? "" : "s"} to the brain`
          );
          load(); // refresh status after a real push
        } else {
          toast.error(`Push failed${data.error ? `: ${data.error}` : ""}`, { duration: 10_000 });
        }
      }
    } catch (e) {
      setOutput(`error: ${(e as Error).message}`);
      if (!dryRun) toast.error(`Push failed: ${(e as Error).message}`, { duration: 10_000 });
    }
    setBusy(false);
  };

  if (error)
    return (
      <div className={REVIEW}>
        <div className="self-center bg-transparent p-0.5 text-xs text-destructive">
          error: {error}
        </div>
        <button className={REV_BTN} onClick={load}>
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

  return (
    <div className={REVIEW}>
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span>
          {plan.project} → {plan.brain_url || "offline"}
        </span>
        <span className="flex gap-2">
          <button className={REV_BTN} onClick={load} disabled={busy}>
            Refresh
          </button>
          <button className={REV_BTN} onClick={() => push(true)} disabled={busy || !selected.size}>
            Dry-run
          </button>
          <button
            className={REV_BTN_PRIMARY}
            onClick={() => push(false)}
            disabled={busy || !selected.size}
          >
            Push {selected.size} selected
          </button>
        </span>
      </div>

      {pushable.length === 0 ? (
        <div className="m-auto flex max-w-[440px] flex-col items-center gap-3.5 text-center text-muted-foreground">
          <p>Nothing to push — all eligible files are clean.</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {pushable.map((i) => (
            <li key={i.rel}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-secondary">
                <input
                  type="checkbox"
                  checked={selected.has(i.rel)}
                  onChange={() => toggle(i.rel)}
                />
                <span className="font-mono text-[13px] text-foreground">{i.rel}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  [{i.kind}, {i.tier}] {i.state === "new" ? "NEW" : "MOD"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {(plan.items.blocked?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-border-visible px-3 py-2.5">
          <div className="mb-1 text-xs font-semibold text-destructive">
            blocked ({plan.items.blocked!.length}) — never sync
          </div>
          {plan.items.blocked!.map((b) => (
            <div key={b.rel} className="font-mono text-xs text-muted-foreground">
              {b.rel} — {b.reason}
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        clean (already synced): {plan.items.clean?.length || 0}
      </div>
      {output && (
        <TerminalFrame
          filename={busy ? "aios push…" : "aios push"}
          status={busy ? "live" : "static"}
          code={output}
          className="mt-4"
        />
      )}
    </div>
  );
}
