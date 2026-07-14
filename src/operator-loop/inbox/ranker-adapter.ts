// Unified inbox — the deterministic-ranker ADAPTER (I-09 ← I-04 seam, AIO-429).
//
// This is the narrow concrete bridge that lets the `aios inbox` read view (I-09) consume I-04's
// real deterministic ranker instead of the recency fallback. It implements the `Ranker` seam
// (`./cli.js`) by:
//   1. normalizing each unified `InboxItem` (agent-ask rows + enriched/legacy thread rows) into
//      the ranker's `RankInput`,
//   2. calling the REAL zero-LLM ranker (`rankItem`, `./ranker.js`) with the loaded registry,
//   3. returning a deterministic order + a per-row `why` + the per-row protected verdict, and
//   4. stamping the ranker's `RANKER_VERSION` (never the recency-fallback id).
//
// Same-domain-only imports (`./ranker.js`, `./cli.js`): the adapter is inbox-domain code. The
// cross-domain composition — loading the registry from the workspace + defaulting `buildInbox` to
// this adapter — lives in the loop's one composition point (`src/operator-loop/index.ts`), per the
// Engineering Constitution §4. This file value-imports no peer domain.
//
// FAIL-OPEN (inherited from I-04): an absent/broken registry degrades to `EMPTY_REGISTRY` upstream,
// so every item ranks unprotected + tier-only here — never a crash, never a silent protected claim,
// and STILL the real ranker + real `RANKER_VERSION`.
//
// TRUST FLOOR: the protected verdict returned to the CLI is the UNION of the ranker's registry
// verdict (`entityFile && active engagement`) and the row's pre-existing STRUCTURAL protection (an
// open blocker ask — the class the CLI already refuses to bury). Protection only ever adds; the
// ranker can promote a registry counterparty into the partition but can never demote a blocker.
//
// This adapter introduces NO channel-specific runtime behavior. `channel` is carried verbatim for
// the recorded row only; it is not remapped (in particular, a `message` object is never coerced to
// a grey channel such as WhatsApp — grey channels are excluded from this epic).

import {
  rankItem,
  RANKER_VERSION,
  EMPTY_REGISTRY,
  type Registry,
  type RankInput,
  type ThreadKind,
  type Bucket,
} from "./ranker.js";
import type { InboxItem, Ranker } from "./cli.js";
import type { ObservationParticipant, ProjectedItem } from "./observations.js";

/** Bucket → ordering priority (URGENT first). Mirrors the ranker's own private table; the protected
 *  partition precedes this regardless. Kept local so the adapter owns its ordering contract. */
const BUCKET_RANK: Readonly<Record<Bucket, number>> = {
  URGENT: 0,
  IMPORTANT: 1,
  FYI: 2,
  AWARENESS: 3,
};

