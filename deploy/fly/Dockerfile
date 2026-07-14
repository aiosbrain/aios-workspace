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

# ── deps (prod only) ─────────────────────────────────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# D5 WAL PROOF — fail the build if better-sqlite3 cannot open a DB in WAL mode on this image.
RUN node -e "const D=require('better-sqlite3');const db=new D('/tmp/wal-proof.db');const m=db.pragma('journal_mode = WAL',{simple:true});if(m!=='wal'){console.error('D5 FAIL: journal_mode='+m);process.exit(1)}db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log('D5 OK: better-sqlite3 WAL proven on '+process.version)"

# ── app ────────────────────────────────────────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
# Compile the operator loop (the coordinator + inbox modules) to dist/.
RUN npx tsc -p tsconfig.json

# Persistent state lives on the mounted volume (see fly.toml [mounts]); create the mountpoint.
RUN mkdir -p /data/inbox
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
