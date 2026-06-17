# Runtime-adapter transcript fixtures

Each `*.events.json` is a **real transcript** captured from a runtime backend for
one simple turn ("create notes.md / reply with a token"). `fixtures.test.mjs`
replays each through its adapter's pure mapper and asserts (1) every emitted
event satisfies the WS client contract (`assertWsEvent`) and (2) the full WS
event-type sequence matches a snapshot. This regression-protects the
backend → WS-event contract the React client depends on.

| fixture | backend | captured from |
|---|---|---|
| `opencode.events.json` | `opencode serve` SSE `/event` | live turn, OpenCode Zen `deepseek-v4-flash-free` |
| `codex.events.json` | `codex exec --json` JSONL | live turn, `gpt-5.4-mini` (API key) |
| `acp.events.json` | `hermes acp` `session/update` | live turn, Hermes on `llama3.1-8b-64k` |

## Re-recording

Capture the **raw backend events** (not the mapped WS events) for a fresh turn:

- **opencode** — `POST /session`, open `GET /event` (SSE), `POST
  /session/{id}/message`; collect every event whose `properties.part.sessionID`
  (or `properties.sessionID`) matches your session until `session.idle`. Save
  `{ sessionId, events }`.
- **codex** — `codex exec --json -C <tmp> --full-auto -m <model> "<prompt>"`;
  save each JSONL line as `{ events: [...] }`.
- **acp (hermes/openclaw)** — drive `hermes acp` (or `openclaw acp`) with a
  `ClientSideConnection`; record every `update` passed to the client's
  `sessionUpdate({update})`. Save `{ updates: [...] }`.

After re-recording, update the snapshot sequences in `fixtures.test.mjs` if the
turn's shape changed. Keep prompts trivial and secret-free (CI secret-scans
these files).
