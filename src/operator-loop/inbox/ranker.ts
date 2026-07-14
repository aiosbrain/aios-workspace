// Unified inbox — deterministic ranking in SHADOW mode (I-04 / AIO-385).
//
// Ports the hermes-aluna digest's zero-LLM classification rules (spec Appendix A — the builder
// never needs that repo), adds the entity/project importance signal and the PROTECTED PARTITION,
// and runs in shadow: user-visible output is unchanged, every ranked row is recorded with a
// per-row `why` string + `ranker_version` into a LOCAL admin-tier sidecar. Nothing here ever
// syncs to the Team Brain.
//
// TIER-SAFETY (absolute, spec §Tier safety): comms plaintext, ranking `features`, and `why`-strings
// are admin-tier, LOCAL-ONLY. This module never writes to the canonical read-model projection (so the
// I-02 digest is byte-unchanged in shadow), never emits a Signal payload, and its sidecar path is
// never added to `sync_include`. The aios sync client default-denies admin/untagged content and the
// brain rejects any private push with 422 — nothing here ever reaches that path.
//
// HARDENING POSTURE (SIGNAL-MODULE-INTEGRATION.md): additive-only, shadow-first, never-degrade-into-
// failure. A missing/unreadable registry degrades to a coarser rank (tier-only, then unprotected),
// NEVER a crash, NEVER a blank/dropped item, NEVER a silent "protected" claim.
//
// Same-domain-only imports (no cross-domain value imports — the loop composes through index.ts). The
// deterministic core is pure (no wall clock, no I/O): `now`/`sentAt` are carried on the input.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { INBOX_DIR_REL } from "./journal.js";

/** Bump on any change to the formula, regexes, or bucket rules — the journal carries this per row so
 *  a later re-fit never mixes feature generations (SIGNAL-MODULE-INTEGRATION.md §7 ranker-version skew). */
export const RANKER_VERSION = "inbox-ranker-1.0.0-shadow";

/** Admin-tier LOCAL sidecar for shadow rows — NEVER synced, NEVER in sync_include. */
export const SHADOW_LOG_BASENAME = "ranking-shadow.ndjson";

export type Bucket = "URGENT" | "IMPORTANT" | "FYI" | "AWARENESS";
export type ThreadKind = "dm" | "group" | "email-thread";

/** Bucket priority for ordering (URGENT highest). Protected partition precedes this regardless. */
const BUCKET_RANK: Readonly<Record<Bucket, number>> = {
  URGENT: 0,
  IMPORTANT: 1,
  FYI: 2,
  AWARENESS: 3,
};

/** A sender identity, account/tenant-resolved upstream (identity-resolve join). All fields optional
 *  so an UNRESOLVED external sender still ranks (fail-open to raw-handle importance / unprotected). */
export interface SenderIdentity {
  account?: string | null; // resolved member/account id
  handle?: string | null; // raw handle (Slack U…, JID, @name)
  email?: string | null;
  display?: string | null; // display name
}

export interface RankInput {
  channel: string; // 'gmail' | 'whatsapp' | 'agent-ask' | …
  sender: SenderIdentity;
  body: string;
  chatName?: string | null; // group / chat name (vendorish match is on chat name + body)
  subject?: string | null; // email subject (email stage-0 mute)
  fromAddress?: string | null; // email From header (bulk-sender mute)
  threadKind: ThreadKind;
  fromMe: boolean; // from-me-last → AWARENESS
  correlationId?: string | null; // read-model correlation id, when known (recorded on the shadow row)
  sentAt?: string | null; // ISO — for age
  now?: string | null; // ISO reference for age; carried on input so the core stays deterministic
}

export interface RankResult {
  bucket: Bucket;
  protected: boolean;
  signal: number;
  why: string;
  ranker_version: string;
  features: Record<string, number>;
}

// ── relationship / project registry (the "who matters" source) ───────────────────────────────────
//
// The runtime registry is the operator's LOCAL private graph (engagement registry + per-person entity
// files). The test corpus ships its OWN fixture registry beside the tests, so `node --test` needs no
// live registry. Registry absent → every item ranks unprotected + tier-only (spec §Interface).

