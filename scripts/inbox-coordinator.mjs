#!/usr/bin/env node
/**
 * inbox-coordinator.mjs — the long-running Fly coordinator daemon (I-15 / AIO-396, the G6b gate).
 *
 * This is the REAL image entrypoint (replacing the earlier placeholder `aios inbox status` CMD). It:
 *   • runs the SUPERVISION LOOP: every tick it folds the observed adapter lifecycle events
 *     (`.aios/loop/inbox/supervisor-events.ndjson`, appended by the channel adapters) into per-adapter
 *     `AdapterHealth` and persists the admin-tier host-health state file — the exact state
 *     `aios inbox` / `aios inbox status` read. The event log is READ-BOUNDED (only the tail is read)
 *     and GROWTH-BOUNDED (rotated to a single `.1` generation once it exceeds a cap), so neither disk
 *     nor memory can grow/read unbounded;
 *   • exposes an INTERNAL, AUTHENTICATED `/healthz` liveness endpoint returning 200 while every
 *     adapter is healthy and 503 when degraded — content-free (counts only, no bodies/creds);
 *   • REFUSES TO START on a non-loopback bind unless `AIOS_HEALTHZ_TOKEN` is present AND strong
 *     (≥ 24 chars) — so a 0.0.0.0 bind (Fly) can never expose an unauthenticated healthz. On a
 *     non-loopback bind every /healthz request must carry the bearer token; loopback may omit it;
 *   • publishes NO other route; handles SIGTERM/SIGINT: stop the loop, flush a final state write,
 *     close the server, exit 0.
 *
 * The read-model API itself (device-token gated) is a separate surface; this daemon is the supervisor
 * + liveness process. Admin-tier local only; nothing syncs to the Team Brain. Deploy to Fly stays
 * MERGE-GATED on I-11 / PR #321 — this file makes the runtime honest and testable locally now.
 *
 * Env:
 *   AIOS_INBOX_DATA_DIR      workspace root holding `.aios/loop/inbox/` (default: cwd)
 *   AIOS_HOST_BIND           healthz bind address (default: 127.0.0.1; Fly sets 0.0.0.0, private-net)
 *   AIOS_HEALTHZ_PORT        healthz port (default: 8081 — matches deploy/fly/fly.toml.template)
 *   AIOS_HEALTHZ_TOKEN       bearer token for /healthz. REQUIRED (strong) on a non-loopback bind.
 *   AIOS_COORDINATOR_INTERVAL_MS  supervision tick interval (default: 5000)
 */

import { createServer } from "node:http";
import {
  openSync,
  readSync,
  fstatSync,
  closeSync,
  renameSync,
  statSync,
  existsSync,
} from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

const SUPERVISOR_EVENTS_BASENAME = "supervisor-events.ndjson";
const HEALTHZ_PATH = "/healthz";

// Bounds on the observed-events log so a hostile/runaway adapter can't grow disk or blow read memory.
export const SUPERVISOR_EVENTS_MAX_READ_BYTES = 256 * 1024; // tail read per file
export const SUPERVISOR_EVENTS_ROTATE_BYTES = 1024 * 1024; // rotate active → .1 past this
export const SUPERVISOR_EVENTS_MAX_EVENTS = 5000; // cap parsed events per tick

// Loopback addresses that may serve /healthz WITHOUT a token; everything else is "external".
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);
export const MIN_HEALTHZ_TOKEN_LEN = 24;

export function isLoopbackBind(host) {
  return LOOPBACK_BINDS.has(host);
}

function eventsPath(root) {
  return path.join(root, ".aios", "loop", "inbox", SUPERVISOR_EVENTS_BASENAME);
}

/** Read at most `maxBytes` from the END of `file`, dropping a leading partial line when truncated. */
function readTail(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    let s = buf.toString("utf8");
    if (start > 0) {
      const nl = s.indexOf("\n"); // drop the partial first line the byte-window cut through
      s = nl >= 0 ? s.slice(nl + 1) : "";
    }
    return s;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** Rotate `active` → `active.1` (single generation, overwriting a prior `.1`) once it exceeds `cap`. */
function rotateIfLarge(active, cap) {
  try {
    if (statSync(active).size > cap) renameSync(active, active + ".1");
  } catch {
    /* file absent or rotation raced — the next tick retries; never fatal */
  }
}

/**
 * Parse the observed-events NDJSON into SupervisorEvent objects — BOUNDED in both directions:
 * growth is capped by rotating the active file to a single `.1`, and the read is capped by tailing
 * only `maxReadBytes` of each of `.1` + active and keeping at most `maxEvents`. Malformed lines are
 * skipped so a torn/garbage line never wedges the supervisor.
 */
export function readSupervisorEvents(root, opts = {}) {
  const maxReadBytes = opts.maxReadBytes ?? SUPERVISOR_EVENTS_MAX_READ_BYTES;
  const rotateBytes = opts.rotateBytes ?? SUPERVISOR_EVENTS_ROTATE_BYTES;
  const maxEvents = opts.maxEvents ?? SUPERVISOR_EVENTS_MAX_EVENTS;
  const file = eventsPath(root);
  rotateIfLarge(file, rotateBytes); // bound growth BEFORE reading

  const chunks = [];
  const rotated = file + ".1";
  if (existsSync(rotated)) chunks.push(readTail(rotated, maxReadBytes)); // recent history first
  chunks.push(readTail(file, maxReadBytes));

  const out = [];
  for (const line of chunks.join("\n").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (
        ev &&
        typeof ev.adapter === "string" &&
        typeof ev.at === "number" &&
        typeof ev.kind === "string"
      ) {
        out.push(ev);
      }
    } catch {
      /* torn/garbage line — skip */
    }
  }
  return out.length > maxEvents ? out.slice(out.length - maxEvents) : out;
}

