import { Columns3, ExternalLink, LayoutGrid, List } from "lucide-react";
import { cn } from "../../lib/cn";
import { isSafeExternalUrl } from "../../lib/safe-url";
import type { TaskEditRequest, TaskRow } from "../../types/protocol";

export type TaskViewMode = "list" | "grid" | "board";

export const TASK_VIEW_STORAGE_KEY = "aios.tasks.view";
export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"] as const;
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

type TaskPatch = TaskEditRequest["patch"];
type SaveTask = (row: TaskRow, patch: TaskPatch) => void | Promise<void>;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const CONTROL =
  "rounded-md border border-transparent bg-transparent px-2 py-1 text-[12px] text-foreground hover:border-border-visible hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-40";
const FIELD =
  "min-w-0 rounded-md border border-border-visible bg-background px-2 py-1 text-[12px] text-foreground focus:border-[var(--accent-line)] focus:outline-none disabled:opacity-50";

const VIEW_OPTIONS: Array<{
  mode: TaskViewMode;
  label: string;
  icon: typeof List;
}> = [
  { mode: "list", label: "List", icon: List },
  { mode: "grid", label: "Grid", icon: LayoutGrid },
  { mode: "board", label: "Board", icon: Columns3 },
];

const STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export function readTaskViewPreference(storage?: StorageReader | null): TaskViewMode {
  if (!storage) return "list";
  try {
    const value = storage.getItem(TASK_VIEW_STORAGE_KEY);
    return value === "grid" || value === "board" || value === "list" ? value : "list";
  } catch {
    return "list";
  }
}

export function writeTaskViewPreference(mode: TaskViewMode, storage?: StorageWriter | null): void {
  if (!storage) return;
  try {
    storage.setItem(TASK_VIEW_STORAGE_KEY, mode);
  } catch {
    // Private browsing and locked-down WebViews can reject storage. The view still works in memory.
  }
}

/** Accessing localStorage itself can throw in hardened or sandboxed WebViews. */
export function taskViewStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface TaskBoardLane {
  key: string;
  label: string;
  rows: TaskRow[];
}

/** Canonical lanes plus an honest catch-all: no row disappears because its status is unfamiliar. */
export function groupTasksForBoard(rows: TaskRow[]): TaskBoardLane[] {
  const byStatus = new Map<string, TaskRow[]>();
  for (const status of TASK_STATUSES) byStatus.set(status, []);
  const other: TaskRow[] = [];

  for (const row of rows) {
    const lane = byStatus.get(row.status);
    if (lane) lane.push(row);
    else other.push(row);
  }

  const lanes: TaskBoardLane[] = TASK_STATUSES.map((status) => ({
    key: status,
    label: STATUS_LABELS[status],
    rows: byStatus.get(status) ?? [],
  }));
  if (other.length) lanes.push({ key: "other", label: "Other", rows: other });
  return lanes;
}

