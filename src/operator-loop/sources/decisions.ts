// Decisions source — parses the decision-log table into one signal per row. The per-row
// `audience` is the signal's sharing tier (already normalized by parseDecisionRows); it
// falls back to the file's `access:` tier. Rows with no resolvable tier are excluded.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseDecisionRows } from "../parsers.js";
import { resolveTier, toOccurredAt } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

export const decisionsSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.log) return out;
  const rel = `${ctx.spine.log}/decision-log.md`;
  const abs = path.join(ctx.root, rel);
  if (!existsSync(abs)) return out;

  const raw = readFileSync(abs, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const fileTier = resolveTier(frontmatter?.access ?? null);
  const mtime = statSync(abs).mtime.toISOString();

  for (const row of parseDecisionRows(body)) {
    const ref = `${rel}#${row.row_key}`;
    // NOTE: parseDecisionRows defaults a missing/blank audience to "team", so a decision row
    // almost always resolves a tier; the fileTier fallback only matters for an unrecognized
    // audience value. Default-deny is therefore weaker for decisions than other sources by
    // design (inherited from the sync parser) — acceptable since decisions are governance rows.
    const tier = resolveTier(row.audience) ?? fileTier;
    if (!tier) {
      out.excluded.push({ ref, reason: "decision row has no resolvable tier (default-deny)" });
      continue;
    }
    out.signals.push({
      kind: "decision",
      source: "decision-log",
      tier,
      occurredAt: toOccurredAt(row.decided_at, mtime),
      ref: { path: rel, row: row.row_key, tier },
      summary: row.title,
      payload: {
        rationale: row.rationale,
        decided_by: row.decided_by,
        impact: row.impact,
        type: row.tier,
      },
    });
  }
  return out;
};
