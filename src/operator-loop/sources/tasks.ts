// Tasks source — one signal per task row. tasks.md has no per-row audience, so the signal
// tier is the file's `access:` tier (admin by default in the scaffold — retained, not dropped).

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseTaskRows } from "../parsers.js";
import { resolveTier } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

export const tasksSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.log) return out;
  const rel = `${ctx.spine.log}/tasks.md`;
  const abs = path.join(ctx.root, rel);
  if (!existsSync(abs)) return out;

  const raw = readFileSync(abs, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const tier = resolveTier(frontmatter?.access ?? null);
  const mtime = statSync(abs).mtime.toISOString();

  for (const row of parseTaskRows(body)) {
    const ref = `${rel}#${row.row_key}`;
    if (!tier) {
      out.excluded.push({ ref, reason: "tasks.md has no resolvable access tier (default-deny)" });
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
