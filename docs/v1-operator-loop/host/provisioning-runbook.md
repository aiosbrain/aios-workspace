---
status: final
owner: john
access: team
created: 2026-07-14
type: runbook
issue: AIO-396
---

# Fly coordinator — provisioning runbook (I-15 · G6b)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Unified Human+Agent Inbox** epic (AIO-381), issue **AIO-396 / I-15**. This runbook moves the
coordinator from John's always-on Mac to a **per-user Fly machine** — the step that makes the inbox a
product instead of a workstation.

> **AT-RISK / FALLBACK (verbatim from the issue):** flagged at-risk for Jul 29; the accepted D1
> fallback is the **full demo (including GUI) on John's always-on Mac**. If the Fly gate is not green
> by the demo-freeze date John names at standup, the fallback demo path is exercised and this issue
> continues post-Jul-29 without blocking the epic.

> **⛔ MERGE GATE (do not skip):** the authorized live Fly deployment is **gated until I-11 / PR #321
> is merged**. The coordinator hosts the full I-02…I-11 vertical; there is nothing to deploy before
> that. Everything in this repo's I-15 change is built and tested **locally against the faked
> supervisor + local container image**; the deploy + live smoke steps below are written out exactly
> and left for the moment I-11 merges. **Do not run `fly deploy` / `fly ...` mutations, or
> `inbox-host-verify.mjs --live`, before then.**

---

## What ships in this issue (all local, no Fly mutation)

| Artifact | Path |
|---|---|
| Adapter supervision (restart / backoff / crash-loop) | `src/operator-loop/inbox/host-supervisor.ts` |
| AdapterHealth → Signal + AttentionItem projection, `aios inbox status` state | `src/operator-loop/inbox/host-health.ts` |
| Per-adapter credential broker + fs/egress sandbox | `src/operator-loop/inbox/credential-broker.ts` |
| Device identity / enrollment / revocation / **single-use tokens (nonce replay protection)** | `src/operator-loop/inbox/device-identity.ts` |
| **Coordinator daemon** (supervision loop + internal healthz + SIGTERM) | `scripts/inbox-coordinator.mjs` |
| Fly app template (one app per user) | `deploy/fly/fly.toml.template` |
| Coordinator image (D5 WAL proof at build time; CMD = the daemon) | `deploy/fly/Dockerfile` |
| Backup/restore **drill** (runnable, exits 0 = restore trustworthy) | `scripts/inbox-host-restore-drill.mjs` |
| Deploy **verification** (isolation · enrollment · replay · revocation) | `scripts/inbox-host-verify.mjs` |
| `aios inbox status` (coordinator + adapter health) | `scripts/inbox.mjs` |
| Dual-run contract test (local fixture vs recorded remote) | `test/operator-loop/inbox-remote-contract.test.mjs` |
| Kill-adapter → AttentionItem + **corrupt-file validation** | `test/operator-loop/inbox-host-health.test.mjs` |
| Isolation / enrollment / revocation logic | `test/operator-loop/inbox-host-isolation.test.mjs` |
| **Nonce replay / restart / concurrency / DoS-bound** | `test/operator-loop/inbox-host-nonce.test.mjs` |
| **Daemon lifecycle + healthz + token auth + SIGTERM** | `test/operator-loop/inbox-host-daemon.test.mjs` |
| **Fly manifest + Docker image contract** | `test/operator-loop/inbox-host-manifest.test.mjs` |

`src/operator-loop/comms/sender.ts` is **untouched**. Nothing here syncs to the Team Brain: the
journal, read model, host-health state, and device registry are **admin-tier local** and default-
denied at the sync boundary (the aios client default-denies admin/untagged; the brain 422s any
private push — neither path is reached by this issue).

---

## The isolation posture (pilot-host bar)

Stronger than the Hermes Fly deployment (cited as prose precedent only — shared uid, raceable creds
per its own docs; **no code reused**):

