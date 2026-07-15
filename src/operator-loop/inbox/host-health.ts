// Unified inbox — adapter-health projection (I-15 / AIO-396, the G6b gate).
//
// Turns the pure `AdapterHealth` snapshots from host-supervisor.ts into the two surfaces the spec's
// isolation/health contract requires:
//   1. `AdapterHealth` → a tier-tagged `Signal` (tier: admin) conforming to `src/operator-loop/signal.ts`
//      — host health never syncs to the Team Brain; it rides the same C1 signal contract as everything
//      else so the loop treats it uniformly.
//   2. `AdapterHealth` → an `InboxItem` with `origin: agent-event` — an unhealthy adapter shows up in
//      the SAME ranked queue as an agent ask, protected above the fold, so "the host is degraded" is
//      not a separate console the operator has to remember to check.
//
// Plus the durable, admin-tier host-health state file the coordinator writes and `aios inbox status`
// reads, and the coordinator-health summary that status renders.
//
// Domain isolation: value-imports only `../signal.js` (loop-core — allowed) and same-domain types.
// The `InboxItem`/`InboxHealthBadge` shapes are type-only references into the sibling `cli.ts` (the
// legitimate typed seam), so there is no runtime cycle.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Signal } from "../signal.js";
import { INBOX_DIR_REL } from "./journal.js";
import type { InboxItem, InboxHealthBadge } from "./cli.js";
import {
  ADAPTER_HEALTH_STATES,
  isUnhealthy,
  type AdapterHealth,
  type AdapterHealthState,
} from "./host-supervisor.js";

/** Workspace-relative path of the admin-tier host-health state file (never synced). */
export const HOST_HEALTH_BASENAME = "host-health.json";
export const HOST_HEALTH_REL = `${INBOX_DIR_REL}/${HOST_HEALTH_BASENAME}`;
export const HOST_HEALTH_STATE_VERSION = 1;

/** The `source` every AdapterHealth signal/row carries (mirrors the `host-supervisor` authority). */
export const HOST_HEALTH_SOURCE = "host-supervisor";

/** Bounds enforced when reading a (possibly corrupt/hostile) on-disk host-health record. */
export const MAX_ADAPTER_ID_LEN = 64;
export const MAX_DETAIL_LEN = 240;

const HEALTH_STATE_SET: ReadonlySet<string> = new Set(ADAPTER_HEALTH_STATES);
// Adapter ids are machine-generated identifiers — restrict to a safe, renderable charset so a corrupt
// or hostile state file can never inject control chars / ANSI / newlines into the inbox render path.
const SAFE_ID_RE = /[^A-Za-z0-9._:@-]/g;

// ── defensive validation of on-disk records (fail closed / sanitize content-free) ────────────────────

function coerceIntNonNeg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
function coerceIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
}
function coerceTsOrNull(v: unknown): number | null {
  // Timestamps are ms-epoch numbers; anything non-finite (or a string/object) is dropped to null.
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** Strip control chars (incl. newlines/ANSI) and cap length — keeps rendered text content-free. */
function sanitizeText(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  out = out.trim();
  return out.length > max ? out.slice(0, max) + "…" : out;
}

/**
 * Validate + sanitize ONE raw adapter record from the (untrusted) host-health file. Returns a clean
 * `AdapterHealth`, or `null` when the record is unusable (missing/invalid adapter id, or an
 * unrecognized `state`) — those are DROPPED (fail closed), never rendered. Every surviving field is
 * coerced to its safe type; `detail` is sanitized content-free; `healthy` is RE-DERIVED from `state`
 * so a record can't claim `healthy: true` while `state: "crash-looping"`.
 */
export function sanitizeAdapterHealth(raw: unknown): AdapterHealth | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const idRaw = typeof r.adapter === "string" ? r.adapter : "";
  const adapter = idRaw.replace(SAFE_ID_RE, "").slice(0, MAX_ADAPTER_ID_LEN);
  if (!adapter) return null; // no usable id → drop
  if (typeof r.state !== "string" || !HEALTH_STATE_SET.has(r.state)) return null; // unknown state → drop
  const state = r.state as AdapterHealthState;
  return {
    adapter,
    state,
    restarts: coerceIntNonNeg(r.restarts),
    recentExits: coerceIntNonNeg(r.recentExits),
    lastStartAt: coerceTsOrNull(r.lastStartAt),
    lastReadyAt: coerceTsOrNull(r.lastReadyAt),
    lastHeartbeatAt: coerceTsOrNull(r.lastHeartbeatAt),
    lastExitAt: coerceTsOrNull(r.lastExitAt),
    lastExitCode: coerceIntOrNull(r.lastExitCode),
    backoffUntil: coerceTsOrNull(r.backoffUntil),
    detail: sanitizeText(r.detail, MAX_DETAIL_LEN),
    healthy: state === "healthy", // derived, never trusted from the file
  };
}

// ── Signal projection (C1 contract, tier: admin) ─────────────────────────────────────────────────────

/**
 * Project one `AdapterHealth` onto a tier-tagged `Signal`. Always `tier: "admin"` — host health is
 * local-only and default-denied at the sync boundary. `ref.path` points at the admin-tier state file
 * (the evidence anchor); the payload is content-free (state / counts / codes only).
 */
