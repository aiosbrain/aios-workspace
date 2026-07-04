/**
 * tasks.mjs — pure helpers for the cockpit Tasks panel.
 *
 * These are side-effect-free (no http, no self-booting server) so they can be
 * unit-tested directly — mirroring the maturity.mjs / sessions-search.mjs pattern.
 * index.mjs wires them into the `GET /api/tasks` and `POST /api/tasks/edit` routes.
 *
 * Tier is FILE-LEVEL: read from the task file's `access:` frontmatter through
 * normalizeTier (private→admin, client|company→external). The row parser and merge
 * writeback are the shared markdown helpers the CLI + brain-pull already use, so the
 * cockpit round-trips a table exactly the way `aios pull` does (body never written).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseTaskRows, mergeTaskWriteback } from "../../scripts/tasks-table.mjs";
import { parseFrontmatter, normalizeTier } from "../../scripts/workspace-parse.mjs";

// Fields the cockpit is allowed to edit. Title + body/description are brain-canonical
// (the markdown body never round-trips), so an attempt to patch them is rejected.
export const EDITABLE_FIELDS = new Set(["status", "assignee", "priority", "labels", "parent"]);

/**
 * Resolve the workspace task file. Modern spine (3-log/) wins; legacy (03-status/) is the
 * fallback. Returns null instead of throwing when neither exists — the GUI renders an empty
 * state, not a 500 (this is the die-free analog of aios.mjs `tasksFile`).
 * @returns {{ abs: string, rel: string } | null}
 */
export function resolveTasksFile(repo) {
  const modern = path.join(repo, "3-log", "tasks.md");
  if (existsSync(modern)) return { abs: modern, rel: "3-log/tasks.md" };
  const legacy = path.join(repo, "03-status", "tasks.md");
  if (existsSync(legacy)) return { abs: legacy, rel: "03-status/tasks.md" };
  return null;
}

/**
 * Locate `rel` in an `aios status --json` (ReviewResponse) document and reduce it to a
 * push-state badge: new | modified | blocked | clean, plus the blocked reason.
 * @param {object|null} status - parsed `aios status --json`
 * @param {string} rel - repo-relative task file path
 * @returns {{ state: "new"|"modified"|"blocked"|"clean", reason?: string } | null}
 */
export function derivePushState(status, rel) {
  const items = status?.items;
  if (!items) return null;
  if ((items.new || []).some((i) => i.rel === rel)) return { state: "new" };
  if ((items.modified || []).some((i) => i.rel === rel)) return { state: "modified" };
  const blocked = (items.blocked || []).find((b) => b.rel === rel);
  if (blocked) return { state: "blocked", reason: blocked.reason || "never syncs" };
  if ((items.clean || []).some((i) => i.rel === rel)) return { state: "clean" };
  return null;
}

/**
 * Build the `GET /api/tasks` body (minus pushState, which the route fills from `aios status`).
 * Reads the file, resolves its file-level tier, and parses the rows.
 * @returns {{ rel: string, tier: string|null, rows: import("../../scripts/tasks-table.d.mts").TaskRow[] }}
 */
export function readTasks(file) {
  const content = readFileSync(file.abs, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const tier = normalizeTier(frontmatter?.access || "") || null;
  return { rel: file.rel, tier, rows: parseTaskRows(body) };
}

/** Thrown by applyTaskEdit for a caller-mappable HTTP status (400 bad field, 404 no row). */
export class TaskEditError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TaskEditError";
    this.status = status;
  }
}

/**
 * Apply a single-row field patch to the task-file content and return the new content + patched
 * row. Local-only: performs NO network call — the brain write is a separate explicit push.
 *
 * Only EDITABLE_FIELDS are accepted; any title/body/description key throws a 400. The row is
 * matched by `row_key`; a missing key throws a 404. mergeTaskWriteback upserts by key (every
 * other row untouched, frontmatter + body preserved, hierarchy columns widened as needed), so
 * passing just the one patched row is safe.
 * @returns {{ content: string, row: object }}
 */
export function applyTaskEdit(content, rowKey, patch) {
  const keys = Object.keys(patch || {});
  const bad = keys.filter((k) => !EDITABLE_FIELDS.has(k));
  if (bad.length) {
    throw new TaskEditError(400, `field(s) not editable from the cockpit: ${bad.join(", ")}`);
  }
  // Parse rows from the body only (matching readTasks); mergeTaskWriteback still receives the full
  // content so it preserves frontmatter. Frontmatter carries no table, so this is equivalent today —
  // it just keeps the two parse sites consistent and future-proof against a `|` line in frontmatter.
  const { body } = parseFrontmatter(content);
  const rows = parseTaskRows(body);
  const row = rows.find((r) => r.row_key === rowKey);
  if (!row) throw new TaskEditError(404, `no task row with id '${rowKey}'`);
  for (const k of keys) row[k] = patch[k];
  return { content: mergeTaskWriteback(content, [row]), row };
}