- **Per-adapter uid/container isolation.** Each channel adapter runs as its own uid with its own data
  dir; the `AdapterSandbox` (`credential-broker.ts`) is the fs/egress fence.
- **Credential broker with per-adapter scopes.** An adapter reads **only** its own credential key; a
  cross-adapter read throws `CredentialScopeError`. `crossScopeLeaks()` lints that **no** credential
  is granted to two adapters. The read-model store + journal keys are reserved and never brokered.
- **Supervised adapters.** Restart policy + exponential backoff + crash-loop detection
  (`host-supervisor.ts`), health surfaced as first-class `AttentionItem`s (`origin: agent-event`).
- **Remote access, device-gated.** No bare port exposure (`fly.toml` publishes no public service).
  The GUI/CLI reach the read-model API only with a **scoped token** minted for an **enrolled** device;
  a **revoked** device is rejected even with a still-valid signature. Tokens are **single-use**: the
  per-token nonce is consumed atomically on first verify (durable `fileNonceStore`), so a captured
  token cannot be **replayed** — including across a coordinator restart. The nonce store is pruned +
  hard-bounded (DoS). Crypto/enrollment/revocation checks run **before** consumption, so a bad token
  never burns a nonce slot, and if the durable store can't be locked the verify **fails closed**
  (`nonce-unavailable`, deny) rather than accept an unverifiable token.
- **Untrusted state, validated.** The host-health file is read through `sanitizeAdapterHealth` — every
  field is type-coerced, `detail` is stripped content-free + length-capped, unknown states / bad ids
  are dropped fail-closed, and `healthy` is re-derived from `state` (a record can't lie). A corrupt or
  hostile file can never crash a read or inject content into the inbox render path.
- **Real daemon, INTERNAL AUTHENTICATED healthz.** The image entrypoint is `scripts/inbox-coordinator.mjs`:
  it runs the supervision loop, persists admin-local state each tick, and serves a **content-free**
  `/healthz` on port 8081, **no other route**, clean SIGTERM. On a **non-loopback bind (Fly = 0.0.0.0)
  it refuses to start** unless `AIOS_HEALTHZ_TOKEN` is present and strong (≥24 chars), and every
  `/healthz` request then **requires** that bearer token — so there is never an unauthenticated
  external surface. Fly's platform check is **TCP** (an http check can't safely carry the secret);
  operators query the authenticated `/healthz` directly.
- **Bounded event log.** The daemon reads only the **tail** of `supervisor-events.ndjson` and
  **rotates** it to a single `.1` generation past a size cap, so the observed-events log can neither
  grow nor be read unbounded.

---

## Local build + verify (run these now, before any Fly step)

```bash
npm run build:loop                                             # compile the coordinator + inbox modules
node scripts/inbox-host-verify.mjs                             # isolation · enrollment · replay · revocation (self-test) → 0
node scripts/inbox-host-restore-drill.mjs                      # backup/restore drill → exit 0, drill notes emitted
node --test test/operator-loop/inbox-remote-contract.test.mjs  # dual-run contract → exit 0
node --test test/operator-loop/inbox-host-health.test.mjs      # kill adapter → AttentionItem + corrupt-file validation
node --test test/operator-loop/inbox-host-isolation.test.mjs   # isolation/enrollment/revocation → exit 0
node --test test/operator-loop/inbox-host-nonce.test.mjs       # token replay / restart / concurrency / DoS → exit 0
node --test test/operator-loop/inbox-host-daemon.test.mjs      # daemon lifecycle + healthz + SIGTERM → exit 0
node --test test/operator-loop/inbox-host-manifest.test.mjs    # Fly manifest + Docker image contract → exit 0

# Optionally run the daemon locally (loopback healthz; Ctrl-C / SIGTERM to stop cleanly):
AIOS_INBOX_DATA_DIR=$(mktemp -d) AIOS_HEALTHZ_PORT=8081 node scripts/inbox-coordinator.mjs
```

