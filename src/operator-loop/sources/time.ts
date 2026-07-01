// Time source — reads the local agent-runtime store (`<spine.log>/time-log.md`) and emits one
// `kind:"time"` signal per row. Per-row tier is authoritative and default-deny (a blank/unknown
// tier is excluded, NEVER inherited from the file's `access:`). The summary carries the TAG +
// runtime ONLY — never the repo/alias — so a time signal can't leak a repo name even if a
// downstream consumer mishandled it. The repo alias lives in the payload (owner-local).
//
// Capture (side-effecting) writes the store; this source only reads it — the pure/stateless
// contract every operator-loop source honors.

import { toOccurredAt, resolveTier } from "../signal.js";
import type { Source, SourceResult } from "./types.js";
import { readStore } from "../time/store.js";

export const timeSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.log) return out; // no spine → nothing to read (graceful, like hours.ts)

  const { rows, rel, mtimeIso } = readStore(ctx.root);
  const mtime = mtimeIso ?? ctx.now.toISOString();

  for (const row of rows) {
    const ref = `${rel}#${row.id}`;
    const tier = resolveTier(row.tier);
    if (!tier) {
      out.excluded.push({ ref, reason: "time row has no resolvable tier (default-deny)" });
      continue;
    }
    out.signals.push({
      kind: "time",
      source: "session",
      tier,
      occurredAt: toOccurredAt(row.startIso, mtime),
      ref: { path: rel, row: row.id, tier },
      summary: `${row.tag} — ${row.runtimeMin}m`, // tag + runtime only; NO repo/alias
      payload: {
        repo: row.repo,
        durationMin: row.runtimeMin,
        tag: row.tag,
        ...(row.taskRef ? { taskRef: row.taskRef } : {}),
      },
    });
  }
  return out;
};
