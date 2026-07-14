---
status: final
owner: john
access: admin
created: 2026-07-14
type: governance
---

# Unified inbox — incident-response runbook (I-16 / AIO-397)

Scope: a suspected or confirmed compromise of the inbox coordinator, an adapter credential, the D6
audit-anchor credential, or the local audit/journal stores. The flow is **detection → containment →
notification → recovery**. This runbook was exercised once as a tabletop; the notes are at the
bottom.

## 1. Detection

Signals that open an incident:

- `verifyChain` / `verifyAuditStore` returns `ok: false` (see `failures[]` for the exact seq +
  reason — a hash mismatch, a broken prev_hash link, a non-contiguous seq, or an anchor
  digest/head mismatch after restore).
- An anchor the D6 endpoint holds no longer matches the local chain prefix (prefix tampered, or an
  unauthorized rewrite of the local log).
- An adapter reports an action the audit log has no `capability.consumed` + `action.attempt` record
  for (a send with no authorization trail).
- A credential leak alert (token in logs, a revoked-then-reused key, an unexpected login).

## 2. Containment — Revocation order

Revoke credentials in this order (widest blast radius first; the anchor credential is revoked
*before* adapters so no attacker can forge a fresh checkpoint over a tampered log while adapters are
still being cut off). Every adapter below MUST be listed and revoked:

1. **D6 audit-anchor credential** — the Team Brain checkpoint endpoint token (or the signed-ref
   push credential, if the fallback shipped). Revoke first: it is the tamper-evidence root of trust.
2. **gmail** — OAuth refresh token (revoke in the Google account, not just locally).
3. **slack** — user/bot token.
4. **mattermost** — personal access token / session.
5. **whatsapp** — the `wacli` session / linked-device.
6. **telegram** — the notification bot token (the outbound content-free notify channel).
7. **runtime** — the owning runtime (claude-code) session that issues capability handles.

After revocation, stop the coordinator so no new capability handles are issued and no new audit
records are appended under a possibly-compromised actor.

## 3. Notification

- Notify the workspace owner (admin tier) with the incident summary: which credentials were revoked,
  the `verifyChain` failure detail, and the last known-good anchor (`through_seq` + `anchored_at`).
- If any content store held third-party personal data and exfiltration cannot be ruled out, follow
  the owner's disclosure obligations. The audit log's digest-only design means the incident record
  itself never widens exposure.
- No adjective claims in the notice — report the pass/fail facts and the affected `seq` ranges.

## 4. Recovery

1. Rotate every credential revoked in step 2 (new tokens, re-link devices).
2. Restore the audit log + journal from the last backup preceding the incident
   (`restoreAuditStore`).
3. Re-run `verifyAuditStore(root, sink)` against the **independently-held** anchors. A pass proves
   the restore is faithful to the last anchored prefix; a fail localizes the tampered `seq`.
4. Re-anchor from the last good `through_seq` forward once the chain verifies.
5. Record a `retention.deletion` or a follow-up audit note if any store was purged during recovery.

## Tabletop exercise notes (2026-07-14)

- **Scenario rehearsed:** a single-byte mutation to an interior journal-linked audit record, found
  by a scheduled `verifyAuditStore` run.
- **Walkthrough result:** detection fired on the `record hash mismatch` failure at the mutated seq;
  containment revoked the anchor credential first, then the seven adapters in order; recovery
  restored from backup and `verifyChain` returned pass against the retained anchors.
- **Gap found + closed:** the first draft revoked adapters before the anchor credential — reordered
  so the anchor credential is revoked first (an attacker with the anchor token could otherwise
  checkpoint over the tampered prefix). The Revocation-order list above reflects the fix.
- **Follow-up:** wire `verifyAuditStore` into the scheduled loop so detection is not manual (tracked
  separately; out of scope for this package).
