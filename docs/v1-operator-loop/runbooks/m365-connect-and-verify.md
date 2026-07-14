---
status: draft
owner: john
access: team
issue: AIO-393
type: runbook
---

# Runbook — m365 connect-and-verify (I-12 / AIO-393)

Wire the m365 channel at the honest claim level: **auth → read → one policy-mediated send** on a
**test tenant**, then publish the support claim exactly as proven — **"connected and verified"** — and
nothing more. The deep adapter (enriched observations, reply-PDP integration, outbox) is **post-Jul-29**.

> **Current status: NOT run against a live tenant.** This build is **credential-free**: there is no
> Microsoft tenant, no app registration, and no token on this machine. Everything below the
> [Live verification](#live-verification--needs-tenant-the-single-residual) heading is the **single
> outstanding residual** — it needs a tenant Abe provisions and a human to run it once. Until then the
> command honestly reports `needs-tenant` and never claims verified.

## What is built (credential-free, ~90%)

- **Module** — `src/operator-loop/inbox/m365-verify.ts`. The Microsoft Graph boundary is a single
  **injected `GraphTransport` seam** (`acquireToken` / `listMessages` / `sendMail`); the module makes
  no network call, imports no Graph SDK, and holds no secret. `verifyM365` runs the three checks and
  returns a deterministic `VerifyReport`.
- **Diagnostic states** — a fixed, exported catalogue (`M365_DIAGNOSTICS`): `auth.ok`,
  `auth.token-unavailable`, `auth.token-expired`, `auth.insufficient-scope`, `read.ok`,
  `read.insufficient-scope`, `read.throttled`, `read.error`, `send.ok`, `send.insufficient-scope`,
  `send.throttled`, `send.error`, `skipped.prior-check-failed`, `needs-tenant`. Every check names one.
- **Least-privilege scopes** — `M365_REQUIRED_SCOPES = ["Mail.Read", "Mail.Send"]`. The report's
  `graph_permissions` enumerates the scopes **as observed on the acquired token**, not assumed.
- **Pagination / delta / throttling / errors** — `paginateMessages` follows `next_link`, captures the
  terminal `delta_link` as the resume cursor, retries a `429` honoring `Retry-After` (via an injected
  backoff, no real clock), and classifies `403 / 429 / 401 / other` deterministically.
- **Normalization / identity / cursor** — `normalizeMessage` keys each message on
  `(account, tenant, native_id)` (the AIO-387 enriched-observation dedup key; two accounts observing
  the same native id → two items), metadata-only (**no body ever read**), admin-tier by default.
- **Command** — `aios inbox m365-verify` (below), with a bundled fixture self-test.
- **Tests** — `test/operator-loop/inbox-m365-verify.test.mjs`: report-shape + every failure path from
  **recorded fixtures**, no live tenant needed in CI.

## Claim honesty (why a fixture run never says "verified")

The `VerifyReport.claim` is `"connected and verified"` **only** when a run is `mode: "live"` **and**
all three checks pass. A `mode: "fixture"` run — the only kind this build can do — is always labelled
`mode: "fixture"` and its claim stays `"not verified"`, however green the checks are. The one durable
I-02 journal event a run emits is **content-free** (statuses, scopes, the opaque native message-id,
counts — never a token, address, subject, or body) and admin-tier local; it is written only for a real
`live` run and never syncs to the Team Brain.

## Running the command locally (no tenant)

```bash
# No tenant configured → honest needs-tenant report, exits non-zero, makes NO Graph call:
aios inbox m365-verify
aios inbox m365-verify --json

# Demonstrate the three diagnostic states deterministically from bundled fixtures
# (always mode: fixture — never claims verified):
aios inbox m365-verify --fixture happy         # auth+read+send pass; claim stays "not verified"
aios inbox m365-verify --fixture bad-token      # auth fails (token unavailable)
aios inbox m365-verify --fixture missing-scope  # auth fails (Mail.Send not granted)
aios inbox m365-verify --fixture throttled      # 429 retried within budget → passes
```

Exit code keys off `status`: `0` when `status === "verified"`, non-zero for `needs-tenant` and any
failing check (the failing check is named in the output). A `--fixture happy` run reaches
`status: "verified"` and so exits `0` — but its published `claim` still stays `"not verified"`
(`mode: "fixture"`), so a green fixture exit never asserts a live connection. Only a real
`mode: "live"` all-green run publishes `"connected and verified"`.

## Tier safety

Test-tenant data only. Captured message metadata is **admin-tier local** and never syncs to the Team
Brain. The one send targets a **test-tenant recipient** through the policy-mediated path — no
production recipient is ever addressable from this issue. `src/operator-loop/comms/sender.ts` is
untouched. Sync enforcement is two-layer: the aios sync client default-denies admin/untagged content,
and the brain rejects any private-tier push with a 422 — nothing here ever reaches that path.

---

## Live verification — NEEDS TENANT (the single residual)

**This is the one outstanding, human-only step.** It requires a test tenant + credentials that do not
exist on this machine; do not fabricate them. A second operator reproduces the whole setup from here.

### 1. Provision (Abe / tenant owner)

- A Microsoft 365 **test tenant** (e.g. `contoso.onmicrosoft.test`) with a **test recipient mailbox**.
- An **Azure AD app registration** with the **delegated** Graph permissions `Mail.Read` and
  `Mail.Send` (least privilege — grant nothing else), admin-consented.
- Install the **CLI for Microsoft 365** locally: `npm i -g @pnp/cli-microsoft365` (recorded here, not
  vendored). `m365 login` via device-code, then `m365 status` to confirm auth.

### 2. Configure

Write `.aios/m365-config.json` in the workspace (admin-tier, gitignored; never commit secrets):

```json
{
  "tenant_id": "<tenant-guid-or-domain>",
  "client_id": "<app-registration-client-id>",
  "test_recipient": "<test-mailbox@your-tenant.onmicrosoft.test>",
  "account": "<mailbox-the-flows-run-as>"
}
```

### 3. Wire the live transport (one-time engineering step)

Implement a `GraphTransport` backed by the `m365` CLI / Graph SDK (`acquireToken` via device-code or
app registration; `listMessages` via `m365 outlook message list` or Graph `/me/messages`; `sendMail`
via `m365 outlook mail send` or Graph `/me/sendMail`) and pass it to `verifyM365({ mode: "live", … })`.
Keep the token/secret in the transport's own credential source — never on disk in the config.

### 4. Verify + capture evidence

```bash
aios inbox m365-verify --json     # expect exit 0, all three checks "pass", claim "connected and verified"
```

- Confirm the report lists the exact `graph_permissions` the flows used (`Mail.Read`, `Mail.Send`).
- Confirm the send check captured a **native message-id** and the message **arrived** in the
  test-tenant recipient mailbox — **screenshot it and attach to the PR** (acceptance criterion).
- Revoke a credential / scope and re-run: expect a non-zero exit with the failing check named.

### 5. Publish the claim

Only after a green live run: the support claim `"connected and verified"` in
`docs/v1-operator-loop/domains/communication.md` is now backed by evidence. The deep adapter remains
**post-Jul-29**.
