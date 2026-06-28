import { useCallback, useEffect, useState } from "react";
import { TerminalFrame } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import type { PushResponse, ReviewItem, ReviewResponse } from "../../types/protocol";

type PushableItem = ReviewItem & { state: "new" | "modified" };

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
      <div className="review">
        <div className="msg meta error">error: {error}</div>
        <button className="rev-btn" onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!plan)
    return (
      <div className="review">
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
    <div className="review">
      <div className="rev-head">
        <span>
          {plan.project} → {plan.brain_url || "offline"}
        </span>
        <span className="rev-actions">
          <button className="rev-btn" onClick={load} disabled={busy}>
            Refresh
          </button>
          <button className="rev-btn" onClick={() => push(true)} disabled={busy || !selected.size}>
            Dry-run
          </button>
          <button
            className="rev-btn primary"
            onClick={() => push(false)}
            disabled={busy || !selected.size}
          >
            Push {selected.size} selected
          </button>
        </span>
      </div>

      {pushable.length === 0 ? (
        <div className="empty">
          <p>Nothing to push — all eligible files are clean.</p>
        </div>
      ) : (
        <ul className="rev-list">
          {pushable.map((i) => (
            <li key={i.rel} className="rev-item">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(i.rel)}
                  onChange={() => toggle(i.rel)}
                />
                <span className="rev-path">{i.rel}</span>
                <span className="rev-tags">
                  [{i.kind}, {i.tier}] {i.state === "new" ? "NEW" : "MOD"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {(plan.items.blocked?.length ?? 0) > 0 && (
        <div className="rev-blocked">
          <div className="rev-blocked-head">
            blocked ({plan.items.blocked!.length}) — never sync
          </div>
          {plan.items.blocked!.map((b) => (
            <div key={b.rel} className="rev-blocked-item">
              {b.rel} — {b.reason}
            </div>
          ))}
        </div>
      )}

      <div className="rev-clean">clean (already synced): {plan.items.clean?.length || 0}</div>
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
