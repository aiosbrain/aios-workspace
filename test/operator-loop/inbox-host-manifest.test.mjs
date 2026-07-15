// Inbox host — Fly manifest + Docker image contract (I-15 / AIO-396, the G6b review follow-up).
//
// Static contract checks over deploy/fly/* so the runtime scaffolding stays HONEST and can't silently
// drift from the daemon: the image runs the real coordinator daemon (not a placeholder), the healthz
// port matches between the daemon default, the Dockerfile, and the fly.toml [checks], the D5 WAL proof
// is a build-time gate, the persistent volume is mounted, and there is NO public [[services]] block
// (no unauthenticated external surface).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const FLY = read("deploy/fly/fly.toml.template");
const DOCKERFILE = read("deploy/fly/Dockerfile");
const DAEMON = read("scripts/inbox-coordinator.mjs");

test("Dockerfile CMD runs the real coordinator daemon (not the old placeholder status command)", () => {
  assert.match(
    DOCKERFILE,
    /CMD \["node", "scripts\/inbox-coordinator\.mjs"\]/,
    "entrypoint is the daemon"
  );
  assert.ok(
    !/CMD \["node", "scripts\/aios\.mjs", "inbox", "status"\]/.test(DOCKERFILE),
    "placeholder CMD is gone"
  );
});

test("healthz port is consistent across the daemon default, the Dockerfile, and fly.toml [checks]", () => {
  // Daemon default port.
  assert.match(DAEMON, /AIOS_HEALTHZ_PORT \?\? 8081/, "daemon defaults to 8081");
  // Dockerfile env + EXPOSE.
  assert.match(DOCKERFILE, /ENV AIOS_HEALTHZ_PORT=8081/);
  assert.match(DOCKERFILE, /EXPOSE 8081/);
  // fly.toml health check + env.
  assert.match(FLY, /\[checks\.coordinator\]/);
  assert.match(FLY, /port = 8081/);
  assert.match(FLY, /AIOS_HEALTHZ_PORT = "8081"/);
});

test("the Fly health check is TCP (never an http check carrying the secret) + token is required", () => {
  // /healthz requires the bearer token; an http check cannot safely carry a secret in fly.toml, so
  // the platform check is a TCP connect and there is NO committed `path = "/healthz"` / http header.
  assert.match(FLY, /type = "tcp"/, "the Fly check is a TCP connect");
  assert.ok(!/type = "http"/.test(FLY), "no http check that would leak/omit the healthz token");
  assert.ok(!/path = "\/healthz"/.test(FLY), "no committed http path (the token would be needed)");
  assert.match(FLY, /AIOS_HEALTHZ_TOKEN is REQUIRED/i, "the token requirement is documented");
});

test("the Dockerfile enforces the D5 WAL proof at build time (better-sqlite3 opens WAL)", () => {
  assert.match(DOCKERFILE, /journal_mode = WAL/, "WAL proof present");
  assert.match(DOCKERFILE, /better-sqlite3/);
  assert.match(DOCKERFILE, /D5 FAIL/, "the proof fails the build on a non-WAL result");
  assert.match(DOCKERFILE, /node:22-bookworm-slim/, "glibc base for the native addon");
});

test("the persistent volume (D5 backup unit) is mounted at /data", () => {
  assert.match(FLY, /\[mounts\]/);
  assert.match(FLY, /destination = "\/data"/);
  assert.match(FLY, /AIOS_INBOX_DATA_DIR = "\/data\/inbox"/);
});

test("NO public [[services]] block — the coordinator opens no unauthenticated external surface", () => {
  // A real TOML table-array header sits at line start (comments begin with `#`), so this only trips
  // on an actual published-service section — not on the explanatory comment that mentions it.
  assert.ok(!/^\s*\[\[services\]\]/m.test(FLY), "there must be no published public service");
  // The healthz bind is the internal address; the read-model API is device-token gated (separate).
  assert.match(FLY, /AIOS_HOST_BIND = "0\.0\.0\.0"/);
  assert.match(FLY, /no unauthenticated external surface/i);
});

test("the daemon serves ONLY /healthz, refuses a non-loopback bind without a strong token, and bounds its event log", () => {
  assert.match(DAEMON, /const HEALTHZ_PATH = "\/healthz"/);
  assert.match(DAEMON, /AIOS_HEALTHZ_TOKEN/);
  // Non-GET and unknown routes are refused (405 / 404) — no other route is served.
  assert.match(DAEMON, /405/);
  assert.match(DAEMON, /404/);
  // Fail-closed startup on a non-loopback bind without a present + strong token.
  assert.match(DAEMON, /refusing to start/);
  assert.match(DAEMON, /MIN_HEALTHZ_TOKEN_LEN/);
  // Bounded + rotated supervisor-events log (no unbounded read/growth).
  assert.match(DAEMON, /SUPERVISOR_EVENTS_ROTATE_BYTES/);
  assert.match(DAEMON, /readTail/);
  // SIGTERM handling for clean shutdown.
  assert.match(DAEMON, /SIGTERM/);
});

test("fly.toml stays single-tenant + always-on (no autoscaling, immediate replace)", () => {
  assert.match(FLY, /app = "aios-inbox-\{\{USER_SLUG\}\}"/, "one app per user (templated)");
  assert.match(FLY, /strategy = "immediate"/);
  // The at-risk / merge-gate posture is documented in the template itself.
  assert.match(FLY, /MERGE-GATED/);
  assert.match(FLY, /I-11/);
});
