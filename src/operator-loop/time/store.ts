// The time-log store: `<spine.log>/time-log.md` — a markdown table that round-trips through the
// shared parseTableRows. Frontmatter `access: admin` + kept out of sync_include ⇒ the file can
// never sync. Confirmed rows are IMMUTABLE across captures; unconfirmed rows are refreshed
// idempotently by opaque ID. The pure source (sources/time.ts) reads the same file and resolves
// each row's tier with default-deny — so a hand-mangled tier is excluded, never inherited.

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSpine } from "../spine.js";
import { parseFrontmatter, parseTableRows } from "../parsers.js";

export const TIME_LOG_BASENAME = "time-log.md";

export interface StoreRow {
  id: string;
  startIso: string;
  endIso: string;
  repo: string; // display alias — NEVER a raw path
  runtimeMin: number;
  tag: string; // a valid Tag when machine-written; consumers validate
  tier: string; // resolved by the source via resolveTier (default-deny)
  confirmed: boolean;
  taskRef: string;
}

export interface StoreReadResult {
  rows: StoreRow[];
  rel: string;
  abs: string;
  mtimeIso: string | null;
}

/** Resolve the workspace log dir or throw a clear no-spine error. Returns the dir name (e.g. "3-log"). */
export function requireSpineLog(root: string): string {
  const spine = resolveSpine(root);
  if (!spine.log) {
    throw new Error(
      "no workspace spine found (missing a 3-log/ folder) — run `aios time` from a scaffolded workspace"
    );
  }
  return spine.log;
}

export function storeRel(root: string): string {
  return `${requireSpineLog(root)}/${TIME_LOG_BASENAME}`;
}

/** Read the store (empty when the file does not exist). Throws if there is no workspace spine. */
export function readStore(root: string): StoreReadResult {
  const rel = storeRel(root);
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return { rows: [], rel, abs, mtimeIso: null };
  const raw = readFileSync(abs, "utf8");
  const { body } = parseFrontmatter(raw);
  return { rows: parseRows(body), rel, abs, mtimeIso: statSync(abs).mtime.toISOString() };
}

function parseRows(body: string): StoreRow[] {
  const table = parseTableRows(body);
  if (table.length < 2) return [];
  const header = (table[0] ?? []).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const ci = {
    id: col("id"),
    start: col("start"),
    end: col("end"),
    repo: col("repo"),
    runtime: col("runtime (min)"),
    tag: col("tag"),
    tier: col("tier"),
    confirmed: col("confirmed"),
    task: col("task ref"),
  };
  const out: StoreRow[] = [];
  for (const cells of table.slice(1)) {
    const get = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const id = get(ci.id);
    if (!id) continue;
    const runtimeMin = Number.parseInt(get(ci.runtime), 10);
    out.push({
      id,
      startIso: get(ci.start),
      endIso: get(ci.end),
      repo: get(ci.repo),
      runtimeMin: Number.isFinite(runtimeMin) ? runtimeMin : 0,
      tag: get(ci.tag),
      tier: get(ci.tier).toLowerCase(),
      confirmed: get(ci.confirmed).toLowerCase() === "yes",
      taskRef: get(ci.task),
    });
  }
  return out;
}

/** Merge derived blocks into existing rows. Confirmed rows are IMMUTABLE; unconfirmed rows are
 *  overwritten by re-derivation; new blocks are added. Sorted newest-first by start. */
export function upsertRows(existing: StoreRow[], derived: StoreRow[]): StoreRow[] {
  const byId = new Map<string, StoreRow>();
  for (const r of existing) byId.set(r.id, r);
  for (const d of derived) {
    const prev = byId.get(d.id);
    if (prev && prev.confirmed) continue; // immutable
    byId.set(d.id, d);
  }
  return [...byId.values()].sort((a, b) =>
    a.startIso < b.startIso ? 1 : a.startIso > b.startIso ? -1 : a.id < b.id ? -1 : 1
  );
}

const HEADER = [
  "ID",
  "Start",
  "End",
  "Repo",
  "Runtime (min)",
  "Tag",
  "Tier",
  "Confirmed",
  "Task Ref",
];

/** Sanitize a cell so the markdown table round-trips (no `|`/newline, trimmed). */
function cell(v: string | number): string {
  return String(v)
    .replace(/[|\r\n]/g, " ")
    .trim();
}

export function renderStore(rows: StoreRow[]): string {
  const lines = [
    "---",
    "access: admin",
    "---",
    "",
    "# Agent session time-log — local only · never synced · edit via `aios time reconcile`, not by hand",
    "",
    `| ${HEADER.join(" | ")} |`,
    `|${HEADER.map(() => "---").join("|")}|`,
  ];
  for (const r of rows) {
    lines.push(
      "| " +
        [
          cell(r.id),
          cell(r.startIso),
          cell(r.endIso),
          cell(r.repo),
          cell(r.runtimeMin),
          cell(r.tag),
          cell(r.tier),
          r.confirmed ? "yes" : "no",
          cell(r.taskRef),
        ].join(" | ") +
        " |"
    );
  }
  return lines.join("\n") + "\n";
}

export function writeStore(root: string, rows: StoreRow[]): string {
  const rel = storeRel(root);
  writeFileSync(path.join(root, rel), renderStore(rows), "utf8");
  return rel;
}

/** True when two rows are content-equal (for change counting). */
export function rowsEqual(a: StoreRow, b: StoreRow): boolean {
  return (
    a.id === b.id &&
    a.startIso === b.startIso &&
    a.endIso === b.endIso &&
    a.repo === b.repo &&
    a.runtimeMin === b.runtimeMin &&
    a.tag === b.tag &&
    a.tier === b.tier &&
    a.confirmed === b.confirmed &&
    a.taskRef === b.taskRef
  );
}
