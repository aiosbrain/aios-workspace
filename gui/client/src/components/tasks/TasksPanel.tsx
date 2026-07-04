import { useCallback, useEffect, useState } from "react";
import { TerminalFrame } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/sonner";
import { cn } from "../../lib/cn";
import type {
  PushResponse,
  TaskEditResponse,
  TaskPushState,
  TaskRow,
  TasksResponse,
} from "../../types/protocol";

const BTN =
  "rounded-[8px] border border-border-visible bg-secondary px-3.5 py-1.5 text-[13px] text-foreground cursor-pointer disabled:cursor-default disabled:opacity-40";
const BTN_PRIMARY = cn(
  BTN,
  "border-transparent bg-primary font-semibold text-primary-foreground enabled:hover:bg-[var(--accent-hover)] enabled:hover:shadow-[var(--glow-violet)]"
);
const PANEL = "flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";
const CELL_INPUT =
  "w-full rounded-[6px] border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-foreground hover:border-border-visible focus:border-[var(--accent-line)] focus:outline-none";

// Brain-canonical status/priority vocabularies (docs/brain-api.md). The brain normalizes
// an unrecognized status to `backlog` on push — surfaced in the panel copy below.
const STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"];
const PRIORITIES = ["none", "low", "medium", "high", "urgent"];

/** Local sync-state badge — sourced from `aios status`, never the brain. */
function PushBadge({ push }: { push: TaskPushState | null }) {
  if (!push) return null;
  const tone: Record<TaskPushState["state"], string> = {
    new: "text-lime border-[var(--accent-line)]",
    modified: "text-lime border-[var(--accent-line)]",
    blocked:
      "text-destructive border-[color-mix(in_srgb,var(--aios-destructive)_45%,var(--aios-border-visible))]",
    clean: "text-muted-foreground border-border-visible",
  };
  return (
    <span
      className={cn(
        "rounded-full border bg-secondary px-2 py-px font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)]",
        tone[push.state]
      )}
      title={push.reason || undefined}
    >
      {push.state}
    </span>
  );
}

