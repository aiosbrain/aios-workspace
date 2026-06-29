// THE collector — one engine, two window configs. Daily and weekly differ ONLY by the
// WindowConfig (lookback days + kind allowlist); there is no per-cadence code path.
//
// Default-deny: each source already excludes signals with no resolvable tier (logged in
// `excluded[]`). admin-tier signals ARE retained here — the private operator brief needs
// them; redaction happens later at the digest boundary (C2 ledger). This is deliberately
// NOT the sync gate (buildPlan), which drops admin.

import { windowFor } from "./config.js";
import { resolveSpine } from "./spine.js";
import type { Cadence, Signal } from "./signal.js";
import { buildManifest, type RunManifest } from "./manifest.js";
import type { Exclusion, Source, SourceContext } from "./sources/types.js";
import { decisionsSource } from "./sources/decisions.js";
import { tasksSource } from "./sources/tasks.js";
import { hoursSource } from "./sources/hours.js";
import { deliverablesSource } from "./sources/deliverables.js";
import { inboxSource } from "./sources/inbox.js";
import { carryoverSource } from "./sources/carryover.js";

// Active source set, keyed by signal kind. github is intentionally absent (deferred stub).
const SOURCES: Record<string, Source> = {
  decision: decisionsSource,
  task: tasksSource,
  hours: hoursSource,
  deliverable: deliverablesSource,
  inbox: inboxSource,
  carryover: carryoverSource,
};

export interface CollectOptions {
  root: string;
  cadence: Cadence;
  member?: string;
  project?: string;
  now?: Date; // injectable for deterministic tests
}

export function collect(opts: CollectOptions): RunManifest {
  const win = windowFor(opts.cadence);
  const spine = resolveSpine(opts.root);
  const ctx: SourceContext = { root: opts.root, spine, member: opts.member ?? "owner" };
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - win.days * 86_400_000);

  const signals: Signal[] = [];
  const excluded: Exclusion[] = [];

  // The cadence's kind allowlist selects which sources run — the single difference between
  // daily (minimal) and weekly (full). Same loop for both.
  for (const kind of win.kinds) {
    const source = SOURCES[kind];
    if (!source) continue;
    const res = source(ctx);
    excluded.push(...res.excluded);
    for (const sig of res.signals) {
      const t = Date.parse(sig.occurredAt);
      // Outside the window → not in scope (not an exclusion; exclusions are tier failures).
      if (Number.isFinite(t) && t < from.getTime()) continue;
      signals.push(sig);
    }
  }

  return buildManifest({
    member: ctx.member,
    project: opts.project ?? "",
    cadence: opts.cadence,
    from: from.toISOString(),
    to: now.toISOString(),
    generatedAt: now.toISOString(),
    signals,
    excluded,
  });
}
