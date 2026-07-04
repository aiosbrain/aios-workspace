// Maturity source (AIO-144) — closes the C8 wiring gap: feeds the AM1 per-session maturity
// store (`.aios/loop/maturity/sessions.ndjson`, written by hooks/maturity-capture.mjs) into
// C1 as ONE aggregate tier-tagged `maturity` signal per collect, per the domain contract
// (docs/v1-operator-loop/domains/agentic-maturity.md §Signal contract):
//   { kind:"maturity", source:"analyze", tier, occurredAt, ref,
//     payload:{ placement, axisScores, costTotals, sessionCount } }
//
// Placement comes from the SAME engine every AM consumer uses (foldSessions → foldSignals →
// placement, re-exported through parsers.ts) — never a re-implementation, so the loop's
// number always matches the brief / weekly report. Per the documented reader contract the
// fold filters to ONE project's slug (this workspace root's), because the store co-mingles
// every repo that shared the root.
//
// Tier: the WHOLE store is admin-tier local telemetry (never syncs), so the signal emits at
// `admin` — the collector retains it for the private brief; the digest boundary redacts.
//
// Windowing (mirrors comms.ts): a fixed 7-day max lookback here matching the widest cadence;
// the collector's per-cadence `occurredAt` filter trims further. `occurredAt` is the LATEST
// in-window session's `ended_at`, so a store with no fresh sessions ages out of the window
// naturally. Absent / oversized / unreadable store → empty result, never a throw (fail-open,
// like the AM2 brief and the maturity-week CLI).

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Tier } from "../signal.js";
import {
  foldSessions,
  foldSignals,
  placement,
  projectSlug,
  MATURITY_STORE_REL,
  MATURITY_STORE_SIZE_CAP,
  type MaturitySession,
} from "../parsers.js";
import type { Source, SourceResult } from "./types.js";

const LOOKBACK_DAYS = 7; // fixed max bound; the collector's cadence window narrows this
const TIER: Tier = "admin";

const num = (x: unknown): number => (Number.isFinite(Number(x)) ? Number(x) : 0);

export const maturitySource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  const abs = path.join(ctx.root, MATURITY_STORE_REL);
  if (!existsSync(abs)) return out;

  let text: string;
  try {
    if (statSync(abs).size > MATURITY_STORE_SIZE_CAP) return out; // pathological — fail-open
    text = readFileSync(abs, "utf8");
  } catch {
    return out;
  }

  const { sessions } = foldSessions(text); // malformed lines already skipped, never fatal
  const project = projectSlug(ctx.root);
  const now = ctx.now.getTime();
  const floor = now - LOOKBACK_DAYS * 86_400_000;

  // In-window = [floor, now]: undateable or future-dated snapshots never count. Track the
  // latest session while filtering — it anchors `occurredAt` and the evidence row.
  const recent: MaturitySession[] = [];
  let latestAt = 0;
  let latestId = "";
  for (const s of sessions.values()) {
    if (!s.counts || s.project !== project) continue;
    const t = Date.parse(s.ended_at ?? "");
    if (!Number.isFinite(t) || t < floor || t > now) continue;
    recent.push(s);
    if (t >= latestAt) {
      latestAt = t;
      latestId = s.session_id;
    }
  }
  if (recent.length === 0) return out;

  const p = placement(foldSignals(recent));

  // Cost totals: fold token COUNTS across the in-window sessions (same keys the store's
  // `counts` carries), plus the derived total.
  const costTotals = {
    in_tok: 0,
    out_tok: 0,
    cache_read_tok: 0,
    cache_create_tok: 0,
    subagent_tok: 0,
    total_tok: 0,
  };
  for (const s of recent) {
    const c = s.counts ?? {};
    costTotals.in_tok += num(c.in_tok);
    costTotals.out_tok += num(c.out_tok);
    costTotals.cache_read_tok += num(c.cache_read_tok);
    costTotals.cache_create_tok += num(c.cache_create_tok);
    costTotals.subagent_tok += num(c.subagent_tok);
  }
  costTotals.total_tok =
    costTotals.in_tok +
    costTotals.out_tok +
    costTotals.cache_read_tok +
    costTotals.cache_create_tok;

  out.signals.push({
    kind: "maturity",
    source: "analyze",
    tier: TIER,
    occurredAt: new Date(latestAt).toISOString(),
    // Evidence: the AM1 store itself; the row is the latest in-window captured session id —
    // the local store's nearest equivalent of the contract's "<analyze run id>".
    ref: { path: MATURITY_STORE_REL, row: latestId, tier: TIER },
    summary: `AEM ${p.spine} — ${recent.length} session${recent.length === 1 ? "" : "s"}, weakest axis: ${p.weakest}`,
    payload: {
      placement: p.spine,
      axisScores: p.axes,
      costTotals,
      sessionCount: recent.length,
    },
  });
  return out;
};