export interface RegistryPerson {
  /** Identity keys this person is matched by (account ids, emails, handles, display names). */
  ids: string[];
  tier?: 1 | 2 | 3 | 4; // relationship tier (1 = closest). Absent → unknown (weight 0).
  projectWeight?: number; // ppw ∈ [0,1] from the projects map. Absent → 0 (tier-only degradation).
  entityFile?: boolean; // an entity file exists for this counterparty
  engagement?: string; // 'active' | 'inactive' | … — protected requires 'active'
}

export interface Registry {
  present: boolean;
  /** True when at least one person carries a projectWeight (the "projects map exists" ordering seam). */
  projectsMap: boolean;
  people: RegistryPerson[];
  index: Map<string, RegistryPerson>; // normalized-id → person
}

const TIER_WEIGHT: Readonly<Record<number, number>> = { 1: 1.0, 2: 0.75, 3: 0.4, 4: 0.15 };

const EMPTY_REGISTRY: Registry = Object.freeze({
  present: false,
  projectsMap: false,
  people: [],
  index: new Map(),
});

function normKey(v: string): string {
  return v.trim().toLowerCase();
}

/** Build a Registry from a plain object (parsed fixture / runtime file). Never throws. */
export function buildRegistry(raw: unknown): Registry {
  if (!raw || typeof raw !== "object") return EMPTY_REGISTRY;
  const peopleRaw = (raw as { people?: unknown }).people;
  if (!Array.isArray(peopleRaw)) return EMPTY_REGISTRY;
  const people: RegistryPerson[] = [];
  const index = new Map<string, RegistryPerson>();
  let projectsMap = false;
  for (const p of peopleRaw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const ids = Array.isArray(o.ids)
      ? o.ids.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    if (ids.length === 0) continue;
    const tier =
      o.tier === 1 || o.tier === 2 || o.tier === 3 || o.tier === 4
        ? (o.tier as 1 | 2 | 3 | 4)
        : undefined;
    const projectWeight =
      typeof o.projectWeight === "number" && Number.isFinite(o.projectWeight)
        ? clamp01(o.projectWeight)
        : undefined;
    if (projectWeight !== undefined) projectsMap = true;
    const person: RegistryPerson = {
      ids,
      tier,
      projectWeight,
      entityFile: o.entityFile === true,
      engagement: typeof o.engagement === "string" ? o.engagement : undefined,
    };
    people.push(person);
    for (const id of ids) index.set(normKey(id), person);
  }
  return { present: true, projectsMap, people, index };
}

/**
 * Load the registry from a JSON file. Missing/unreadable/malformed → EMPTY_REGISTRY (fail-open:
 * everyone ranks unprotected + tier-only, and the caller's staleness header says "no registry
 * configured"). NEVER throws — a registry outage must never crash or stall ranking.
 */
export function loadRegistry(registryPath: string | null | undefined): Registry {
  if (!registryPath || !existsSync(registryPath)) return EMPTY_REGISTRY;
  try {
    return buildRegistry(JSON.parse(readFileSync(registryPath, "utf8")));
  } catch {
    return EMPTY_REGISTRY;
  }
}

