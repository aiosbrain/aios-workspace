# I-14 · GUI comms section (AIO-395) — verification evidence

Captured in the real GUI (`gui/server` serving the built `gui/client`) against a **synthetic** admin-tier
fixture workspace (email threads + agent asks + one pending I-03 capability handle — no grey channels, no
real data). Rendered in a real Chromium window via `agent-browser`.

| Screenshot | Shows |
|---|---|
| `comms-desktop.png` | The `comms` view, dark mode. Health strip (`DECK LIVE`, counts, ranker version); the ranked queue with the **protected partition** (VIP email + open-blocker ask above the separator) and per-row **"why" strings** from I-04; the detail pane with a TerminalFrame ask card, the `PROTECTED` badge, the **pending approval** entry, and the deferred "Reply in Gmail" deep-link. |
| `scoped-confirm.png` | The `ScopedConfirmDialog` — the I-03 **display projection** (`Bash · cmd:git`) + the canonical **request digest** the human binds to, and the deliberate Deny / Approve… confirm grammar. |
| `comms-light.png` | The same surface in **light mode** (dual-mode obligation), dialog open. |
| `comms-responsive-900.png` | Narrow (900px) width — sidebar + queue + detail hold; the honest **STALE** banner + health chip appear once the fixture's newest observation ages past the 5-min SLO. |

## Functional evidence (the only mutating path)

Approving through the dialog posts exactly `{ handle, digest, decision }` to `POST /api/inbox/:id/decision`.
The coordinator broker + owning runtime then durably consumed the handle and wrote the content-free lifecycle
chain to the I-02 journal (`inbox-events.*.ndjson`):

```
capability.ndjson:   issue → consume(approve) → receipt(native-receipt)
inbox-events.ndjson: user-intent → pdp-decision → capability-consumption → native-receipt
```

All journal payloads are content-free (operation name + digest only — never message bodies or args).
