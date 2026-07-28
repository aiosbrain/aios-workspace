import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleDot, Clock, MessageCircle, Sparkles } from "lucide-react";
import { useConnection, useSession } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { cn } from "../../lib/cn";
import type { DailyOrientation } from "../../types/protocol";
import {
  askPromptFor,
  buildTodayQueue,
  laneCounts,
  LANE_LABEL,
  type TodayLane,
  type TodayRow,
} from "./today";

/**
 * Today — the Operator Loop's action console.
 *
 * Replaces the read-only C4 dump with a single ranked queue where every row states what it is
 * and offers the one action that clears it: resolve an ask, complete a task, or hand it to the
 * agent. Writes go through the SAME CLI surfaces the terminal uses (`aios asks resolve`,
 * the tasks.md row patch), so acting here and acting in the terminal are the same act.
 *
 * Refresh is deliberately non-destructive: the previous queue stays on screen while the new one
 * loads, and an "updated" stamp proves the fetch happened. Blanking to a skeleton on every poll
 * made a successful refresh indistinguishable from a page reload.
 */

const LANE_TONE: Record<TodayLane, string> = {
  blocker: "border-destructive/45 bg-destructive/10 text-destructive",
  overdue: "border-amber/45 bg-amber/10 text-amber",
  blocked: "border-destructive/30 bg-destructive/5 text-destructive",
  due: "border-[var(--accent-line)] bg-[var(--accent-soft)] text-foreground",
  reply: "border-cyan/40 bg-cyan/10 text-cyan",
  decision: "border-violet/40 bg-violet/10 text-violet",
  event: "border-border-visible bg-secondary text-muted-foreground",
};

const BTN =
  "inline-flex items-center gap-1.5 rounded-[7px] border border-border-visible bg-secondary px-2.5 py-1 text-[12px] text-foreground cursor-pointer transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)] disabled:cursor-default disabled:opacity-40";

function LaneBadge({ lane, count }: { lane: TodayLane; count: number }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)]",
        LANE_TONE[lane]
      )}
    >
      {LANE_LABEL[lane]}
      {count > 1 && <span className="opacity-70">×{count}</span>}
    </span>
  );
}

/** The one honest annotation for a row: how late, how stale, or when it's due. */
function rowAnnotation(row: TodayRow): string | null {
  if (row.overdueDays) return `${row.overdueDays}d late`;
  if (row.staleDays) return `${row.staleDays}d stale`;
  if (row.due) return `due ${row.due}`;
  return null;
}

