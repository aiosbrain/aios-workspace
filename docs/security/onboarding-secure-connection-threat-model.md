# Secure Connection Threat Model

Status: **design complete; implementation gate closed pending independent security review**
Scope: future setup bundles, TOFU origin trust, invitation exchange, and machine credentials.
Non-scope: the Reliability release implements only origin normalization, explicit confirmation,
origin-locked redirects, optional team headers, and `/me` validation.

## Decision

V2 should use **authenticated-dashboard setup bundles only**. Browser/device approval is deferred.
It duplicates the dashboard's authenticated human gate while adding phishing, polling, pending-token,
and cross-device state. Reconsider it only after observed onboarding failures show that copying a
dashboard bundle is the limiting step.

Setup bundles, browser approval, join links, and access requests remain separate protocols and
separate future contract entries. None may reuse another protocol's token, database row, endpoint,
rate-limit bucket, or audit action.

## Trust posture

1. A remote Brain requires HTTPS. Plain HTTP is permitted only for exact loopback hosts.
2. First use is explicit TOFU: the client displays the canonical origin and the human approves that
   exact string. An agent cannot answer the gate.
3. The approved origin and the Brain signing-key fingerprint are pinned locally. A later origin or
   signing-key change blocks connection until a human performs a recovery flow.
4. Redirects are processed manually. Credentials are never replayed across an origin change.
5. A connection never implies consent to share. Onboarding never pushes.

The first bundle signature cannot establish trust by itself. After origin approval, the client
fetches `/.well-known/aios-brain-keys`, displays the SHA-256 fingerprint, pins it, and only then uses
the signing key to verify the bundle. Later signatures provide post-TOFU integrity.

## Bundle envelope

Use a versioned JSON envelope signed with Ed25519 over RFC 8785/JCS canonical bytes:

```json
{
  "protocol": "aios.dashboard-setup/v1",
  "brain_origin": "https://brain.example.com",
  "team": { "id": "uuid", "slug": "acme", "name": "Acme" },
  "member": { "id": "uuid", "handle": "alex", "display_name": "Alex" },
  "request": { "machine_name": "Alex's Mac", "workspace_name": "alex-workspace" },
  "capabilities": ["items:read", "items:write", "query:read"],
  "token": { "id": "uuid", "secret": "single-use" },
  "issued_at": "RFC3339",
  "expires_at": "RFC3339",
  "nonce": "base64url-128-bit",
  "signing_key_id": "brain-ed25519-2026-01",
  "signature": "base64url"
}
```

The signature covers every field except `signature`. The token secret is never logged or stored in
onboarding state. Dashboard bundles expire after **10 minutes**. A future manual/no-email invitation
token is a different protocol and expires after **24 hours**.

## Approval screen

Before redemption, show one calm, non-editable approval screen with:

- exact canonical origin and pinned/new fingerprint;
- team name, slug, and UUID;
- member display name and handle;
- requesting machine and workspace names;
- requested capabilities, expanded into plain language;
- exact expiry time and remaining lifetime;
- actions: **Approve this connection** and **Cancel**.

Any mismatch between screen data, bundle data, redirect origin, or exchange response blocks. The
screen must not hide the origin in secondary text or allow an agent-accessible CLI flag to approve it.

## Credential lifecycle and partial failure

Redemption is two-phase. `redeem` atomically consumes the invitation token and creates a disabled,
pending machine credential with a five-minute activation deadline. Its secret is returned once. The
client stores it through the existing dotenvx vault, proves possession to `activate`, and only then
does the server enable it. If vault storage or activation fails, the client calls `revoke-pending`
with the redemption receipt and removes local remnants; server expiry revokes it if cleanup cannot
reach the Brain. No usable credential survives a failed local save.

Rotation issues a new pending credential, activates it after vault replacement succeeds, then
revokes the old credential. Member disablement immediately rejects and revokes all member machine
keys. Admins can list, label, rotate, and revoke machines without seeing secrets.

## Token state

Each pending token has its own row and state: `pending | consumed | revoked | expired`. Revocation is
by token ID and never revokes unrelated invitations. Re-inviting the same member revokes all older
pending tokens for that member/protocol before issuing one new token. Consumption is a single
transaction guarded by token ID, secret hash, expiry, member status, and `pending` state. Replay
returns the same generic invalid/expired response and emits a replay audit event.

## Threats and controls

| Threat | Required control | Negative test |
|---|---|---|
| Phished/malicious bundle origin | Canonical display, human TOFU, HTTPS, pinned origin + fingerprint | signature-valid bundle for unapproved origin is blocked |
| Later origin/key substitution | Local pins; recovery requires human re-approval | changed origin or fingerprint never auto-updates |
| Device-code approval phishing | Browser approval deferred; if revived, approval shows full requester context | wrong machine/team/capability blocks |
| Cross-origin redirect | manual redirect handling, origin comparison before credential replay | 30x to another origin receives no Authorization |
| SSRF/local-network target | only user-approved public HTTPS or exact loopback; reject credentials and arbitrary paths | private/link-local/metadata targets rejected by future exchange client |
| Replay/expired/revoked token | hashed one-time token, atomic consume, TTL, individual revocation | second/expired/revoked redemption fails and audits |
| Bundle leaks in chat/email/shell/agent logs | short TTL, single use, redaction, no CLI positional secret, no transcript echo | logs/output never contain token or machine key |
| Local vault failure | pending-disabled credential, activate after storage, auto-revoke | failed vault write leaves no active key |
| Member disabled/re-invited | revoke member keys; re-invite revokes older pending tokens only | disabled member and superseded token fail |
| Join-link enumeration/abuse | ≥128-bit random IDs, generic responses, IP+team+member limits | enumeration never distinguishes valid IDs |
| Admin-request flooding | separate queue/rate bucket, dedupe by member+machine, admin mute/block | flood is bounded and auditable |

## Audit and rate limits

Future events are versioned and non-secret: `setup_bundle.issued`, `setup_bundle.revoked`,
`setup_bundle.redeemed`, `setup_bundle.replay_rejected`, `machine_key.pending`,
`machine_key.activated`, `machine_key.revoked`, `origin.trust_approved`, and
`origin.change_blocked`. Metadata excludes token/credential bodies.

Initial limits: bundle issue 5/member/hour and 30/team/hour; redeem 10/IP/hour plus 10/token/hour;
access requests 3/member/day and 30/team/day. Limits require disposable-target tests before tuning.

## Exit gate

No protocol implementation is authorized until an independent security review reports zero
blockers and a new plan specifies contract versions, migrations, endpoint order, audit events,
rate limits, rollback, and disposable-target negative tests. Current review status: **not yet
approved; gate closed**.
