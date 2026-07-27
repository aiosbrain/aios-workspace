// The task legs of `aios pull` (extracted from scripts/aios.mjs, which is under a ratcheting
// file-size cap): the dashboard **writeback** feed and the 1.13 **sync-origin return leg**.
//
// The brain→Linear projection is one-way and the dashboard writeback feed is UI-origin only, so a
// task row THIS workspace pushed could move to Done in Linear and never come back: `3-log/
// tasks-team.md` decayed until someone hand-reconciled (field audit 2026-07-27: 6 rows read `todo`
// while Linear said Done/In Progress). `aios pull` now also asks the brain for
// `GET /tasks?mode=sync-origin&project=<slug>` and merges status/assignee back.
//
// The feed fetch is injectable so the feature-detection fallback and paging are directly
// testable without a network — see test/pull-tasks.test.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planSyncOriginWriteback, syncOriginRowsFor, mergeTaskWriteback } from "./tasks-table.mjs";

export const EPOCH = "1970-01-01T00:00:00Z";

/**
 * Where task writeback lands. AIO-364: prefer the new `3-log/tasks-team.md` home (what a freshly
 * scaffolded workspace has); fall back through the legacy single-file spine. Dashboard-authored
 * rows are always team-tier by construction (the /tasks endpoint is tier-scoped — see
 * docs/brain-api.md), so they never belong in tasks-private.md or 5-personal/tasks.md.
 */
export function resolveTasksPath(repo) {
  for (const rel of [
    ["3-log", "tasks-team.md"],
    ["3-log", "tasks.md"],
  ]) {
    const candidate = path.join(repo, ...rel);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(repo, "03-status", "tasks.md");
}

/** Merge the dashboard writeback feed's rows for `project` into `tasksPath`; returns the count. */
export function mergeWritebackFeed(tasksPath, res, project) {
  const rows = (res?.tasks || []).filter((g) => g.project === project).flatMap((g) => g.rows || []);
  if (!existsSync(tasksPath) || !rows.length) return 0;
  writeFileSync(tasksPath, mergeTaskWriteback(readFileSync(tasksPath, "utf8"), rows));
  return rows.length;
}

/** The route a 1.13 client calls for `project` since `since`. */
export function syncOriginRoute(project, since) {
  return `/tasks?${new URLSearchParams({
    mode: "sync-origin",
    project,
    since: since || EPOCH,
  })}`;
}

/**
 * Fetch the sync-origin feed and merge the REAL status/assignee changes into `tasksPath`.
 *
 * `fetchFeed(route)` must resolve to the parsed response, or a falsy value when the brain doesn't
 * offer the mode (the CLI passes `apiOptional`, which turns 400/404 into the fallback). A pre-1.13
 * brain instead answers 200 with the dashboard writeback feed — `syncOriginRowsFor` rejects that
 * because the echoed `mode` isn't `"sync-origin"`, so an old brain merges NOTHING rather than the
 * wrong thing.
 *
 * The feed pages at 500 rows: a full page comes back with `next_cursor` (the last row's
 * `updated_at`), so this drains every page in one pull rather than letting the cursor jump past the
 * remainder. `MAX_PAGES` bounds a pathological brain (e.g. 500 rows sharing one timestamp).
 *
 * Returns `{ supported, rows, cursor }` — `rows` are the merged rows (for reporting) and `cursor`
 * is what the caller should store. `supported` is false when the brain has no return leg, in which
 * case the caller must NOT advance its cursor (a later, upgraded brain would otherwise never
 * resend the changes the cursor skipped past).
 */
export const MAX_PAGES = 20;

export async function pullSyncOriginTasks({ project, tasksPath, since, fetchFeed, log }) {
  if (!existsSync(tasksPath)) return { supported: false, rows: [], cursor: since };
  const merged = [];
  let cursor = since || EPOCH;
  let supported = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchFeed(syncOriginRoute(project, cursor));
    if (!res || res.mode !== "sync-origin") break;
    supported = true;
    const rows = syncOriginRowsFor(res, project);
    if (rows.length) {
      const plan = planSyncOriginWriteback(readFileSync(tasksPath, "utf8"), rows);
      if (plan.rows.length)
        writeFileSync(tasksPath, mergeTaskWriteback(readFileSync(tasksPath, "utf8"), plan.rows));
      for (const row of plan.rows) log?.(`${row.row_key} → ${row.status} (${row.assignee || "—"})`);
      merged.push(...plan.rows);
    }
    // A `next_cursor` means the page was full: keep draining from it. Otherwise we're current, and
    // the caller may move the cursor to now.
    if (!res.next_cursor) return { supported, rows: merged, cursor: new Date().toISOString() };
    cursor = res.next_cursor;
  }
  // Unsupported (cursor unchanged) or page-capped (resume from the last cursor next pull).
  return { supported, rows: merged, cursor: supported ? cursor : since };
}
