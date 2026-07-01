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
import { githubSource } from "./sources/github.js";
import { timeSource } from "./sources/time.js";
import { commsSource } from "./sources/comms.js";

// Source registry, keyed by signal kind. carryover (C7) and github (AIO-32, no local source
// yet) are wired but inert stubs — they emit nothing until implemented, so registering them is
// behavior-neutral and keeps the registry honest (a cadence may list them without breaking).
const SOURCES: Record<string, Source> = {
  decision: decisionsSource,
  task: tasksSource,
  hours: hoursSource,
  deliverable: deliverablesSource,
  inbox: inboxSource,
  carryover: carryoverSource,
  github: githubSource,
  time: timeSource,
  comms: commsSource,
};

export interface CollectOptions {
  root: string;
  cadence: Cadence;
  member?: string;
  project?: string;
  now?: Date; // injectable for deterministic tests
  /**
   * When false, skip the [from, now] window filter and return ALL current signals for the
   * cadence's kinds. The daily loop (C4) uses this for run-to-run change detection and for a
   * complete owed/blocked view (an overdue/blocked item in a file not touched today must not be
   * filtered out). Default true — every existing caller is byte-for-byte unchanged.
   */
  window?: boolean;
}

export function collect(opts: CollectOptions): RunManifest {
  const win = windowFor(opts.cadence);
  const spine = resolveSpine(opts.root);
  const now = opts.now ?? new Date();
  const ctx: SourceContext = { root: opts.root, spine, member: opts.member ?? "owner", now };
  const from = new Date(now.getTime() - win.days * 86_400_000);
  const applyWindow = opts.window !== false;

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
      if (applyWindow) {
        const t = Date.parse(sig.occurredAt);
        // In-window means [from, now]. Sources guarantee a valid ISO occurredAt (toOccurredAt
        // falls back to mtime), so a non-finite value shouldn't occur — exclude it if it does.
        // Future-dated rows (t > now) are out of scope: the manifest advertises window.to = now.
        // (Not exclusions — those are tier failures; this is just out-of-window.)
        if (!Number.isFinite(t) || t < from.getTime() || t > now.getTime()) continue;
      }
      signals.push(sig);
    }
  }

  return buildManifest({
    member: ctx.member,
    project: opts.project ?? "",
    cadence: opts.cadence,
    from: from.toISOString(),
    to: now.toISOString(),
    windowed: applyWindow,
    generatedAt: now.toISOString(),
    signals,
    excluded,
  });
}
