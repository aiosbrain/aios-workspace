import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Columns3,
  ExternalLink,
  LayoutGrid,
  List,
  Minus,
  SignalHigh,
  SignalLow,
  SignalMedium,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { isSafeExternalUrl } from "../../lib/safe-url";
import type { TaskEditRequest, TaskRow } from "../../types/protocol";
import { AssigneeAvatar } from "./Avatar";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export type TaskViewMode = "list" | "grid" | "board";

export const TASK_VIEW_STORAGE_KEY = "aios.tasks.view";
export const TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"] as const;
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

type TaskPatch = TaskEditRequest["patch"];
type SaveTask = (row: TaskRow, patch: TaskPatch) => void | Promise<void>;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const FIELD =
  "min-w-0 w-full rounded-md border border-border-visible bg-background px-2 py-1 text-[12px] text-foreground focus:border-[var(--accent-line)] focus:outline-none disabled:opacity-50";

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
  if (!storage) return "board";
  try {
    const value = storage.getItem(TASK_VIEW_STORAGE_KEY);
    return value === "grid" || value === "board" || value === "list" ? value : "board";
  } catch {
    return "board";
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

/**
 * Mirror the brain's status normalization (lowercase, whitespace/dash → underscore) so the
 * board shows what the brain/Linear will actually see. `todo` is aliased to backlog — that
 * is exactly where the brain's unknown-status rule lands it. The RAW cell value is never
 * rewritten (StatusSelect still shows it); this is display grouping only.
 */
export function normalizeStatusForBoard(status: string): string {
  const s = (status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return s === "todo" ? "backlog" : s;
}

/** Canonical lanes plus an honest catch-all: no row disappears because its status is unfamiliar. */
export function groupTasksForBoard(rows: TaskRow[]): TaskBoardLane[] {
  const byStatus = new Map<string, TaskRow[]>();
  for (const status of TASK_STATUSES) byStatus.set(status, []);
  const other: TaskRow[] = [];

  for (const row of rows) {
    const lane = byStatus.get(normalizeStatusForBoard(row.status));
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

/**
 * Status and priority read as GLYPHS, not as form controls.
 *
 * The board previously rendered a full-width native `<select>` and a text `<input>` inside every
 * card, so each card was mostly chrome and the title — the only thing you actually scan for —
 * competed with three widgets for space. A coloured icon carries the same state in a fraction of
 * the width and stays legible at card density; editing moves into a menu opened from the icon.
 */
const STATUS_ICON: Record<(typeof TASK_STATUSES)[number], typeof Circle> = {
  backlog: CircleDashed,
  ready: Circle,
  in_progress: CircleDot,
  blocked: CircleAlert,
  done: CircleCheck,
};

const STATUS_ICON_TONE: Record<(typeof TASK_STATUSES)[number], string> = {
  backlog: "text-muted-foreground",
  ready: "text-cyan",
  in_progress: "text-violet",
  blocked: "text-destructive",
  done: "text-lime",
};

const PRIORITY_ICON: Record<(typeof TASK_PRIORITIES)[number], typeof Circle> = {
  none: Minus,
  low: SignalLow,
  medium: SignalMedium,
  high: SignalHigh,
  urgent: CircleAlert,
};

function knownStatus(status: string): (typeof TASK_STATUSES)[number] | null {
  return TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])
    ? (status as (typeof TASK_STATUSES)[number])
    : null;
}

function knownPriority(priority?: string | null): (typeof TASK_PRIORITIES)[number] | null {
  return TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number])
    ? (priority as (typeof TASK_PRIORITIES)[number])
    : null;
}

/**
 * The avatar IS the assignee control: clicking it opens the free-text editor.
 *
 * Assignees are free text (a tasks.md cell), not accounts, so this stays an input rather than a
 * member picker — but it no longer occupies a permanent 116px slot in every row and card.
 */
