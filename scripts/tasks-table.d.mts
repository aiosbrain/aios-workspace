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