/** Standalone Tasks panel: read the workspace tasks.md, light-edit fields, then explicitly push. */
export function TasksPanel() {
  const { api } = useConnection();
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null); // row_key currently saving
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<TasksResponse>("/api/tasks"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // Persist a single-field patch (local-only write on the server), then reload so the
  // pushState badge reflects the new on-disk state.
  const saveField = useCallback(
    async (row: TaskRow, patch: Record<string, unknown>) => {
      setSaving(row.row_key);
      try {
        const res = await api.post<TaskEditResponse>("/api/tasks/edit", {
          row_key: row.row_key,
          patch,
        });
        if (!res.ok) throw new Error(res.error || "edit failed");
        await load();
      } catch (e) {
        toast.error(`Edit failed: ${(e as Error).message}`, { duration: 8000 });
      }
      setSaving(null);
    },
    [api, load]
  );

  const push = useCallback(
    async (dryRun: boolean) => {
      if (!data?.rel) return;
      setBusy(true);
      setOutput("");
      try {
        const res = await api.post<PushResponse>("/api/push", { paths: [data.rel], dryRun });
        setOutput(res.output || res.error || "(no output)");
        if (!dryRun) {
          if (res.ok) {
            toast.success("Pushed tasks.md to the brain");
            await load();
          } else {
            toast.error(`Push failed${res.error ? `: ${res.error}` : ""}`, { duration: 10_000 });
          }
        }
      } catch (e) {
        setOutput(`error: ${(e as Error).message}`);
        if (!dryRun) toast.error(`Push failed: ${(e as Error).message}`, { duration: 10_000 });
      }
      setBusy(false);
    },
    [api, data, load]
  );

  if (error)
    return (
      <div className={PANEL}>
        <div className="self-center bg-transparent p-0.5 text-xs text-destructive">
          error: {error}
        </div>
        <button className={cn(BTN, "self-center")} onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!data)
    return (
      <div className={PANEL}>
        <Skeleton className="mb-3 h-8 w-full rounded-md" />
        <Skeleton className="mb-2 h-6 w-3/4 rounded-md" />
        <Skeleton className="mb-2 h-6 w-2/3 rounded-md" />
        <Skeleton className="h-6 w-1/2 rounded-md" />
      </div>
    );

  if (!data.rel)
    return (
      <div className={PANEL}>
        <div className="m-auto flex max-w-[440px] flex-col items-center gap-3 text-center text-muted-foreground">
          <p>No task list yet — this workspace has no tasks.md in 3-log/ or 03-status/.</p>
          <button className={BTN} onClick={load}>
            Refresh
          </button>
        </div>
      </div>
    );

  const pushState = data.pushState?.state ?? null;
  const pushDisabled = busy || pushState === "blocked" || pushState === "clean";

  return (
    <div className={PANEL}>
      {/* header */}
      <div className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="text-foreground">{data.rel}</span>
          {data.tier && (
            <span className="rounded-full border border-border-visible bg-secondary px-2 py-px text-[10px] uppercase tracking-[var(--aios-tracking-wide)]">
              {data.tier}
            </span>
          )}
          <PushBadge push={data.pushState} />
        </span>
        <button className={BTN} onClick={load} disabled={busy}>
          Refresh
        </button>
      </div>

      {/* task table */}
      {data.rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No task rows in this file.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-visible">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border-visible text-left font-mono text-[11px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
                <th className="px-2.5 py-2">ID</th>
                <th className="px-2.5 py-2">Task</th>
                <th className="px-2.5 py-2">Status</th>
                <th className="px-2.5 py-2">Assignee</th>
                <th className="px-2.5 py-2">Priority</th>
                <th className="px-2.5 py-2">Labels</th>
                <th className="px-2.5 py-2">Parent</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={row.row_key}
                  className={cn(
                    "border-b border-border-visible/60 last:border-0",
                    saving === row.row_key && "opacity-60"
                  )}
                >
                  <td className="px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">
                    {row.row_key}
                  </td>
                  {/* title is brain-canonical — read-only */}
                  <td
                    className="px-2.5 py-1.5 text-foreground"
                    title="Title is edited in the brain, not here"
                  >
                    {row.title}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <select
                      className={CELL_INPUT}
                      value={STATUSES.includes(row.status) ? row.status : ""}
                      disabled={saving === row.row_key}
                      onChange={(e) => saveField(row, { status: e.target.value })}
                    >
                      {!STATUSES.includes(row.status) && (
                        <option value="">{row.status || "—"}</option>
                      )}
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2.5 py-1.5">
                    {/* uncontrolled (commit-on-blur); a derived key remounts it when the server
                        value changes after a reload, so the field never shows a stale value. */}
                    <input
                      key={`assignee:${row.assignee}`}
                      className={CELL_INPUT}
                      defaultValue={row.assignee}
                      disabled={saving === row.row_key}
                      onBlur={(e) =>
                        e.target.value !== row.assignee &&
                        saveField(row, { assignee: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-2.5 py-1.5">
                    <select
                      className={CELL_INPUT}
                      value={PRIORITIES.includes(row.priority || "") ? row.priority || "" : ""}
                      disabled={saving === row.row_key}
                      onChange={(e) => saveField(row, { priority: e.target.value })}
                    >
                      <option value="">—</option>
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2.5 py-1.5">
                    <input
                      key={`labels:${(row.labels || []).join(",")}`}
                      className={CELL_INPUT}
                      defaultValue={(row.labels || []).join(", ")}
                      placeholder="a, b"
                      disabled={saving === row.row_key}
                      onBlur={(e) => {
                        const next = e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean);
                        if (next.join(",") !== (row.labels || []).join(","))
                          saveField(row, { labels: next });
                      }}
                    />
                  </td>
                  <td className="px-2.5 py-1.5">
                    <input
                      key={`parent:${row.parent || ""}`}
                      className={CELL_INPUT}
                      defaultValue={row.parent || ""}
                      disabled={saving === row.row_key}
                      onBlur={(e) =>
                        e.target.value !== (row.parent || "") &&
                        saveField(row, { parent: e.target.value || null })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Edits save locally to <span className="font-mono">{data.rel}</span> — nothing leaves the
        machine until you push below. Title and description are brain-canonical and edited there.
        The brain normalizes an unknown status to <span className="font-mono">backlog</span> on
        push.
      </p>

      {/* sync-to-brain section (reuses the existing push rails) */}
      <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border-visible px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">Sync to brain</span>
          <span className="flex gap-2">
            <button className={BTN} onClick={() => push(true)} disabled={pushDisabled}>
              Dry-run
            </button>
            <button className={BTN_PRIMARY} onClick={() => push(false)} disabled={pushDisabled}>
              Push tasks.md
            </button>
          </span>
        </div>
        {pushState === "blocked" && (
          <p className="text-[11px] text-destructive">
            Blocked — {data.pushState?.reason || "this file never syncs"}.
          </p>
        )}
        {pushState === "clean" && (
          <p className="text-[11px] text-muted-foreground">Already in sync with the brain.</p>
        )}
      </div>

      {output && (
        <TerminalFrame
          filename={busy ? "aios push…" : "aios push"}
          status={busy ? "live" : "static"}
          code={output}
          className="mt-2"
        />
      )}
    </div>
  );
}