function looksLikeEmail(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

/** The counterparty on a projected thread: the sender/organizer role if present, else the first
 *  participant. Used only for registry resolution; returns null when there are no participants. */
function pickCounterparty(obs: ProjectedItem): ObservationParticipant | null {
  const ps = Array.isArray(obs.participants) ? obs.participants : [];
  const from = ps.find(
    (p) => p.role === "from" || p.role === "sender" || p.role === "organizer"
  );
  return from ?? ps[0] ?? null;
}

/** thread-kind heuristic from the object kind + participant count. Email/calendar map to the
 *  structured `email-thread` (stage-0 mutes apply); a multi-party message is a `group`, else a `dm`. */
function threadKindOf(obs: ProjectedItem): ThreadKind {
  if (obs.object_kind === "email" || obs.object_kind === "calendar-event") return "email-thread";
  return Array.isArray(obs.participants) && obs.participants.length > 2 ? "group" : "dm";
}

/**
 * Normalize one unified inbox row into the ranker's `RankInput`.
 *
 *   • agent-event (ask): channel `agent-ask`, body = title + body (drives actionability). Agent asks
 *     have NO external human sender, so the sender is left empty → unresolved → tier-only/unprotected
 *     from the ranker (the open-blocker trust floor is applied as structural protection, not here).
 *   • thread-state (observation): channel = the object kind verbatim (never remapped); sender resolved
 *     from the counterparty participant; body = the snippet; thread-kind per `threadKindOf`.
 */
export function toRankInput(item: InboxItem, now: string): RankInput {
  if (item.origin === "agent-event" && item.ask) {
    const ask = item.ask;
    const body = [ask.title, ask.body].filter((s): s is string => !!s && s.trim() !== "").join("\n");
    return {
      channel: "agent-ask",
      sender: { account: null, handle: null, email: null, display: null },
      body,
      chatName: null,
      subject: null,
      fromAddress: null,
      threadKind: "dm",
      fromMe: false,
      correlationId: item.id,
      sentAt: item.ts,
      now,
    };
  }

  const obs = item.observation;
  if (!obs) {
    // Defensive: a thread row with no observation payload still ranks (fail-open, never a throw).
    return {
      channel: item.source ?? "unknown",
      sender: { account: null, handle: null, email: null, display: null },
      body: "",
      chatName: null,
      subject: null,
      fromAddress: null,
      threadKind: "dm",
      fromMe: false,
      correlationId: item.id,
      sentAt: item.ts,
      now,
    };
  }

  const cp = pickCounterparty(obs);
  const email = looksLikeEmail(cp?.id) ? cp!.id : null;
  return {
    // Channel is recorded verbatim — NOT remapped to any grey channel (WhatsApp excluded, AIO-429).
    channel: obs.object_kind,
    sender: {
      account: null, // obs.account is the OBSERVER's mailbox, not the counterparty — leave unresolved
      handle: cp?.id ?? null,
      email,
      display: cp?.display ?? null,
    },
    body: obs.snippet ?? "",
    chatName: null,
    subject: null,
    fromAddress: email,
    threadKind: threadKindOf(obs),
    fromMe: false,
    correlationId: item.id,
    sentAt: item.ts,
    now,
  };
}

/**
 * Build a concrete `Ranker` over the given registry (default `EMPTY_REGISTRY` → fail-open, tier-only,
 * everything unprotected but STILL the real ranker/version). Deterministic: same items + registry +
 * `now` → identical order, `why`, and protected set.
 *
 * Ordering within the returned list: protected partition first (registry OR structural), then bucket
 * priority (URGENT→AWARENESS), then signal desc, then recency desc, then a stable original-index
 * tiebreak. The CLI (`rankItems`) re-enforces the protected/unprotected split as a safety net, so the
 * partition invariant holds regardless of any injected ranker's behavior.
 */
export function createInboxRanker(
  registry: Registry = EMPTY_REGISTRY,
  opts: { now?: Date } = {}
): Ranker {
  return {
    version: RANKER_VERSION,
    rank(items) {
      const nowIso = (opts.now ?? new Date()).toISOString();
      const rows = items.map((item, idx) => {
        const result = rankItem(toRankInput(item, nowIso), registry);
        // Trust floor: union the ranker's registry verdict with the row's structural protection.
        const isProtected = result.protected || item.protected;
        return { item, result, isProtected, idx };
      });
      rows.sort((a, b) => {
        if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
        const br = BUCKET_RANK[a.result.bucket] - BUCKET_RANK[b.result.bucket];
        if (br !== 0) return br;
        if (b.result.signal !== a.result.signal) return b.result.signal - a.result.signal;
        const ra = Date.parse(a.item.ts) || 0;
        const rb = Date.parse(b.item.ts) || 0;
        if (rb !== ra) return rb - ra;
        return a.idx - b.idx;
      });
      const order = rows.map((r) => r.item);
      const why = new Map(rows.map((r) => [r.item.id, r.result.why]));
      const protectedIds = new Set(rows.filter((r) => r.isProtected).map((r) => r.item.id));
      return { order, why, protectedIds };
    },
  };
}
