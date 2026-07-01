// Hours source — header-keyed so it tolerates BOTH shipped shapes:
//   | Date | Activity | Hours | Tag | Task Ref |   (scaffold rule)
//   | Member | Date | Activity | Hours | Tag |      (examples/sample-engagement)
// Tier is the file's `access:` tier. Row key is the row index (hours rows have no id).

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseTableRows } from "../parsers.js";
import { resolveTier, toOccurredAt } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

export const hoursSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.log) return out;
  const rel = `${ctx.spine.log}/hours-log.md`;
  const abs = path.join(ctx.root, rel);
  if (!existsSync(abs)) return out;

  const raw = readFileSync(abs, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const tier = resolveTier(frontmatter?.access ?? null);
  const mtime = statSync(abs).mtime.toISOString();

  const rows = parseTableRows(body);
  if (rows.length < 2) return out;
  const header = (rows[0] ?? []).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const di = col("date");
  const ai = col("activity");
  const hi = col("hours");
  const ti = col("tag");
  const mi = col("member");
  const ri = col("task ref");

  rows.slice(1).forEach((cells, i) => {
    const rowKey = `r${i + 1}`;
    const ref = `${rel}#${rowKey}`;
    if (!tier) {
      out.excluded.push({
        ref,
        reason: "hours-log.md has no resolvable access tier (default-deny)",
      });
      return;
    }
    const date = di >= 0 ? (cells[di] ?? null) : null;
    const activity = ai >= 0 ? (cells[ai] ?? "") : "";
    const hours = hi >= 0 ? (cells[hi] ?? "") : "";
    const tag = ti >= 0 ? (cells[ti] ?? "") : "";
    const member = mi >= 0 ? (cells[mi] ?? "") : "";
    const taskRef = ri >= 0 ? (cells[ri] ?? "") : "";
    out.signals.push({
      kind: "hours",
      source: "hours-log",
      tier,
      occurredAt: toOccurredAt(date, mtime),
      ref: { path: rel, row: rowKey, tier },
      summary: `${activity}${hours ? ` — ${hours}h` : ""}${tag ? ` (${tag})` : ""}`.trim(),
      payload: { member, date, activity, hours, tag, taskRef },
    });
  });
  return out;
};