function TodayRowView({
  row,
  busy,
  onResolve,
  onComplete,
  onAsk,
}: {
  row: TodayRow;
  busy: boolean;
  onResolve: (row: TodayRow) => void;
  onComplete: (row: TodayRow) => void;
  onAsk: (row: TodayRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const annotation = rowAnnotation(row);
  return (
    <li
      data-today-key={row.key}
      className={cn(
        "flex flex-col rounded-[10px] border border-border-visible bg-card transition-colors hover:border-[var(--accent-line)]",
        busy && "opacity-60"
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          type="button"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          aria-label={open ? `Hide details for ${row.title}` : `Show details for ${row.title}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            size={14}
            className={cn("transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        <LaneBadge lane={row.lane} count={row.count} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={row.title}>
          {row.title}
        </span>
        {annotation && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{annotation}</span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {row.action === "resolve-ask" && (
            <button
              type="button"
              className={BTN}
              disabled={busy}
              onClick={() => onResolve(row)}
              aria-label={`Resolve ${row.title}`}
            >
              <Check size={12} aria-hidden="true" />
              Resolve
            </button>
          )}
          {row.action === "complete-task" && (
            <button
              type="button"
              className={BTN}
              disabled={busy}
              onClick={() => onComplete(row)}
              aria-label={`Mark ${row.title} done`}
            >
              <Check size={12} aria-hidden="true" />
              Done
            </button>
          )}
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => onAsk(row)}
            aria-label={`Ask the agent about ${row.title}`}
          >
            <Sparkles size={12} aria-hidden="true" />
            Ask
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-visible px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <span>kind {row.kind}</span>
          <span>
            evidence {row.path}
            {row.row ? `#${row.row}` : ""}
          </span>
          <span>[{row.tier}]</span>
          {row.count > 1 && <span>{row.count} identical items folded into this row</span>}
        </div>
      )}
    </li>
  );
}

export function TodayView() {
  const { api } = useConnection();
  const { setView, sendMessage } = useSession();
  const [data, setData] = useState<DailyOrientation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Guards an in-flight refresh against a newer one resolving first (same supersession pattern
  // the chat replay uses) — a slow poll must never overwrite a fresher queue.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPending(true);
    try {
      const next = await api.get<DailyOrientation>("/api/loop/daily");
      if (seq !== loadSeq.current) return;
      setData(next);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === loadSeq.current) setPending(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const resolveAsk = useCallback(
    async (row: TodayRow) => {
      setBusyKey(row.key);
      try {
        await api.post("/api/asks/resolve", { ids: row.askIds });
        toast.success(row.count > 1 ? `Resolved ${row.count} asks` : "Ask resolved");
        await load();
      } catch (e) {
        toast.error(`Could not resolve: ${(e as Error).message}`);
      } finally {
        setBusyKey(null);
      }
    },
    [api, load]
  );

  const completeTask = useCallback(
    async (row: TodayRow) => {
      if (!row.taskRowKey) return;
      setBusyKey(row.key);
      try {
        await api.post("/api/tasks/edit", {
          row_key: row.taskRowKey,
          patch: { status: "done" },
        });
        toast.success("Marked done in tasks.md");
        await load();
      } catch (e) {
        toast.error(`Could not update the task: ${(e as Error).message}`);
      } finally {
        setBusyKey(null);
      }
    },
    [api, load]
  );

  const askAgent = useCallback(
    (row: TodayRow) => {
      setView("chat");
      void sendMessage(askPromptFor(row));
    },
    [setView, sendMessage]
  );

  if (error && !data) {
    return (
      <div className="flex flex-col gap-3">
        <div className="self-start text-xs text-destructive">error: {error}</div>
        <button className={BTN} onClick={load}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full rounded-[10px]" />
        <Skeleton className="h-9 w-full rounded-[10px]" />
        <Skeleton className="h-9 w-2/3 rounded-[10px]" />
      </div>
    );
  }

  const rows = buildTodayQueue(data);
  const lanes = laneCounts(rows);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {lanes.length ? (
            lanes.map(({ lane, count }) => <LaneBadge key={lane} lane={lane} count={count} />)
          ) : (
            <span className="font-mono text-xs text-muted-foreground">nothing owed</span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          {/* Proof the refresh did something — the old panel blanked and reflowed identically. */}
          <span className="font-mono text-[11px] text-muted-foreground">
            {pending ? "updating…" : updatedAt ? `updated ${updatedAt}` : ""}
          </span>
          <button className={BTN} onClick={load} disabled={pending}>
            <Clock size={12} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-destructive">
          refresh failed: {error} — showing the last good queue
        </div>
      )}

      {rows.length === 0 ? (
        <div className="m-auto flex max-w-[420px] flex-col items-center gap-2 py-10 text-center">
          <CircleDot size={20} className="text-muted-foreground" aria-hidden="true" />
          <p className="text-[13px] text-foreground">Nothing is waiting on you.</p>
          <p className="text-[12px] text-muted-foreground">
            No blockers, nothing overdue, no replies owed.
          </p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((row) => (
            <TodayRowView
              key={row.key}
              row={row}
              busy={busyKey === row.key}
              onResolve={resolveAsk}
              onComplete={completeTask}
              onAsk={askAgent}
            />
          ))}
        </ul>
      )}

      <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <MessageCircle size={11} aria-hidden="true" />
        {data.member} · {data.window.from.slice(0, 10)} → {data.window.to.slice(0, 10)} ·{" "}
        {data.counts.withheld} withheld · {data.counts.excluded} excluded
      </div>
    </div>
  );
}
