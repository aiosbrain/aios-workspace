/**
 * analysis-cache.mjs — shared server-side cache for the 30-day `aios analyze --json`
 * document behind /api/maturity and /api/costs (AIO-453).
 *
 * Both routes reshape the SAME analyze document, but each request used to spawn its
 * own fresh subprocess (6–7s per navigation). One cache instance fixes both at once:
 *
 *   • fresh window (60s): a warm hit serves the in-memory snapshot, no subprocess;
 *   • stale-while-revalidate: a stale hit returns the last-good snapshot immediately
 *     and kicks ONE background refresh;
 *   • single-flight: concurrent requests (cold or stale) share one inflight run —
 *     at most one `aios analyze` subprocess exists at a time;
 *   • 30s subprocess timeout: the run is aborted (execFile kills the child on
 *     signal abort) and surfaces a typed `AnalyzeTimeoutError` (`code:
 *     "ANALYZE_TIMEOUT"`);
 *   • persistence: the last successful snapshot is written to
 *     `.aios/gui/analysis-snapshot.json` (admin-tier, local-only, never synced) so
 *     the first render after a server restart is instant. Corrupt or missing
 *     snapshot files are ignored — the cache just recomputes;
 *   • failure keeps last-good: a failed refresh never evicts the snapshot; the
 *     error message is exposed as `lastError` on every response until a refresh
 *     succeeds again;
 *   • failure backoff: after a failed refresh, stale hits do NOT start a new
 *     background refresh for `failureBackoffMs` (60s) — they serve last-good with
 *     `refreshing: false` + `lastError` set, so a persistently failing analyze
 *     converges to one attempt per window instead of one per request (and the
 *     client's refresh-poll loop terminates). A successful refresh clears the
 *     backoff.
 *
 * Like maturity.mjs / costs.mjs this module is pure ESM with no server side
 * effects, so it can be unit-tested with an injected `exec` + clock.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export const FRESH_MS = 60_000;
export const ANALYZE_TIMEOUT_MS = 30_000;
export const FAILURE_BACKOFF_MS = 60_000;

/** Typed timeout failure — `code` lets callers distinguish it from analyze errors. */
export class AnalyzeTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`analyze timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AnalyzeTimeoutError";
    this.code = "ANALYZE_TIMEOUT";
  }
}

/**
 * @param {object} opts
 * @param {(signal: AbortSignal) => Promise<string>} opts.exec — runs
 *   `aios analyze --json --since 30d` and resolves with its raw stdout. MUST honor
 *   the AbortSignal (node's execFile `signal` option kills the child on abort).
 * @param {string} opts.snapshotFile — path of the persisted last-good snapshot.
 * @param {number} [opts.freshMs] — how long a snapshot serves without a refresh.
 * @param {number} [opts.failureBackoffMs] — how long after a failed refresh before
 *   a stale hit may start another background attempt.
 * @param {number} [opts.timeoutMs] — subprocess timeout.
 * @param {() => number} [opts.now] — clock seam for tests.
 * @param {(msg: string) => void} [opts.log] — non-fatal diagnostics sink.
 */
export function createAnalysisCache({
  exec,
  snapshotFile,
  freshMs = FRESH_MS,
  failureBackoffMs = FAILURE_BACKOFF_MS,
  timeoutMs = ANALYZE_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
}) {
  /** @type {{raw: string, generatedAt: number} | null} last-good analyze stdout */
  let snapshot = null;
  /** @type {string | null} message of the last failed refresh; null when healthy */
  let lastError = null;
  /** @type {number | null} when the last refresh failed — gates the stale-hit retry */
  let lastFailureAt = null;
  /** @type {Promise<void> | null} the single-flight inflight refresh */
  let inflight = null;

  // Load the persisted snapshot (best effort — corrupt/missing files are ignored
  // and the cache simply recomputes on the first request).
  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, "utf8"));
    if (parsed && typeof parsed.raw === "string" && Number.isFinite(parsed.generatedAt)) {
      JSON.parse(parsed.raw); // the stored document itself must still parse
      snapshot = { raw: parsed.raw, generatedAt: parsed.generatedAt };
    }
  } catch {
    /* no usable snapshot — cold start */
  }

  function persist() {
    try {
      mkdirSync(path.dirname(snapshotFile), { recursive: true });
      const tmp = `${snapshotFile}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: 1, generatedAt: snapshot.generatedAt, raw: snapshot.raw })
      );
      renameSync(tmp, snapshotFile); // atomic-ish: never leaves a torn snapshot
    } catch (e) {
      log(`analysis-cache: snapshot persist failed: ${e.message}`); // non-fatal
    }
  }

  /** Single-flight refresh: concurrent callers share one subprocess. */
  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new AnalyzeTimeoutError(timeoutMs)), timeoutMs);
      // Race the abort explicitly so a runner that ignores the signal can't wedge
      // the cache — the subprocess is still killed via the signal.
      const aborted = new Promise((_, reject) => {
        ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
      });
      try {
        const raw = await Promise.race([exec(ac.signal), aborted]);
        JSON.parse(raw); // a "successful" run must yield a parseable document
        snapshot = { raw, generatedAt: now() };
        lastError = null;
        lastFailureAt = null; // success clears the failure backoff
        persist();
      } catch (e) {
        const err = ac.signal.aborted ? (ac.signal.reason ?? e) : e;
        lastError = err?.message || String(err);
        lastFailureAt = now();
        throw err;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    inflight.catch(() => {}); // background callers may not await — never unhandled
    return inflight;
  }

  function meta() {
    return {
      generatedAt: new Date(snapshot.generatedAt).toISOString(),
      ageMs: Math.max(0, now() - snapshot.generatedAt),
      refreshing: inflight !== null,
      lastError,
    };
  }

  /**
   * Resolve the current analyze document + freshness metadata.
   * Warm → immediate; stale → immediate + background refresh (unless a recent
   * failure has it backed off — then `refreshing: false` with `lastError` set, so
   * degraded mode converges); cold → awaits the (single-flight) run and rejects
   * only when there is no last-good snapshot at all.
   * @returns {Promise<{raw: string, generatedAt: string, ageMs: number, refreshing: boolean, lastError: string | null}>}
   */
  async function get() {
    if (snapshot) {
      const stale = now() - snapshot.generatedAt >= freshMs;
      const backedOff = lastFailureAt !== null && now() - lastFailureAt < failureBackoffMs;
      if (stale && !backedOff) refresh(); // stale-while-revalidate
      return { raw: snapshot.raw, ...meta() };
    }
    await refresh(); // cold: block on the shared run
    return { raw: snapshot.raw, ...meta() };
  }

  return { get, refresh };
}
