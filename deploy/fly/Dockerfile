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

# The coordinator entrypoint is provisioned by the runbook (it wires the supervisor + read-model API);
# this image ships the built loop + CLIs. `aios inbox status` / the restore drill / the verify script
# all run from here.
CMD ["node", "scripts/aios.mjs", "inbox", "status"]
