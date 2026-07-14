// Unified inbox — adapter supervision (I-15 / AIO-396, the G6b Fly-coordinator gate).
//
// The coordinator hosts N channel adapters (gog/Gmail, WhatsApp, Telegram, …). On the remote Fly
// machine each adapter runs SUPERVISED: a restart policy, exponential backoff, and crash-loop
// detection. This module is the PURE, deterministic core of that supervision — a fold over a
// stream of `SupervisorEvent`s (start/ready/heartbeat/exit/kill) into a per-adapter `AdapterHealth`
// snapshot. No process spawning, no wall-clock: the driver (real supervisor on Fly, or the faked
// supervisor in `inbox-host-health.test.mjs`) emits events with an injected `at` (ms epoch) and asks
// this module "what is each adapter's health as of `asOf`". That injectability is exactly what lets
// the kill→AttentionItem behaviour be asserted deterministically without a live host.
//
// Health here is ADMIN-TIER host state — it never syncs to the Team Brain (see host-health.ts for
// the Signal/AttentionItem projection and the on-disk state file). This module value-imports nothing
// cross-domain; it is self-contained inbox-domain logic.

// ── policy ───────────────────────────────────────────────────────────────────────────────────────

export interface SupervisorPolicy {
  /** No heartbeat within this window while `healthy` → the adapter is flagged `unhealthy`. */
  heartbeatTimeoutMs: number;
  /** First restart waits this long; each subsequent restart multiplies by `backoffFactor`. */
  backoffBaseMs: number;
  backoffFactor: number;
  /** Backoff is capped here so a wedged adapter retries on a bounded cadence, never never-again. */
  backoffMaxMs: number;
  /** Exits are counted within a trailing window of this width for crash-loop detection. */
  crashWindowMs: number;
  /** ≥ this many exits inside `crashWindowMs` → `crash-looping` (louder than a single backoff). */
  crashLoopThreshold: number;
  /** Hard cap on lifetime restarts; once exceeded the adapter is parked `stopped` (no auto-retry). */
  maxRestarts: number;
}

/** Conservative defaults; the Fly manifest / runbook can tune these per adapter. */
export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = Object.freeze({
  heartbeatTimeoutMs: 90_000,
  backoffBaseMs: 1_000,
  backoffFactor: 2,
  backoffMaxMs: 60_000,
  crashWindowMs: 120_000,
  crashLoopThreshold: 3,
  maxRestarts: 20,
});

// ── events + health shapes ─────────────────────────────────────────────────────────────────────────

export type SupervisorEventKind = "start" | "ready" | "heartbeat" | "exit" | "kill";

export interface SupervisorEvent {
  adapter: string;
  kind: SupervisorEventKind;
  /** ms epoch — INJECTED (never `Date.now()` here) so the fold is deterministic + replayable. */
  at: number;
  /** For `exit`: the process exit code (non-zero = crash). Ignored for other kinds. */
  code?: number;
  /** Free-text cause, surfaced in `detail` (content-free: no message bodies). */
  reason?: string;
}

/**
 * `starting`   — spawned, not yet ready (no `ready` seen since the last start/exit).
 * `healthy`    — ready and heartbeating within the timeout.
 * `unhealthy`  — was healthy but the heartbeat lapsed past `heartbeatTimeoutMs`.
 * `backoff`    — exited; waiting out the backoff before the next restart.
 * `crash-looping` — exited ≥ `crashLoopThreshold` times inside `crashWindowMs`.
 * `stopped`    — lifetime restarts exceeded `maxRestarts`; parked, no auto-retry (needs an operator).
 */
export type AdapterHealthState =
  "starting" | "healthy" | "unhealthy" | "backoff" | "crash-looping" | "stopped";

/** The runtime-checkable set of every legal `AdapterHealthState` (used to validate on-disk records). */
export const ADAPTER_HEALTH_STATES: readonly AdapterHealthState[] = [
  "starting",
  "healthy",
  "unhealthy",
  "backoff",
  "crash-looping",
  "stopped",
];