/** Auth gate: with a token, require an exact Bearer match. Without one, allow ONLY on loopback. */
function bearerOk(headerValue, token, loopback) {
  if (!token) return loopback; // no token → open on loopback, DENIED on any external bind
  const m = /^Bearer\s+(.+)$/.exec(headerValue ?? "");
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Start the coordinator. Returns a handle with `tick()`, `summary()`, and `stop()`. `clock` is
 * injectable for deterministic tests; defaults to Date.now. Throws (fail-closed) BEFORE listening if
 * the bind is non-loopback without a present + strong `AIOS_HEALTHZ_TOKEN`.
 */
export function startCoordinator(loop, opts = {}) {
  const root = opts.root ?? process.env.AIOS_INBOX_DATA_DIR ?? process.cwd();
  const host = opts.host ?? process.env.AIOS_HOST_BIND ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.AIOS_HEALTHZ_PORT ?? 8081);
  const intervalMs = opts.intervalMs ?? Number(process.env.AIOS_COORDINATOR_INTERVAL_MS ?? 5000);
  const token = opts.token ?? process.env.AIOS_HEALTHZ_TOKEN ?? "";
  const policy = opts.policy ?? loop.DEFAULT_SUPERVISOR_POLICY;
  const clock = opts.clock ?? (() => Date.now());

  const loopback = isLoopbackBind(host);
  // FAIL CLOSED: a non-loopback bind (e.g. Fly's 0.0.0.0) must never expose an unauthenticated or
  // weakly-authenticated healthz. Refuse to start rather than open a soft external surface.
  if (!loopback) {
    if (!token) {
      throw new Error(
        `inbox-coordinator: refusing to start — non-loopback bind (${host}) requires AIOS_HEALTHZ_TOKEN`
      );
    }
    if (token.length < MIN_HEALTHZ_TOKEN_LEN) {
      throw new Error(
        `inbox-coordinator: refusing to start — AIOS_HEALTHZ_TOKEN too weak (<${MIN_HEALTHZ_TOKEN_LEN} chars) for a non-loopback bind (${host})`
      );
    }
  }

  let last = { ok: true, counts: { total: 0, healthy: 0, degraded: 0 }, generated_at: null };

  const tick = () => {
    const now = clock();
    const iso = new Date(now).toISOString();
    const events = readSupervisorEvents(root);
    const health = loop.foldSupervisor(events, policy, now);
    loop.writeHostHealth(root, health.values(), iso); // persist admin-local state
    const summary = loop.coordinatorHealthSummary(health.values());
    last = { ok: summary.ok, counts: summary.counts, generated_at: iso };
    return last;
  };

  const server = createServer((req, res) => {
    // Only GET /healthz is served. No other route exists — no read-model data on this surface.
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method-not-allowed" }));
      return;
    }
    const url = (req.url ?? "").split("?")[0];
    if (url !== HEALTHZ_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (!bearerOk(req.headers["authorization"], token, loopback)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // Content-free liveness: ok flag + counts + generated_at only. No adapter details, no secrets.
    res.writeHead(last.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: last.ok, counts: last.counts, generated_at: last.generated_at }));
  });

  tick(); // compute an initial state before we start listening
  const timer = setInterval(tick, Math.max(50, intervalMs));
  if (typeof timer.unref === "function") timer.unref();

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      tick(); // final flush of admin-local state
    } catch {
      /* never block shutdown on a flush error */
    }
    await new Promise((resolve) => server.close(() => resolve()));
  };

  return { server, tick, summary: () => last, stop, listening, loopback };
}

async function main() {
  const loop = await loadOperatorLoop();
  const handle = startCoordinator(loop);

  // Register signal handlers BEFORE announcing "ready" — otherwise a SIGTERM arriving in the window
  // between the ready line and handler registration would hit the default disposition (abrupt kill,
  // no clean drain). A supervisor that reads "ready" from stderr can then SIGTERM immediately.
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`inbox-coordinator: ${sig} → draining + flushing state`);
    await handle.stop();
    console.error("inbox-coordinator: stopped cleanly");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const addr = await handle.listening;
  const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
  const auth = handle.loopback ? "loopback" : "token-required";
  console.error(
    `inbox-coordinator: supervising; healthz on http://${where}${HEALTHZ_PATH} (internal, ${auth})`
  );
}

// Run only when invoked directly (importable by tests without spawning).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`inbox-coordinator: fatal ${e?.message || e}`);
    process.exit(1);
  });
}
