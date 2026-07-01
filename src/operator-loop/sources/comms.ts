// Comms source (AIO-140) — normalizes Slack / email / calendar activity into tier-tagged
// `comms` signals for C1. Connectors (slack-cli, gog-cli) drop normalized records as JSONL
// under the inbox spine (`<inbox>/comms/activity.jsonl`, or a configured `activityPath`);
// this source reads them, tier-resolves each (default-deny, channel-tier-map-authoritative for
// channel-backed records), and emits one deduped signal per record with a COLLISION-PROOF
// per-source/per-tier/per-channel EvidenceRef path (so a raw id reused across channels/sources
// never collapses to the same `path + row + tier`).
//
// Windowing (resolved concern): the source fetches a FIXED, max-bounded lookback
// (`config.lookbackHours`, default 7 days) and emits every in-bound record with a correct
// `occurredAt`. It does NOT derive a cadence window — the collector's per-cadence `occurredAt`
// filter trims daily (1d) / weekly (7d) from this max bound. `SourceContext` is untouched; no
// cadence is threaded through the shared `Source` shape.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveTier, toOccurredAt, type Tier } from "../signal.js";
import {
  COMMS_ACTIVITY_BASENAME,
  loadCommsConfig,
  resolveChannelTier,
  type CommsConfig,
} from "../comms/config.js";
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

  // Dedupe key set so the same message (same source/channel/id) can't emit twice from a
  // re-appended activity log — the emitted `ref` is collision-proof, so this is exact.
  const seen = new Set<string>();

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
    const src = str(rec.source);
    const source = src && KNOWN_SOURCES.has(src) ? src : "comms";
    const channel = str(rec.channel);
    const refKey = `${rel}#${id}`;

    // Tier resolution (default-deny). For CHANNEL-BACKED records the channel→tier map is
    // authoritative: an unlisted channel is unresolvable (excluded), and a record whose
    // self-reported tier disagrees with its channel's tier is rejected — a record on an
    // admin/private channel can no longer emit as `team`. When no channel map is configured at
    // all, we fall back to the record's own default-deny tier resolution.
    const tier = resolveRecordTier(config, channel, rec, out, refKey);
    if (!tier) continue;

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

    const direction = str(rec.direction);
    const waitingOn = str(rec.waitingOn);
    const dueAt = str(rec.dueAt);

    // Collision-proof EvidenceRef: a per-source/per-tier/per-channel synthetic path scopes the
    // row id so two records sharing a raw id on different channels/sources (or a spoofed tier)
    // never collapse to the same `path + row + tier`. Resolves by exact key under `verifyLedger`.
    const refPath = commsRefPath(source, tier, channel);
    const dedupeKey = `${refPath} ${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.signals.push({
      kind: "comms",
      source,
      tier,
      occurredAt,
      ref: { path: refPath, row: id, tier },
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

/** Per-source/per-tier/per-channel synthetic evidence path. Collision-proof: distinct
 *  source/tier/channel triples never share a path, so a raw message id reused across them
 *  yields distinct EvidenceRefs. Channel-less records get a `_` segment. */
function commsRefPath(source: string, tier: Tier, channel: string | undefined): string {
  return `.aios/loop/comms/${source}/${tier}/${channel ?? "_"}.ndjson`;
}

/**
 * Resolve a record's emit tier under default-deny. When a channel→tier map is configured
 * (`config.channels` non-empty) and the record is channel-backed, the channel's tier is
 * authoritative: an unlisted channel or a self-reported/channel tier disagreement is excluded.
 * Otherwise (no map, or no channel) the record's own `tier`/`access` is used (still default-deny).
 * Pushes the exclusion reason itself; returns null when the record must not emit.
 */
function resolveRecordTier(
  config: CommsConfig,
  channel: string | undefined,
  rec: CommsActivityRecord,
  out: SourceResult,
  refKey: string
): Tier | null {
  const selfTier = resolveTier((rec.tier ?? rec.access ?? null) as string | string[] | null);

  if (config.channels.size > 0 && channel) {
    const channelTier = resolveChannelTier(config, channel);
    if (!channelTier) {
      out.excluded.push({
        ref: refKey,
        reason: `comms record on unlisted channel "${channel}" (default-deny)`,
      });
      return null;
    }
    if (selfTier && selfTier !== channelTier) {
      out.excluded.push({
        ref: refKey,
        reason: `comms record tier "${selfTier}" disagrees with channel "${channel}" tier "${channelTier}" (default-deny)`,
      });
      return null;
    }
    return channelTier;
  }

  if (!selfTier) {
    out.excluded.push({
      ref: refKey,
      reason: "comms record has no resolvable tier (default-deny)",
    });
    return null;
  }
  return selfTier;
}
