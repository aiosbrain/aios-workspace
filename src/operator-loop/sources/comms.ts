// Comms source (AIO-140) — normalizes Slack / email / calendar activity into tier-tagged
// `comms` signals for C1. Connectors (slack-cli, gog-cli) drop normalized records as JSONL
// under the inbox spine (`<inbox>/comms/activity.jsonl`, or a configured `activityPath`);
// this source reads them, tier-resolves each (default-deny), and emits one signal per record.
//
// Windowing (resolved concern): the source fetches a FIXED, max-bounded lookback
// (`config.lookbackHours`, default 7 days) and emits every in-bound record with a correct
// `occurredAt`. It does NOT derive a cadence window — the collector's per-cadence `occurredAt`
// filter trims daily (1d) / weekly (7d) from this max bound. `SourceContext` is untouched; no
// cadence is threaded through the shared `Source` shape.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveTier, toOccurredAt } from "../signal.js";
import { COMMS_ACTIVITY_BASENAME, loadCommsConfig } from "../comms/config.js";
import type { Source, SourceResult } from "./types.js";

/** One normalized activity record a connector writes (one JSON object per line). */
interface CommsActivityRecord {
  source?: unknown; // "slack" | "email" | "calendar"
  tier?: unknown;
  access?: unknown; // synonym for tier (frontmatter-style)
  occurredAt?: unknown;
  ref?: unknown; // message / event id
  channel?: unknown;
  direction?: unknown; // "inbound" | "outbound"
  summary?: unknown;
  waitingOn?: unknown;
  dueAt?: unknown;
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set(["slack", "email", "calendar"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export const commsSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.inbox) return out;

  const config = loadCommsConfig(ctx.root);
  const rel = config.activityPath ?? `${ctx.spine.inbox}/${COMMS_ACTIVITY_BASENAME}`;
  const abs = path.join(ctx.root, rel);
  if (!existsSync(abs)) return out;

  const mtime = statSync(abs).mtime.toISOString();
  const now = ctx.now.getTime();
  // Fixed max-bounded lookback floor. The collector still applies the per-cadence window on top.
  const floor = now - config.lookbackHours * 3_600_000;

  const raw = readFileSync(abs, "utf8");
  let line = 0;
  for (const rawLine of raw.split("\n")) {
    line += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let rec: CommsActivityRecord;
    try {
      rec = JSON.parse(trimmed) as CommsActivityRecord;
    } catch {
      out.excluded.push({ ref: `${rel}:${line}`, reason: "comms record is not valid JSON" });
      continue;
    }

    const id = str(rec.ref) ?? `L${line}`;
    const refKey = `${rel}#${id}`;

    // Default-deny tier resolution — a record with no resolvable tier is excluded, never emitted.
    const tier = resolveTier((rec.tier ?? rec.access ?? null) as string | string[] | null);
    if (!tier) {
      out.excluded.push({ ref: refKey, reason: "comms record has no resolvable tier (default-deny)" });
      continue;
    }

    const summary = str(rec.summary);
    if (!summary) {
      out.excluded.push({ ref: refKey, reason: "comms record has no summary" });
      continue;
    }

    const occurredAt = toOccurredAt(str(rec.occurredAt) ?? null, mtime);
    const t = Date.parse(occurredAt);
    // Max-bound: drop anything older than the lookback floor or dated in the future. The
    // collector's cadence window narrows this further; this is only the source's hard ceiling.
    if (!Number.isFinite(t) || t < floor || t > now) continue;

    const src = str(rec.source);
    const source = src && KNOWN_SOURCES.has(src) ? src : "comms";
    const channel = str(rec.channel);
    const direction = str(rec.direction);
    const waitingOn = str(rec.waitingOn);
    const dueAt = str(rec.dueAt);

    out.signals.push({
      kind: "comms",
      source,
      tier,
      occurredAt,
      ref: { path: rel, row: id, tier },
      summary,
      // Payload mirrors the pinned Communication signal contract.
      payload: {
        channel: channel ?? null,
        direction: direction ?? null,
        summary,
        ...(waitingOn ? { waitingOn } : {}),
        ...(dueAt ? { dueAt } : {}),
      },
    });
  }

  return out;
};
