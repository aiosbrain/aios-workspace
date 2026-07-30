// Ambient typings for the shared markdown table parsers, consumed by the TS
// operator-loop collector under nodenext resolution.

/** Parse a markdown table body into raw trimmed cell arrays (row 0 is the header). */
export function parseTableRows(body: string): string[][];

export function parsePmCell(
  raw: string,
  rowKey: string
): {
  pm_provider?: string;
  pm_external_id?: string;
  /** Verbatim cell text for an unrecognized/retired provider (e.g. legacy `plane:T-01`), preserved for round-trip. */
  pm_raw?: string;
};

export interface TaskRow {
  row_key: string;
  title: string;
  assignee: string;
  status: string;
  sprint: string;
  due: string | null;
  pm_provider?: string;
  pm_external_id?: string;
  /** Verbatim PM cell for an unrecognized/retired provider, preserved so edits round-trip. */
  pm_raw?: string;
  pm_url?: string | null;
  parent?: string | null;
  labels?: string[];
  priority?: string | null;
}

export function parseTaskRows(body: string): TaskRow[];

export function mergeTaskWriteback(content: string, rows: TaskRow[]): string;

/** Canonical brain task statuses (mirrors the brain's `normalizeTaskStatus`). */
export const CANONICAL_TASK_STATUSES: string[];
/** Canonical form of a markdown status cell, or null when it isn't canonical (e.g. `todo`). */
export function canonicalTaskStatus(raw: string | null | undefined): string | null;

/** One row of the brain-api 1.13 sync-origin feed (writeback row + the echo-guard `raw_status`). */
export interface SyncOriginRow extends TaskRow {
  raw_status?: string | null;
}

/**
 * Rows carrying a REAL status/assignee change, rebuilt from the local cells, plus the row_keys
 * skipped (unknown locally, or a normalization echo). Feed `rows` to `mergeTaskWriteback`.
 */
export function planSyncOriginWriteback(
  content: string,
  rows: SyncOriginRow[]
): { rows: TaskRow[]; skipped: string[] };

/** Sync-origin rows for `project`, or [] unless the brain echoed `mode: "sync-origin"`. */
export function syncOriginRowsFor(res: unknown, project: string): SyncOriginRow[];