export interface AdapterHealth {
  adapter: string;
  state: AdapterHealthState;
  /** Lifetime restart count (one per observed exit/kill). */
  restarts: number;
  /** Exits within the trailing `crashWindowMs` ending at `asOf`. */
  recentExits: number;
  lastStartAt: number | null;
  lastReadyAt: number | null;
  lastHeartbeatAt: number | null;
  lastExitAt: number | null;
  lastExitCode: number | null;
  /** Earliest ms epoch at which a restart is allowed (backoff), or null when not backing off. */
  backoffUntil: number | null;
  /** Content-free one-line explanation of the current state. */
  detail: string;
  /** Convenience mirror: `false` for every non-`healthy` state. */
  healthy: boolean;
}

/** The four states that constitute a demand on the operator's attention (→ an AttentionItem). */
const ATTENTION_STATES: ReadonlySet<AdapterHealthState> = new Set([
  "unhealthy",
  "backoff",
  "crash-looping",
  "stopped",
]);

/** True iff `h` should surface in the inbox as something the operator may need to act on. */
export function isUnhealthy(h: AdapterHealth): boolean {
  return ATTENTION_STATES.has(h.state);
}

// ── backoff ────────────────────────────────────────────────────────────────────────────────────────

/** Exponential backoff for the Nth restart (1-based), capped at `backoffMaxMs`. */
export function backoffFor(restart: number, policy: SupervisorPolicy): number {
  if (restart <= 0) return 0;
  const raw = policy.backoffBaseMs * Math.pow(policy.backoffFactor, restart - 1);
  return Math.min(raw, policy.backoffMaxMs);
}

// ── fold (pure: events → per-adapter health as of `asOf`) ────────────────────────────────────────────

interface Mutable {
  adapter: string;
  state: AdapterHealthState;
  restarts: number;
  exitTimes: number[];
  lastStartAt: number | null;
  lastReadyAt: number | null;
  lastHeartbeatAt: number | null;
  lastExitAt: number | null;
  lastExitCode: number | null;
  backoffUntil: number | null;
  lastReason: string | null;
}

function fresh(adapter: string): Mutable {
  return {
    adapter,
    state: "starting",
    restarts: 0,
    exitTimes: [],
    lastStartAt: null,
    lastReadyAt: null,
    lastHeartbeatAt: null,
    lastExitAt: null,
    lastExitCode: null,
    backoffUntil: null,
    lastReason: null,
  };
}

function recentExits(exitTimes: readonly number[], asOf: number, windowMs: number): number {
  const cutoff = asOf - windowMs;
  let n = 0;
  for (const t of exitTimes) if (t >= cutoff) n++;
  return n;
}

function detailFor(m: Mutable, recent: number, asOf: number): string {
  switch (m.state) {
    case "healthy":
      return `healthy (last heartbeat ${m.lastHeartbeatAt != null ? asOf - m.lastHeartbeatAt : "?"}ms ago)`;
    case "starting":
      return "starting (awaiting ready)";
    case "unhealthy":
      return `heartbeat lapsed (${m.lastHeartbeatAt != null ? asOf - m.lastHeartbeatAt : "?"}ms since last)`;
    case "backoff":
      return `exited code=${m.lastExitCode ?? "?"}${m.lastReason ? ` (${m.lastReason})` : ""}; backoff until +${m.backoffUntil != null ? m.backoffUntil - asOf : "?"}ms`;
    case "crash-looping":
      return `crash-looping: ${recent} exit(s) in window (last code=${m.lastExitCode ?? "?"})`;
    case "stopped":
      return `parked after ${m.restarts} restarts (maxRestarts exceeded)`;
  }
}

