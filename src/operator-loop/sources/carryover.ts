// Carry-over source — C7 continuity. Prior-run unresolved actions (owed items not yet
// closed) surface forward into the next run so the weekly closeout is assembly, not
// archaeology. The source is local-only: it reads .aios/loop/continuity/actions.json,
// the same dot-dir boundary used for manifests.

import type { Source, SourceResult } from "./types.js";
import { CONTINUITY_ACTIONS_REL, readContinuityActions } from "../continuity.js";
import { resolveTier } from "../signal.js";

export const carryoverSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  const read = readContinuityActions(ctx.root);
  out.excluded.push(...read.excluded);

  for (const action of read.actions) {
    const tier = resolveTier(
      action.tier ?? action.access ?? action.audience ?? action.source?.tier ?? null
    );
    const ref = `${CONTINUITY_ACTIONS_REL}#${action.id}`;
    if (!tier) {
      out.excluded.push({ ref, reason: "carry-over action has no resolvable tier (default-deny)" });
      continue;
    }

    const due = action.due ? ` (due ${action.due})` : "";
    const status = action.status ?? "open";
    out.signals.push({
      kind: "carryover",
      source: "continuity",
      tier,
      // Carry-over is an active unresolved obligation in this run. Preserve the original dates
      // in payload, but stamp occurredAt to the run time so the collector's window keeps it visible.
      occurredAt: ctx.now.toISOString(),
      ref: { path: CONTINUITY_ACTIONS_REL, row: action.id, tier },
      summary: `Carry over: ${action.title}${due}`,
      payload: {
        id: action.id,
        title: action.title,
        status,
        due: action.due ?? null,
        cadence: action.cadence ?? "both",
        createdAt: action.createdAt ?? null,
        updatedAt: action.updatedAt ?? null,
        source: action.source ?? null,
      },
    });
  }

  return out;
};
