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

test("the Dockerfile build is hermetic + correctly ordered (regression guard for the Fly build failure)", () => {
  // Index of the FIRST line matching `re`, or -1. Used to assert step ORDER, not just presence.
  const lines = DOCKERFILE.split("\n");
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const iCopyPkg = idx(/^COPY package\.json package-lock\.json/);
  const iNpmCi = idx(/^RUN npm ci\b/);
  const iRebuild = idx(/^RUN npm rebuild better-sqlite3\b/);
  const iWalProof = idx(/journal_mode = WAL/);
  const iCopySrc = idx(/^COPY src /);
  const iCopyScripts = idx(/^COPY scripts /);
  const iTsc = idx(/tsc -p tsconfig\.json/);

  // All the key steps exist.
  for (const [name, i] of Object.entries({
    iCopyPkg,
    iNpmCi,
    iRebuild,
    iWalProof,
    iCopySrc,
    iCopyScripts,
    iTsc,
  })) {
    assert.ok(i >= 0, `Dockerfile is missing a required step: ${name}`);
  }

  // BUG 1 — the install must NOT run the root `postinstall` (which needs scripts/, not copied yet):
  // the install line uses `--ignore-scripts`, and there is NO bare `npm ci --omit=dev` (the broken
  // form that both ran postinstall too early AND dropped TypeScript).
  assert.match(lines[iNpmCi], /--ignore-scripts/, "npm ci must disable lifecycle scripts");
  assert.ok(
    !/^RUN npm ci --omit=dev\s*$/m.test(DOCKERFILE),
    "the broken `npm ci --omit=dev` (drops devDeps + runs postinstall too early) must not return"
  );

  // BUG 2 — TypeScript is a devDependency, so the compile must use the PINNED LOCAL tsc (installed by
  // the full `npm ci`), never a network-fetching `npx tsc`, and must happen AFTER src/scripts copy.
  assert.match(lines[iTsc], /node_modules\/\.bin\/tsc/, "compile with the pinned local tsc");
  assert.ok(
    !/^RUN npx tsc\b/m.test(DOCKERFILE),
    "must not compile via a network-fetching `npx tsc`"
  );

  // BUG 3 (would-be regression) — the runtime barrel (`dist/operator-loop/index.js`) transitively
  // imports `@anthropic-ai/sdk` (a devDependency) via `llm.js` at LOAD time, so the image must NOT
  // dev-prune: `npm prune --omit=dev` / `npm ci --omit=dev` here would make the daemon crash on
  // startup with ERR_MODULE_NOT_FOUND. Guard against either form being (re)introduced.
  assert.ok(
    !/^RUN npm prune\b[^\n]*--omit=dev/m.test(DOCKERFILE),
    "must NOT dev-prune — the runtime barrel imports a devDependency (@anthropic-ai/sdk) at load"
  );

  // ORDERING — the whole reason the Fly build failed:
  assert.ok(iCopyPkg < iNpmCi, "package files are copied before npm ci");
  assert.ok(iNpmCi < iRebuild, "better-sqlite3 is rebuilt after install (its script was ignored)");
  assert.ok(iRebuild < iWalProof, "the WAL proof runs after the native addon is (re)built");
  assert.ok(iCopySrc < iTsc && iCopyScripts < iTsc, "src + scripts are copied BEFORE compiling");
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