The dual-run contract test's **recorded remote response** is currently generated from a **local run of
the same image** (Fly access unavailable). Per the acceptance criteria this makes the spec
**done-except-deploy** — the `--live` half below is a follow-up, **never silently dropped**.

---

## Provision (merge-gated — run only after I-11 merges)

1. **Confirm the gate.** I-11 / AIO-392 merged to `main`. If not, STOP — exercise the D1 fallback.
2. **Stamp the template** for the user (`scripts/inbox-host-restore-drill.mjs` proves the backup unit
   first). Fill `{{USER_SLUG}}`, `{{FLY_REGION}}`, `{{VOLUME_NAME}}` into a working `fly.toml`.
3. **Create the app + volume** (John owns Fly ops, D9):
   ```bash
   fly apps create aios-inbox-<user>
   fly volumes create <volume> --region <region> --size 1     # holds journal + read model + registry
   # AIOS_HEALTHZ_TOKEN is REQUIRED on Fly (bind is 0.0.0.0): the daemon refuses to start on a
   # non-loopback bind without a STRONG token (≥32 chars). Generate one and set it as a secret.
   fly secrets set AIOS_HOST_SECRET="$(openssl rand -base64 32)"   \    # device-token signing key
                   AIOS_HEALTHZ_TOKEN="$(openssl rand -base64 32)" \    # REQUIRED healthz bearer token
                   GMAIL_OAUTH_TOKEN=... TELEGRAM_BOT_TOKEN=...          # per-adapter, scoped by the broker
   ```
4. **Build + deploy the image** (the Dockerfile fails the build unless better-sqlite3 opens WAL — the
   D5 proof):
   ```bash
   fly deploy --config fly.toml --dockerfile deploy/fly/Dockerfile
   ```

## Deploy + smoke (merge-gated) — the exact residual

Run each and paste the output into the PR (this is the only manual step the acceptance leaves open):

```bash
# 1. Live isolation + enrollment + revocation on the running machine.
AIOS_HOST_URL=https://aios-inbox-<user>.internal AIOS_HOST_SECRET=<secret> \
  node scripts/inbox-host-verify.mjs --live          # exit 0 iff isolation, enrollment, revocation pass

# 2. Live dual-run: remote read model must deep-equal the local fixture output.
node --test test/operator-loop/inbox-remote-contract.test.mjs -- --live   # deep-equal, exit 0

# 3. Live kill: kill an adapter process on the machine, then confirm the AttentionItem appears.
fly ssh console -C "pkill -f adapter:telegram"
aios inbox --json | jq '.items[] | select(.origin=="agent-event" and .health.adapter=="telegram")'
aios inbox status                                     # coordinator: degraded until the adapter recovers
```

**Residual after this issue merges (deploy-gated on I-11):** items 1–3 above, run once on the live Fly
machine, output pasted into the PR. Until I-11 is merged and the app is provisioned, they stay a
follow-up checklist — the local self-test / drill / contract halves are done and green.

---

## Backup / restore drill (D5 backup mode)

The consistent backup unit is the **append-only journal** (`inbox-events.ndjson` segments + the
compaction snapshot); the SQLite read model is a **deterministic projection** of it. The drill
(`scripts/inbox-host-restore-drill.mjs`) proves, on every run:

1. **Byte-equivalent projection** — a fresh-machine restore rebuilds to the **same** canonical
   `readModelDigest` as the pre-backup rebuild.
2. **Audit chain verified** — the recorded `audit-checkpoint-link` digest still matches the restored
   data (a tampered backup diverges) — the I-16 post-restore audit-chain hook.

On the live machine, the backup is `fly ssh sftp get /data/inbox` (or a volume snapshot); restore is
re-attaching the volume / re-projecting on a fresh machine and re-running the drill against it.

---

## Deferred (out of scope here)

Multi-tenant control plane; client self-provisioning; autoscaling; the retention/IR package contents
(I-16 — required before any pilot account; **not** blocked by this issue's at-risk status).