export function TaskViewSwitcher({
  value,
  onChange,
}: {
  value: TaskViewMode;
  onChange: (mode: TaskViewMode) => void;
}) {
  return (
    <div
      className="flex rounded-lg border border-border-visible bg-card p-0.5"
      role="group"
      aria-label="Task view"
    >
      {VIEW_OPTIONS.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            value === mode && "bg-secondary font-medium text-foreground shadow-button"
          )}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

function statusTone(status: string): string {
  if (status === "done") return "bg-lime/10 text-lime";
  if (status === "blocked") return "bg-destructive/10 text-destructive";
  if (status === "in_progress") return "bg-violet/10 text-violet";
  if (status === "ready") return "bg-cyan/10 text-cyan";
  return "bg-secondary text-muted-foreground";
}

function priorityTone(priority?: string | null): string {
  if (priority === "urgent") return "text-destructive";
  if (priority === "high") return "text-amber";
  return "text-muted-foreground";
}

function StatusSelect({ row, disabled, onSave }: TaskControlProps) {
  const unknown =
    !!row.status && !TASK_STATUSES.includes(row.status as (typeof TASK_STATUSES)[number]);
  return (
    <select
      className={cn(FIELD, "max-w-[140px]", statusTone(row.status))}
      value={row.status}
      disabled={disabled}
      aria-label={`Status for ${row.title}`}
      onChange={(event) => onSave(row, { status: event.target.value })}
    >
      {unknown && <option value={row.status}>{row.status}</option>}
      {!row.status && <option value="">Unspecified</option>}
      {TASK_STATUSES.map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

interface TaskControlProps {
  row: TaskRow;
  disabled: boolean;
  onSave: SaveTask;
}

function AssigneeInput({ row, disabled, onSave }: TaskControlProps) {
  return (
    <input
      key={`assignee:${row.assignee}`}
      className={cn(FIELD, "w-[116px]")}
      defaultValue={row.assignee}
      placeholder="Unassigned"
      aria-label={`Assignee for ${row.title}`}
      disabled={disabled}
      onBlur={(event) => {
        if (event.target.value !== row.assignee) onSave(row, { assignee: event.target.value });
      }}
    />
  );
}

function PrioritySelect({ row, disabled, onSave }: TaskControlProps) {
  const known = TASK_PRIORITIES.includes(row.priority as (typeof TASK_PRIORITIES)[number]);
  return (
    <select
      className={cn(FIELD, "w-[104px]", priorityTone(row.priority))}
      value={known ? (row.priority ?? "") : ""}
      disabled={disabled}
      aria-label={`Priority for ${row.title}`}
      onChange={(event) => onSave(row, { priority: event.target.value })}
    >
      <option value="">No priority</option>
      {TASK_PRIORITIES.map((priority) => (
        <option key={priority} value={priority}>
          {priority}
        </option>
      ))}
    </select>
  );
}

function TaskIdentity({ row }: { row: TaskRow }) {
  const safePmUrl = row.pm_url && isSafeExternalUrl(row.pm_url) ? row.pm_url : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-foreground">{row.title}</span>
        {safePmUrl && (
          <a
            className={cn(
              CONTROL,
              "inline-flex shrink-0 items-center gap-1 px-1.5 text-muted-foreground"
            )}
            href={safePmUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${row.title} in ${row.pm_provider || "project manager"}`}
          >
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>{row.row_key}</span>
        {row.due && <span>Due {row.due}</span>}
        {row.sprint && <span>{row.sprint}</span>}
        {row.parent && <span>Parent {row.parent}</span>}
      </div>
    </div>
  );
}

function LabelChips({ labels }: { labels?: string[] }) {
  if (!labels?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-full border border-border-visible bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function TaskList({ rows, saving, onSave }: TaskViewProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-visible bg-card">
      <div className="hidden grid-cols-[minmax(220px,1fr)_140px_116px_104px_minmax(130px,0.55fr)_120px] gap-2 border-b border-border-visible px-3 py-2 font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground lg:grid">
        <span>Task</span>
        <span>Status</span>
        <span>Assignee</span>
        <span>Priority</span>
        <span>Labels</span>
        <span>Parent</span>
      </div>
      {rows.map((row) => {
        const disabled = saving !== null;
        return (
          <div
            key={row.row_key}
            data-task-id={row.row_key}
            className={cn(
              "grid gap-2 border-b border-border-visible/60 px-3 py-2.5 last:border-b-0 lg:grid-cols-[minmax(220px,1fr)_140px_116px_104px_minmax(130px,0.55fr)_120px] lg:items-center",
              saving === row.row_key && "opacity-60"
            )}
          >
            <TaskIdentity row={row} />
            <StatusSelect row={row} disabled={disabled} onSave={onSave} />
            <AssigneeInput row={row} disabled={disabled} onSave={onSave} />
            <PrioritySelect row={row} disabled={disabled} onSave={onSave} />
            <input
              key={`labels:${(row.labels || []).join(",")}`}
              className={FIELD}
              defaultValue={(row.labels || []).join(", ")}
              placeholder="Add labels"
              aria-label={`Labels for ${row.title}`}
              disabled={disabled}
              onBlur={(event) => {
                const labels = event.target.value
                  .split(",")
                  .map((label) => label.trim())
                  .filter(Boolean);
                if (labels.join(",") !== (row.labels || []).join(",")) onSave(row, { labels });
              }}
            />
            <input
              key={`parent:${row.parent || ""}`}
              className={FIELD}
              defaultValue={row.parent || ""}
              placeholder="No parent"
              aria-label={`Parent for ${row.title}`}
              disabled={disabled}
              onBlur={(event) => {
                if (event.target.value !== (row.parent || "")) {
                  onSave(row, { parent: event.target.value || null });
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

interface TaskViewProps {
  rows: TaskRow[];
  saving: string | null;
  onSave: SaveTask;
}

function TaskCard({
  row,
  saving,
  onSave,
}: {
  row: TaskRow;
  saving: string | null;
  onSave: SaveTask;
}) {
  const disabled = saving !== null;
  return (
    <article
      data-task-id={row.row_key}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border-visible bg-card p-3 shadow-card",
        saving === row.row_key && "opacity-60"
      )}
    >
      <TaskIdentity row={row} />
      <LabelChips labels={row.labels} />
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <StatusSelect row={row} disabled={disabled} onSave={onSave} />
        <PrioritySelect row={row} disabled={disabled} onSave={onSave} />
        <AssigneeInput row={row} disabled={disabled} onSave={onSave} />
      </div>
    </article>
  );
}

export function TaskGrid({ rows, saving, onSave }: TaskViewProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
      {rows.map((row) => (
        <TaskCard key={row.row_key} row={row} saving={saving} onSave={onSave} />
      ))}
    </div>
  );
}

export function TaskBoard({ rows, saving, onSave }: TaskViewProps) {
  const lanes = groupTasksForBoard(rows);
  return (
    <div className="grid min-w-max auto-cols-[290px] grid-flow-col gap-3 pb-2">
      {lanes.map((lane) => (
        <section
          key={lane.key}
          className="flex max-h-full min-h-[180px] flex-col rounded-lg border border-border-visible bg-secondary/40"
          aria-labelledby={`task-lane-${lane.key}`}
        >
          <header className="flex items-center justify-between border-b border-border-visible px-3 py-2.5">
            <h2 id={`task-lane-${lane.key}`} className="text-[12px] font-semibold text-foreground">
              {lane.label}
            </h2>
            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {lane.rows.length}
            </span>
          </header>
          <div className="flex flex-col gap-2 overflow-y-auto p-2">
            {lane.rows.length ? (
              lane.rows.map((row) => (
                <TaskCard key={row.row_key} row={row} saving={saving} onSave={onSave} />
              ))
            ) : (
              <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">No tasks</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