/**
 * Fold a seq of supervisor events into each adapter's health snapshot AS OF `asOf` (ms epoch).
 * Deterministic and total: unknown/interleaved events never throw. Event order is honoured as given
 * (drivers emit in `at` order); `asOf` applies the two time-relative rules (heartbeat-timeout and
 * backoff-expiry) exactly once at the end, so the result is a pure function of (events, policy, asOf).
 */
export function foldSupervisor(
  events: readonly SupervisorEvent[],
  policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
  asOf?: number
): Map<string, AdapterHealth> {
  const byAdapter = new Map<string, Mutable>();
  let maxAt = 0;
  const get = (a: string): Mutable => {
    let m = byAdapter.get(a);
    if (!m) {
      m = fresh(a);
      byAdapter.set(a, m);
    }
    return m;
  };

  for (const ev of events) {
    if (!ev || typeof ev.adapter !== "string" || typeof ev.at !== "number") continue;
    if (ev.at > maxAt) maxAt = ev.at;
    const m = get(ev.adapter);
    switch (ev.kind) {
      case "start":
        m.lastStartAt = ev.at;
        m.backoffUntil = null;
        // A start clears a transient unhealthy/backoff; crash-loop history (exitTimes) is retained.
        m.state = "starting";
        m.lastReason = ev.reason ?? null;
        break;
      case "ready":
        m.lastReadyAt = ev.at;
        m.lastHeartbeatAt = ev.at;
        m.state = "healthy";
        m.backoffUntil = null;
        break;
      case "heartbeat":
        m.lastHeartbeatAt = ev.at;
        // A heartbeat only means "alive" once ready has been seen; before ready it stays `starting`.
        if (m.state === "healthy" || m.state === "unhealthy") m.state = "healthy";
        break;
      case "kill":
      case "exit": {
        m.exitTimes.push(ev.at);
        m.restarts += 1;
        m.lastExitAt = ev.at;
        m.lastExitCode = typeof ev.code === "number" ? ev.code : ev.kind === "kill" ? 137 : null;
        m.lastReason = ev.reason ?? (ev.kind === "kill" ? "killed" : null);
        const recent = recentExits(m.exitTimes, ev.at, policy.crashWindowMs);
        if (m.restarts > policy.maxRestarts) {
          m.state = "stopped";
          m.backoffUntil = null;
        } else if (recent >= policy.crashLoopThreshold) {
          m.state = "crash-looping";
          m.backoffUntil = ev.at + backoffFor(m.restarts, policy);
        } else {
          m.state = "backoff";
          m.backoffUntil = ev.at + backoffFor(m.restarts, policy);
        }
        break;
      }
    }
  }

  const at = asOf ?? maxAt;
  const out = new Map<string, AdapterHealth>();
  for (const m of byAdapter.values()) {
    // Time-relative rule: a healthy adapter whose heartbeat has lapsed is unhealthy as of `at`.
    // (An exited adapter is NOT auto-cleared when its backoff window elapses — it stays surfaced
    // until an explicit `start`+`ready` confirms recovery. Otherwise a killed adapter would silently
    // drop off the attention queue the instant the backoff timer expired, before it actually came
    // back. `backoffUntil` remains informational: "the supervisor will retry at/after this time".)
    if (
      m.state === "healthy" &&
      m.lastHeartbeatAt != null &&
      at - m.lastHeartbeatAt > policy.heartbeatTimeoutMs
    ) {
      m.state = "unhealthy";
    }
    const recent = recentExits(m.exitTimes, at, policy.crashWindowMs);
    out.set(m.adapter, {
      adapter: m.adapter,
      state: m.state,
      restarts: m.restarts,
      recentExits: recent,
      lastStartAt: m.lastStartAt,
      lastReadyAt: m.lastReadyAt,
      lastHeartbeatAt: m.lastHeartbeatAt,
      lastExitAt: m.lastExitAt,
      lastExitCode: m.lastExitCode,
      backoffUntil: m.backoffUntil,
      detail: detailFor(m, recent, at),
      healthy: m.state === "healthy",
    });
  }
  return out;
}
