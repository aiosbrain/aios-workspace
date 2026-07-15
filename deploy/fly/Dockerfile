# Fly coordinator image (I-15 / AIO-396, the G6b gate).
#
# Node 22 on Debian slim — NOT alpine: the D5 ruling is `better-sqlite3` (a native addon), and its
# prebuilt binaries + WAL behaviour are proven on glibc, not musl. This image is the "Docker image
# proving the D5 SQLite choice (WAL on the Fly image was an explicit D5 requirement)" the issue names.
#
# The WAL proof is a BUILD-TIME gate: the image will not build unless better-sqlite3 opens a DB in
# WAL mode successfully (see the RUN check below), so a broken native build can never ship to Fly.

FROM node:22-bookworm-slim AS base
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for node22/glibc; build-essential + python3 are the fallback
# toolchain if a source rebuild is ever needed for the target arch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# ── deps (ALL deps; lifecycle scripts disabled) ──────────────────────────────────────────────────────
# Install EVERY dependency — including devDependencies (TypeScript lives there, and the build below
# needs it) — with `--ignore-scripts`. That is deliberate and load-bearing:
#   • the ROOT `postinstall` (`node scripts/postinstall-banner.mjs && … ensure-loop-built.mjs`) would
#     run mid-install, but `scripts/` is NOT copied yet — so it must NOT run here;
#   • disabling scripts also skips better-sqlite3's native install step, which we run EXPLICITLY next,
#     so nothing the runtime needs is silently skipped.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# better-sqlite3's own install/build was skipped by `--ignore-scripts` above; run it EXPLICITLY so the
# native addon exists (build-essential + python3 installed above provide the toolchain / node-gyp
# fallback if a prebuilt binary is unavailable). This keeps the D5 WAL proof meaningful.
RUN npm rebuild better-sqlite3

# D5 WAL PROOF — fail the build if better-sqlite3 cannot open a DB in WAL mode on this image.
RUN node -e "const D=require('better-sqlite3');const db=new D('/tmp/wal-proof.db');const m=db.pragma('journal_mode = WAL',{simple:true});if(m!=='wal'){console.error('D5 FAIL: journal_mode='+m);process.exit(1)}db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log('D5 OK: better-sqlite3 WAL proven on '+process.version)"

# ── app ────────────────────────────────────────────────────────────────────────────────────────────
# Copy sources + scripts BEFORE compiling (the buggy earlier build compiled with only package files
# present). Compile with the PINNED, LOCAL tsc (`node_modules/.bin/tsc`, installed above) — hermetic,
# never a `npx`-triggered network fetch.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
RUN node_modules/.bin/tsc -p tsconfig.json

# NOTE — devDependencies are DELIBERATELY NOT pruned. The compiled runtime barrel
# (`dist/operator-loop/index.js`) re-exports `llm.js`, which STATICALLY imports `@anthropic-ai/sdk`
# (a devDependency) at module-load time. Every entrypoint — including the coordinator daemon via
# `operator-loop-loader.mjs` — loads that barrel, so `npm prune --omit=dev` would leave the image
# unable to even start (`ERR_MODULE_NOT_FOUND @anthropic-ai/sdk`). Keeping the full install is the
# correct, runtime-preserving choice for this single-tenant coordinator image; a smaller runtime is
# a follow-up that belongs in product packaging (promote those SDKs, or make the import lazy), not a
# deploy hotfix.

# Persistent state lives on the mounted volume (see fly.toml [mounts]); create the mountpoint and make
# it writable by the unprivileged `node` user the daemon runs as (the daemon creates `.aios/loop/inbox`
# under here on first tick). NOTE for Fly: a freshly-created Fly volume mounts root-owned and shadows
# this dir, so the volume itself must be made node-writable once at provisioning
# (`fly ssh console -C "chown -R node:node /data"`) — see the provisioning runbook.
RUN mkdir -p /data/inbox && chown -R node:node /data
ENV AIOS_INBOX_DATA_DIR=/data/inbox

# Run as an unprivileged user; per-adapter uids are layered on top by the supervisor (isolation bar).
USER node

# healthz bind + port (loopback default is overridden on Fly to the internal address so the private
# [checks] probe can reach it; there is NO [[services]] block, so the port is never publicly exposed).
ENV AIOS_HOST_BIND=0.0.0.0
ENV AIOS_HEALTHZ_PORT=8081
EXPOSE 8081

# The REAL entrypoint: the long-running coordinator daemon. It runs the supervision loop, persists the
# admin-tier host-health state, serves the internal /healthz liveness endpoint (port 8081, matching
# fly.toml [checks]), and shuts down cleanly on SIGTERM. `aios inbox status` / the restore drill / the
# verify script remain runnable from this image for ops.
CMD ["node", "scripts/inbox-coordinator.mjs"]
