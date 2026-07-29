// Tasks source — one signal per task row. Task files have no per-row audience, so each signal
// inherits its file's `access:` tier and remains default-deny when that tier is unresolved.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseTaskRows } from "../parsers.js";
import { resolveTier } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

function resolveTasksFile(root: string, log: string): { abs: string; rel: string } | null {
  for (const name of ["tasks-team.md", "tasks.md"]) {
    const rel = `${log}/${name}`;
    const abs = path.join(root, rel);
    if (existsSync(abs)) return { abs, rel };
  }
  return null;
}

export const tasksSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.log) return out;
  const tasksFile = resolveTasksFile(ctx.root, ctx.spine.log);
  if (!tasksFile) return out;
  const { abs, rel } = tasksFile;

  const raw = readFileSync(abs, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const tier = resolveTier(frontmatter?.access ?? null);
  const mtime = statSync(abs).mtime.toISOString();

  for (const row of parseTaskRows(body)) {
    const ref = `${rel}#${row.row_key}`;
    if (!tier) {
      out.excluded.push({
        ref,
        reason: `${path.basename(rel)} has no resolvable access tier (default-deny)`,
      });
      continue;
    }
    out.signals.push({
      kind: "task",
      source: "tasks",
      tier,
      // Activity axis = when the task list last changed (file mtime), NOT the due date. A future
      // due date must not push a task out of "what changed", nor a past due date drop a task
      // just worked on. due is preserved in payload for the consumer.
      occurredAt: mtime,
      ref: { path: rel, row: row.row_key, tier },
      summary: row.title,
      payload: {
        status: row.status,
        assignee: row.assignee,
        sprint: row.sprint,
        due: row.due,
        priority: row.priority ?? null,
        labels: row.labels ?? [],
      },
    });
  }
  return out;
};