function AssigneeControl({
  row,
  disabled,
  onSave,
  size = "sm",
}: TaskControlProps & { size?: "sm" | "md" }) {
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        className="cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-50"
        aria-label={`Assignee for ${row.title}${row.assignee ? `: ${row.assignee}` : ""}`}
      >
        <AssigneeAvatar assignee={row.assignee} size={size} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-[var(--aios-tracking-wide)] text-muted-foreground">
          Assignee
        </label>
        <input
          key={`assignee:${row.assignee}`}
          className={FIELD}
          defaultValue={row.assignee}
          placeholder="Unassigned"
          aria-label={`Assignee for ${row.title}`}
          disabled={disabled}
          onBlur={(event) => {
            if (event.target.value !== row.assignee) onSave(row, { assignee: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
          Separate multiple people with <code>+</code> or <code>,</code>.
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const known = knownStatus(normalizeStatusForBoard(status));
  const Icon = known ? STATUS_ICON[known] : Circle;
  return (
    <Icon
      size={size}
      className={cn("shrink-0", known ? STATUS_ICON_TONE[known] : "text-muted-foreground")}
      aria-hidden="true"
    />
  );
}

/** Icon-triggered status menu. Falls back to showing an unrecognised raw value verbatim. */
function StatusMenu({ row, disabled, onSave }: TaskControlProps) {
  const normalized = normalizeStatusForBoard(row.status);
  const known = knownStatus(normalized);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-50",
          statusTone(normalized)
        )}
        aria-label={`Status for ${row.title}`}
      >
        <StatusIcon status={row.status} />
        <span className="max-w-[92px] truncate">
          {known ? STATUS_LABELS[known] : row.status || "Unspecified"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => {
          const Icon = STATUS_ICON[status];
          return (
            <DropdownMenuItem key={status} onSelect={() => onSave(row, { status })}>
              <Icon
                size={14}
                className={cn("shrink-0", STATUS_ICON_TONE[status])}
                aria-hidden="true"
              />
              {STATUS_LABELS[status]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Icon-only priority menu — the glyph IS the value, exactly as on a Linear card. */
function PriorityMenu({ row, disabled, onSave }: TaskControlProps) {
  const known = knownPriority(row.priority);
  const Icon = known ? PRIORITY_ICON[known] : Minus;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          "inline-flex cursor-pointer items-center rounded-md p-1 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-50",
          priorityTone(row.priority)
        )}
        aria-label={`Priority for ${row.title}${known ? `: ${known}` : ""}`}
        title={known ? `Priority: ${known}` : "No priority"}
      >
        <Icon size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => {
          const ItemIcon = PRIORITY_ICON[priority];
          return (
            <DropdownMenuItem
              key={priority}
              onSelect={() => onSave(row, { priority: priority === "none" ? "" : priority })}
            >
              <ItemIcon size={14} className="shrink-0" aria-hidden="true" />
              {priority === "none" ? "No priority" : priority}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TaskControlProps {
  row: TaskRow;
  disabled: boolean;
  onSave: SaveTask;
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

/**
 * The list row, shaped like a Linear list line: a single dense row you scan vertically —
 * priority · id · status · title · labels · due · assignee — rather than a six-column form
 * grid. Labels and parent stay editable through the card/board surfaces; forcing a text input
 * into every list line is what made the old grid read as a spreadsheet.
 */
export function TaskList({ rows, saving, onSave }: TaskViewProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-visible bg-card">
      {rows.map((row) => {
        const disabled = saving !== null;
        const safePmUrl = row.pm_url && isSafeExternalUrl(row.pm_url) ? row.pm_url : null;
        return (
          <div
            key={row.row_key}
            data-task-id={row.row_key}
            className={cn(
              "flex items-center gap-2.5 border-b border-border-visible/60 px-3 py-2 last:border-b-0 transition-colors hover:bg-secondary/40",
              saving === row.row_key && "opacity-60"
            )}
          >
            <PriorityMenu row={row} disabled={disabled} onSave={onSave} />
            {safePmUrl ? (
              <a
                className="inline-flex w-[76px] shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                href={safePmUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                aria-label={`Open ${row.title} in ${row.pm_provider || "project manager"}`}
              >
                {row.pm_external_id || row.pm_provider || "PM"}
                <ExternalLink size={9} aria-hidden="true" />
              </a>
            ) : (
              <span className="w-[76px] shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {row.row_key}
              </span>
            )}
            <StatusIcon status={row.status} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={row.title}>
              {row.title}
            </span>
            <div className="hidden shrink-0 md:block">
              <LabelChips labels={row.labels} />
            </div>
            {row.due && (
              <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                {row.due}
              </span>
            )}
            <div className="hidden shrink-0 lg:block">
              <StatusMenu row={row} disabled={disabled} onSave={onSave} />
            </div>
            <AssigneeControl row={row} disabled={disabled} onSave={onSave} />
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

/**
 * The board/grid card, laid out the way a Linear issue card is:
 *
 *   AIO-446 ↗                                    (avatar)
 *   Document and test all v1 surfaces
 *   ◐ In progress  ▮▮  Due 2026-07-29  [label]
 *
 * The identifier and assignee anchor the top row, the title gets the full width and wraps to two
 * lines instead of truncating mid-word, and state collapses into the glyph row at the bottom.
 * Every field is still editable — the controls just stopped shouting over the content.
 */
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
  const safePmUrl = row.pm_url && isSafeExternalUrl(row.pm_url) ? row.pm_url : null;
  return (
    <article
      data-task-id={row.row_key}
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg border border-border-visible bg-card p-3 shadow-card transition-colors hover:border-[var(--accent-line)]",
        saving === row.row_key && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {safePmUrl ? (
            <a
              className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              href={safePmUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              aria-label={`Open ${row.title} in ${row.pm_provider || "project manager"}`}
            >
              {row.pm_external_id || row.pm_provider || "PM"}
              <ExternalLink size={9} aria-hidden="true" />
            </a>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground">{row.row_key}</span>
          )}
        </div>
        <AssigneeControl row={row} disabled={disabled} onSave={onSave} />
      </div>

      <p className="m-0 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
        {row.title}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <StatusMenu row={row} disabled={disabled} onSave={onSave} />
        <PriorityMenu row={row} disabled={disabled} onSave={onSave} />
        {row.due && (
          <span className="font-mono text-[10px] text-muted-foreground">Due {row.due}</span>
        )}
        {row.sprint && (
          <span className="font-mono text-[10px] text-muted-foreground">{row.sprint}</span>
        )}
        <LabelChips labels={row.labels} />
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