export function adapterHealthSignal(h: AdapterHealth, occurredAtIso: string): Signal {
  return {
    kind: "inbox",
    source: HOST_HEALTH_SOURCE,
    tier: "admin",
    occurredAt: occurredAtIso,
    ref: { path: HOST_HEALTH_REL, tier: "admin" },
    summary: `adapter ${h.adapter}: ${h.state} — ${h.detail}`,
    payload: {
      adapter: h.adapter,
      state: h.state,
      restarts: h.restarts,
      recent_exits: h.recentExits,
      last_exit_code: h.lastExitCode,
      healthy: h.healthy,
    },
  };
}

// ── AttentionItem projection (origin: agent-event) ───────────────────────────────────────────────────

function badgeOf(h: AdapterHealth): InboxHealthBadge {
  return { adapter: h.adapter, state: h.state, detail: h.detail, restarts: h.restarts };
}

/**
 * Project one `AdapterHealth` onto an `InboxItem` (`origin: agent-event`). A degraded adapter is
 * PROTECTED (it renders above the ranking fold, like an open blocker); a healthy adapter maps to a
 * resolved, unprotected row (callers usually filter to unhealthy before surfacing). The row carries a
 * content-free `health` badge — no message bodies, no credentials.
 */
export function healthToInboxItem(h: AdapterHealth, occurredAtIso: string): InboxItem {
  const degraded = isUnhealthy(h);
  return {
    id: `host-health:${h.adapter}`,
    origin: "agent-event",
    source: `${HOST_HEALTH_SOURCE}:${h.adapter}`,
    account: null,
    bucket: degraded ? "needs-you" : "done",
    protected: degraded,
    why: `adapter-${h.state}`,
    attention_state: degraded ? "surfaced" : "resolved",
    action_state: "none",
    ts: occurredAtIso,
    health: badgeOf(h),
  };
}

/** Map a health map → the AttentionItem rows for the DEGRADED adapters only (what the queue shows). */
export function unhealthyInboxItems(
  healths: Iterable<AdapterHealth>,
  occurredAtIso: string
): InboxItem[] {
  const rows: InboxItem[] = [];
  for (const h of healths) if (isUnhealthy(h)) rows.push(healthToInboxItem(h, occurredAtIso));
  return rows;
}

// ── coordinator-health summary (for `aios inbox status`) ─────────────────────────────────────────────

export interface CoordinatorHealth {
  ok: boolean;
  adapters: AdapterHealth[];
  degraded: AdapterHealth[];
  counts: { total: number; healthy: number; degraded: number };
}

/** Summarize a health map for `aios inbox status` — `ok` iff every adapter is healthy. */
export function coordinatorHealthSummary(healths: Iterable<AdapterHealth>): CoordinatorHealth {
  const adapters = [...healths].sort((a, b) => a.adapter.localeCompare(b.adapter));
  const degraded = adapters.filter(isUnhealthy);
  const healthy = adapters.filter((h) => h.healthy).length;
  return {
    ok: degraded.length === 0,
    adapters,
    degraded,
    counts: { total: adapters.length, healthy, degraded: degraded.length },
  };
}

// ── durable state file (admin-tier local; never synced) ──────────────────────────────────────────────

interface HostHealthFile {
  state_version: number;
  generated_at: string;
  adapters: AdapterHealth[];
}

export function hostHealthPath(root: string): string {
  return path.join(root, INBOX_DIR_REL, HOST_HEALTH_BASENAME);
}

/**
 * Persist the coordinator's current per-adapter health to the admin-tier state file. The coordinator
 * writes this on every supervision tick; `aios inbox` / `aios inbox status` read it. NEVER added to
 * `sync_include`; default-denied at the sync boundary.
 */
export function writeHostHealth(
  root: string,
  healths: Iterable<AdapterHealth>,
  generatedAtIso: string
): void {
  const dir = path.join(root, INBOX_DIR_REL);
  mkdirSync(dir, { recursive: true });
  const body: HostHealthFile = {
    state_version: HOST_HEALTH_STATE_VERSION,
    generated_at: generatedAtIso,
    adapters: [...healths].sort((a, b) => a.adapter.localeCompare(b.adapter)),
  };
  writeFileSync(hostHealthPath(root), JSON.stringify(body, null, 2) + "\n", "utf8");
}

export interface HostHealthRead {
  generatedAt: string;
  /** Only VALID, sanitized records (invalid ones are dropped fail-closed). */
  adapters: AdapterHealth[];
  /** How many raw records were dropped as unusable (corrupt/hostile) — surfaced, never hidden. */
  dropped: number;
}

/**
 * Read + DEEPLY VALIDATE the host-health state file, or `null` when the coordinator has never written
 * it (or the file is unreadable/not JSON/not the expected shape). The file is UNTRUSTED input — a
 * corrupt or hostile file must never crash a read or inject content into the inbox render path. Every
 * record is run through `sanitizeAdapterHealth`: usable records are coerced + content-free-sanitized,
 * unusable ones (bad id / unknown state) are DROPPED and counted. `generatedAt` is sanitized too.
 */
export function readHostHealth(root: string): HostHealthRead | null {
  const p = hostHealthPath(root);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Partial<HostHealthFile>;
  if (!Array.isArray(obj.adapters)) return null;
  const adapters: AdapterHealth[] = [];
  let dropped = 0;
  for (const rec of obj.adapters) {
    const clean = sanitizeAdapterHealth(rec);
    if (clean) adapters.push(clean);
    else dropped++;
  }
  adapters.sort((a, b) => a.adapter.localeCompare(b.adapter));
  return {
    generatedAt: sanitizeText(obj.generated_at, MAX_DETAIL_LEN),
    adapters,
    dropped,
  };
}