/** Resolve a sender to a registry person: account → email → handle → display → chatName. */
export function resolvePerson(input: RankInput, registry: Registry): RegistryPerson | null {
  if (!registry.present) return null;
  const candidates = [
    input.sender.account,
    input.sender.email,
    input.sender.handle,
    input.sender.display,
    input.chatName,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") {
      const hit = registry.index.get(normKey(c));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The PROTECTED PARTITION (spec §Interface): entity file exists AND active engagement. Protected
 * items always precede unprotected regardless of signal. Fail-open: registry absent or sender
 * unresolved → false (unprotected) — NEVER a silent protected claim, NEVER a crash.
 */
export function protectedPartition(input: RankInput, registry: Registry): boolean {
  const p = resolvePerson(input, registry);
  if (!p) return false;
  return p.entityFile === true && p.engagement === "active";
}

// ── Appendix A — deterministic classification rules (authoritative extract) ───────────────────────

const RE_SYSTEM =
  /^(sent|missed (voice|video) call|this message was deleted|joined using|changed the (subject|group)|added|removed|left)\b/i;

// One-word acks (case-insensitive, punctuation-trimmed). Emoji acks included verbatim.
const RE_ACK =
  /^(ok(ay)?|k|ok sir|okey|alright|(great )?thanks?( you| so much| a lot)?|ty|thx|tq|noted|got it|understood|received|great|cool|nice|perfect|awesome|lovely|done|sure|yes|yep|yeah|no|nope|no problem|np|you're welcome|welcome|will do|roger|copy|good|good morning|good night|gm|gn|amazing|excellent|👍|🙏|❤️|🙂|😊|😁|🎉)$/i;

// Any letter/digit (incl. Latin-1 supplement + Latin Extended, À–ɏ) → NOT emoji/punctuation-only.
const RE_HAS_TEXT = /[A-Za-z0-9À-ɏ]/;

const RE_INTERROGATIVE =
  /\b(who|what|whats|when|where|why|how|which|can you|could you|would you|are you|will you|do you|did you|have you|should (i|we)|any (update|news|thoughts|chance))\b/;
const RE_REQUEST =
  /\b(please|pls|can you|could you|need (you|to|your)|send (me|over|the|it)|share|review|confirm|approve|sign|decide|let me know|lmk|get back|follow up|update me|waiting (for|on)|when can|are we still|shall we)\b/;
const RE_TIMEBOUND =
  /\b(today|tomorrow|urgent|asap|deadline|by (mon|tue|wed|thu|fri|sat|sun)|call me|need.{0,12}(now|soon))\b/;
const RE_SCHEDULE =
  /\b(meet|meeting|call|zoom|available|availability|schedule|reschedule|tonight|tomorrow|today|(mon|tue|wed|thu|fri|sat|sun)(day)?)\b|\b\d{1,2}\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}(st|nd|rd|th)\b/;
const RE_SOCIAL_CLOSER =
  /\b(congrat|glad to hear|well done|take care|god bless|safe travels|good luck|best wishes|miss you|love you)\b/;
const RE_VENDORISH =
  /\b(customer care|customer service|reservation|booking|confirmed|well noted|how can (i|we) help|clinic|spa|driver|resort|hotel|front desk|sales|support team|no further|thank you for (contacting|choosing)|(dapat|bisa) (saya|kami) bantu|terima kasih)\b/;

// Email stage-0 mutes.
const RE_EMAIL_AUTOREPLY =
  /^(automatic reply|auto[:-]|autoreply|out of office|ooo|undeliverable|delivery (status notification|has failed|failure)|read: |accepted: |declined: |cancelled: |canceled: |tentative: )/i;
const RE_EMAIL_BULK =
  /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|newsletter@|@(mailchimp|sendgrid|substack|beehiiv|mailerlite|hubspot))/i;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Trim leading/trailing whitespace + punctuation (for the ack match). Keeps emoji. */
function trimPunct(s: string): string {
  return s.replace(/^[\s\p{P}\p{S}]+/u, "").replace(/[\s\p{P}\p{S}]+$/u, "");
}

/** Stage 0 — noise gate (never IMPORTANT). */
export function isNoise(body: string): boolean {
  const b = body.trim();
  if (b === "") return true;
  if (RE_SYSTEM.test(b)) return true;
  if (!RE_HAS_TEXT.test(b)) return true; // emoji/punctuation-only
  const ack = trimPunct(b).toLowerCase();
  if (RE_ACK.test(ack)) return true;
  return false;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/** Actionability ∈ [0,1] (0.0 if noise). */
export function actionability(body: string, noise: boolean): number {
  if (noise) return 0;
  const b = body.toLowerCase();
  let score = 0;
  if (b.includes("?")) score += 0.5;
  if (RE_INTERROGATIVE.test(b)) score += 0.3;
  if (RE_REQUEST.test(b)) score += 0.4;
  if (RE_TIMEBOUND.test(b) || RE_SCHEDULE.test(b)) score += 0.3;
  if (score === 0 && RE_SOCIAL_CLOSER.test(b)) score = 0.05;
  else if (score === 0 && wordCount(body) <= 3) score = 0.1;
  return score > 1 ? 1 : score;
}

/** Importance ∈ [0,1] — who matters. Registry absent / project map absent → tier-only degradation. */
export function importanceOf(
  person: RegistryPerson | null,
  projectsMap: boolean
): { importance: number; tierWeight: number; ppw: number; tier: number | null } {
  const tier = person?.tier ?? null;
  const tierWeight = tier !== null ? (TIER_WEIGHT[tier] ?? 0) : 0;
  const hasPpw = typeof person?.projectWeight === "number";
  const ppw = hasPpw ? clamp01(person!.projectWeight as number) : 0;
  // Blend only when a projects map exists AND this person carries a weight; else tier-only.
  const importance = projectsMap && hasPpw ? clamp01(0.62 * ppw + 0.38 * tierWeight) : tierWeight;
  return { importance, tierWeight, ppw, tier };
}

/** Vendorish match is on chat name + body (deprioritize closed vendor exchanges). */
export function isVendorish(input: RankInput): boolean {
  const hay = `${input.chatName ?? ""} ${input.body}`.toLowerCase();
  return RE_VENDORISH.test(hay);
}

/** Email stage-0 mute: auto-reply subject OR bulk-sender From. */
function isEmailMuted(input: RankInput): boolean {
  if (input.threadKind !== "email-thread") return false;
  if (input.subject && RE_EMAIL_AUTOREPLY.test(input.subject.trim())) return true;
  if (input.fromAddress && RE_EMAIL_BULK.test(input.fromAddress)) return true;
  return false;
}

function ageDaysOf(input: RankInput): number | null {
  if (!input.sentAt || !input.now) return null;
  const sent = Date.parse(input.sentAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(sent) || !Number.isFinite(now)) return null;
  return (now - sent) / 86_400_000;
}

// ── the ranker ────────────────────────────────────────────────────────────────────────────────────

/**
 * Rank one item deterministically (Appendix A). Pure: same input + registry → same RankResult.
 * Fail-open everywhere — an unresolved sender / absent registry degrades to a coarser rank, never
 * a throw and never a blank item.
 */
export function rankItem(input: RankInput, registry: Registry = EMPTY_REGISTRY): RankResult {
  const person = resolvePerson(input, registry);
  const isProtected = person ? person.entityFile === true && person.engagement === "active" : false;

  const emailMuted = isEmailMuted(input);
  const noise = emailMuted || isNoise(input.body);
  const act = actionability(input.body, noise);
  const { importance, tierWeight, ppw, tier } = importanceOf(person, registry.projectsMap);
  const vendorish = isVendorish(input);
  const ageDays = ageDaysOf(input);

  // Signal = importance^0.5 × (0.3 + 0.7·actionability).
  const signal = Math.sqrt(importance) * (0.3 + 0.7 * act);

  const tierLE = (n: number): boolean => tier !== null && tier <= n;
  const tierEQ = (n: number): boolean => tier === n;

  let bucket: Bucket;
  let why: string;

  if (input.fromMe) {
    bucket = "AWARENESS";
    why = "from-me-last → AWARENESS";
  } else if (noise) {
    bucket = "AWARENESS";
    why = emailMuted
      ? "email stage-0 mute (auto-reply/bulk sender) → AWARENESS"
      : "noise gate → AWARENESS";
  } else if (input.threadKind === "group") {
    // Groups: IMPORTANT iff actionability ≥ 0.5 and not vendorish, else AWARENESS.
    if (act >= 0.5 && !vendorish) {
      bucket = "IMPORTANT";
      why = `group, actionability ${act.toFixed(2)} ≥ 0.5, not vendorish → IMPORTANT`;
    } else {
      bucket = "AWARENESS";
      why = vendorish
        ? "group, vendorish → AWARENESS"
        : `group, actionability ${act.toFixed(2)} < 0.5 → AWARENESS`;
    }
  } else {
    // DMs (and email-threads, post stage-0): the needs / URGENT / FYI cascade.
    const needs =
      act >= 0.4 ||
      (tierLE(2) && act >= 0.25) ||
      (importance >= 0.6 && act >= 0.25) ||
      (tierEQ(1) && act > 0);
    if (needs && !vendorish) {
      const urgent =
        ageDays !== null && ageDays <= 2 && act >= 0.5 && (tierLE(2) || importance >= 0.6);
      if (urgent) {
        bucket = "URGENT";
        why = `DM needs-reply; age ${ageDays!.toFixed(1)}d ≤ 2, act ${act.toFixed(2)} ≥ 0.5, tier${
          tier ?? "?"
        }/imp ${importance.toFixed(2)} → URGENT`;
      } else {
        bucket = "IMPORTANT";
        const ageNote = ageDays === null ? "age unknown (coarser)" : `age ${ageDays.toFixed(1)}d`;
        why = `DM needs-reply; act ${act.toFixed(2)}, ${ageNote}, tier${tier ?? "?"}/imp ${importance.toFixed(
          2
        )} → IMPORTANT`;
      }
    } else if (!vendorish && (importance >= 0.4 || tierLE(3))) {
      bucket = "FYI";
      why = `DM, no needs-reply; importance ${importance.toFixed(2)}/tier${tier ?? "?"} → FYI`;
    } else {
      bucket = "AWARENESS";
      why = vendorish
        ? "DM, vendorish → AWARENESS"
        : `DM, no needs-reply, importance ${importance.toFixed(2)}/tier${tier ?? "?"} → AWARENESS`;
    }
  }

  const features: Record<string, number> = {
    actionability: round4(act),
    importance: round4(importance),
    signal: round4(signal),
    tier_weight: round4(tierWeight),
    ppw: round4(ppw),
    tier: tier ?? 0,
    age_days: ageDays === null ? -1 : round4(ageDays),
    noise: noise ? 1 : 0,
    vendorish: vendorish ? 1 : 0,
    protected: isProtected ? 1 : 0,
    bucket_rank: BUCKET_RANK[bucket],
  };

  return {
    bucket,
    protected: isProtected,
    signal: round4(signal),
    why,
    ranker_version: RANKER_VERSION,
    features,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ── corpus ranking + the protected partition ordering ─────────────────────────────────────────────

export interface RankedRow {
  input: RankInput;
  result: RankResult;
}

/**
 * Rank a whole corpus and order it. PROTECTED PARTITION: every protected item precedes every
 * unprotected item regardless of signal (the trust floor). Within a partition: by bucket priority,
 * then signal desc when the projects map exists (recency desc otherwise — the Phase-1 degradation),
 * with a stable index tiebreak so the order is fully deterministic.
 */
export function rankCorpus(
  items: readonly RankInput[],
  registry: Registry = EMPTY_REGISTRY
): RankedRow[] {
  const projectsMap = registry.projectsMap;
  const rows = items.map((input, idx) => ({ input, result: rankItem(input, registry), idx }));
  rows.sort((a, b) => {
    // 1) protected precedes unprotected — regardless of signal.
    if (a.result.protected !== b.result.protected) return a.result.protected ? -1 : 1;
    // 2) bucket priority.
    const br = BUCKET_RANK[a.result.bucket] - BUCKET_RANK[b.result.bucket];
    if (br !== 0) return br;
    // 3) signal desc (projects map) or recency desc (otherwise).
    if (projectsMap) {
      if (b.result.signal !== a.result.signal) return b.result.signal - a.result.signal;
    }
    const ra = Date.parse(a.input.sentAt ?? "") || 0;
    const rb = Date.parse(b.input.sentAt ?? "") || 0;
    if (rb !== ra) return rb - ra;
    // 4) stable tiebreak on original index.
    return a.idx - b.idx;
  });
  return rows.map(({ input, result }) => ({ input, result }));
}

// ── shadow recording (admin-tier LOCAL sidecar; NEVER synced) ─────────────────────────────────────

/** One recorded shadow row. Carries plaintext-derived `why`/`features` → admin-tier local only. */
export interface ShadowRow {
  ts: string;
  correlation_id: string | null;
  channel: string;
  thread_kind: ThreadKind;
  bucket: Bucket;
  protected: boolean;
  signal: number;
  why: string;
  ranker_version: string;
  features: Record<string, number>;
}

export function shadowLogPath(root: string): string {
  return path.join(root, INBOX_DIR_REL, SHADOW_LOG_BASENAME);
}

/**
 * Record ranked rows into the admin-tier LOCAL shadow sidecar. This is DELIBERATELY separate from
 * the canonical read-model projection — in shadow mode the I-02 read-model digest must be byte-
 * unchanged, so ranking writes here and NEVER appends an inbox-event or mutates a projection table.
 * Returns the rows written (also the value the CLI would surface, unchanged from live output).
 */
export function recordShadowRanking(root: string, rows: readonly RankedRow[]): ShadowRow[] {
  const dir = path.join(root, INBOX_DIR_REL);
  mkdirSync(dir, { recursive: true });
  const file = shadowLogPath(root);
  const out: ShadowRow[] = rows.map(({ input, result }) => ({
    ts: input.now ?? input.sentAt ?? "",
    correlation_id: input.correlationId ?? null,
    channel: input.channel,
    thread_kind: input.threadKind,
    bucket: result.bucket,
    protected: result.protected,
    signal: result.signal,
    why: result.why,
    ranker_version: result.ranker_version,
    features: result.features,
  }));
  if (out.length > 0) {
    appendFileSync(file, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return out;
}

export { EMPTY_REGISTRY };
