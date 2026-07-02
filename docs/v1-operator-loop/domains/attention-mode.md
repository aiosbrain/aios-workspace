# Domain spec — Attention mode (deep-work / orchestration)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
Agentic Ergonomics slice (epic AIO-166); sibling of the [asks queue](./asks-queue.md).

## Why

Orchestrating many agent sessions makes the local end-of-turn ping valuable (it's the wake-up
signal for the next supervision decision). Deep work makes the same ping a context-switch tax.
The owner needs a one-command toggle between the two attention modes — without losing their
notification configuration and without touching mobile push.

## Contract

- **The toggled key is exactly `preferredNotifChannel`** in the Claude Code user settings file
  (`~/.claude/settings.json`). Deep-work sets it to `notifications_disabled`; orchestration
  restores the pre-deep-work value **including absence** (unset = Claude Code default channel).
- **`agentPushNotifEnabled` is NEVER touched** — mobile push is not the local ping.
- The pre-deep-work value is remembered in a sidecar (`~/.claude/aios-mode.json`,
  `{version:1, mode, saved:{present, value?}, changedAt}`), consumed on restore. With no sidecar
  memory, restore deletes the key (falls back to the default channel) rather than guessing.
- Mode is **derived from the settings file**, not the sidecar, so hand-edits are never masked.
- Settings writes are atomic (temp + rename) and only ever re-serialize parsed JSON; a malformed
  settings file aborts the command instead of being clobbered.
- Tier: the sidecar is owner-local machine state (admin posture); nothing here syncs or emits
  loop signals in this slice.

## CLI

```
aios mode                     # status (default): mode + effective local ping
aios mode deep-work           # silence the local ping (idempotent)
aios mode orchestration       # restore the prior channel (idempotent)
  [--settings <path>]         # override settings file (tests / non-standard installs)
  [--json]
```

Offline command (no `aios.yaml` required).

## Acceptance (AIO-168)

Toggling verifiably silences the local iTerm2 ping (live test on the real settings file) and
restores it — restored value byte-equal to the prior configuration, or absent if it was absent.

## Implementation (AIO-168)

Clean TS under `src/operator-loop/`:

- `mode.ts` — `modeStatus` / `enterDeepWork` / `enterOrchestration` over injectable
  `ModePaths`; sidecar read/write; atomic settings write.
- `scripts/aios.mjs` — `cmdMode` (offline), usage text.
- Tests: `test/operator-loop/mode.test.mjs` (temp settings files; save/restore of present and
  absent prior values; idempotency; malformed settings abort; push key untouched).
