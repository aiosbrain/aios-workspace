#!/usr/bin/env node
/**
 * inbox-coordinator.mjs — the long-running Fly coordinator daemon (I-15 / AIO-396, the G6b gate).
 *
 * This is the REAL image entrypoint (replacing the earlier placeholder `aios inbox status` CMD). It:
 *   • runs the SUPERVISION LOOP: every tick it folds the observed adapter lifecycle events
 *     (`.aios/loop/inbox/supervisor-events.ndjson`, appended by the channel adapters) into per-adapter
 *     `AdapterHealth` and persists the admin-tier host-health state file — the exact state
 *     `aios inbox` / `aios inbox status` read;
 *   • exposes an INTERNAL `/healthz` liveness endpoint (default bind 127.0.0.1) returning 200 while
 *     every adapter is healthy and 503 when degraded — content-free (counts only, no bodies/creds);
 *   • does NOT open an unauthenticated external surface: it binds loopback by default, publishes no
 *     other route, and (when `AIOS_HEALTHZ_TOKEN` is set) requires a bearer token even on /healthz;
 *   • handles SIGTERM/SIGINT: stop the loop, flush a final state write, close the server, exit 0.
 *
 * The read-model API itself (device-token gated) is a separate surface; this daemon is the supervisor
 * + liveness process. Admin-tier local only; nothing syncs to the Team Brain. Deploy to Fly stays
 * MERGE-GATED on I-11 / PR #321 — this file makes the runtime honest and testable locally now.
 *
 * Env:
 *   AIOS_INBOX_DATA_DIR      workspace root holding `.aios/loop/inbox/` (default: cwd)
 *   AIOS_HOST_BIND           healthz bind address (default: 127.0.0.1; Fly sets an internal address)
 *   AIOS_HEALTHZ_PORT        healthz port (default: 8081 — matches deploy/fly/fly.toml.template)
 *   AIOS_HEALTHZ_TOKEN       if set, /healthz requires `Authorization: Bearer <token>`
 *   AIOS_COORDINATOR_INTERVAL_MS  supervision tick interval (default: 5000)
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

const SUPERVISOR_EVENTS_BASENAME = "supervisor-events.ndjson";
const HEALTHZ_PATH = "/healthz";

/** Parse the observed-events NDJSON into SupervisorEvent objects (tolerant: skip malformed lines). */
export function readSupervisorEvents(root) {
  const file = path.join(root, ".aios", "loop", "inbox", SUPERVISOR_EVENTS_BASENAME);
  if (!existsSync(file)) return [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
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
      /* a torn/garbage line never wedges the supervisor */
    }
  }
  return out;
}

function bearerOk(headerValue, token) {
  if (!token) return true; // no token configured → healthz is open (loopback-only liveness)
  const m = /^Bearer\s+(.+)$/.exec(headerValue ?? "");
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Start the coordinator. Returns a handle with `tick()` (run one supervision cycle now), `summary()`
 * (last computed coordinator health), and `stop()` (flush + close, resolves when the server is down).
 * `clock` is injectable for deterministic tests; defaults to Date.now.
 */
export function startCoordinator(loop, opts = {}) {
  const root = opts.root ?? process.env.AIOS_INBOX_DATA_DIR ?? process.cwd();
  const host = opts.host ?? process.env.AIOS_HOST_BIND ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.AIOS_HEALTHZ_PORT ?? 8081);
  const intervalMs = opts.intervalMs ?? Number(process.env.AIOS_COORDINATOR_INTERVAL_MS ?? 5000);
  const token = opts.token ?? process.env.AIOS_HEALTHZ_TOKEN ?? "";
  const policy = opts.policy ?? loop.DEFAULT_SUPERVISOR_POLICY;
  const clock = opts.clock ?? (() => Date.now());

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
    if (!bearerOk(req.headers["authorization"], token)) {
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

  return { server, tick, summary: () => last, stop, listening };
}

async function main() {
  const loop = await loadOperatorLoop();
  const handle = startCoordinator(loop);
  const addr = await handle.listening;
  const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
  console.error(
    `inbox-coordinator: supervising; healthz on http://${where}${HEALTHZ_PATH} (internal)`
  );

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
}

// Run only when invoked directly (importable by tests without spawning).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`inbox-coordinator: fatal ${e?.stack || e?.message || e}`);
    process.exit(1);
  });
}
