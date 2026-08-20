# Verifying the write-time secret guard

`hooks/team-ops-guard.sh` is the PreToolUse hook that scans every Write/Edit/MultiEdit
for secrets and admin-tier content before the file lands. Verifying it **by hand** is
easy to get wrong in ways that look exactly like a right answer — during the 0.11.1
release spot-check it was gotten wrong three times in a row (AIO-953). Don't hand-roll
a payload. Run the self-test:

```bash
npm run guard:selftest
```

One command, deterministic, no network. It builds correct payloads against a synthetic
spine workspace, runs the guard under `bash`, and prints per case: the payload, the
exit code, and the matched pattern. Exit `0` means the guard is enforcing on this
machine; exit `1` means it is not — most importantly when a known-secret payload was
**not** blocked (the AIO-945 fail-open defect). The container CI lane does the release
verification; this is the same check made available to a human in one command.

## The payload shape

The guard reads a Claude Code PreToolUse event as JSON on **stdin**:

```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/abs/path/to/file.md",
    "content": "the content being written"
  }
}
```

- **`tool_input` is the load-bearing wrapper.** Everything the guard inspects
  (`file_path`, `content`, `new_string`, `edits[].new_string`) lives inside it.
- **The guard never reads `tool_name`.** Omitting it changes nothing.
- Alternatively, the GUI's host-side path sets `CC_TOOL_INPUT` to the `tool_input`
  object (no stdin). Stdin wins when both are present.
- Verdict: exit `0` = allow; exit `2` + stderr = block (Claude Code's deny signal).

## The guard is bash-only

The script is `#!/usr/bin/env bash` and uses `set -o pipefail`, `BASH_SOURCE`, and
arrays. **Never invoke it with `sh`** — invoke it as `bash hooks/team-ops-guard.sh`
or via its shebang, which is how production runs it.

## Troubleshooting a hand-check: the three traps

Each of these produced a confident wrong answer during a real release verification.
The self-test demonstrates all three with the actual mechanism named per case.

### 1. `sh guard.sh` exits 2 — that is NOT a block (false pass)

On systems where `sh` is dash (Debian, Ubuntu, most slim containers), the guard dies
immediately on `set -o pipefail` with a syntax error and a non-zero exit that looks
identical to a block. A **broken** guard exits the same way, so "it exited 2 under
sh" verifies nothing. Re-run with `bash`.

### 2. Exit 0 on a secret with a flat payload — that is NOT the fail-open bug (false fail)

If the payload omits the `tool_input` wrapper (or stdin is empty), the guard parses
it fine, finds no `tool_input`, and correctly answers "not a write event — allow".
The secret at the top level was never in a field the guard reads. Note the mechanism:
it is the **missing wrapper**, not a missing `tool_name` — the guard never reads
`tool_name` at all. Fix the payload shape (above) and re-run.

### 3. Exit 0 on a secret to `/tmp/x.env` — that is the extension filter, not scoping

The guard only checks files with these extensions: `.md .yaml .yml .json .sh .py
.ts .js`. A secret written to `x.env` is allowed because **`.env` is not in that
list** — not because `/tmp` is outside a workspace. Counter-proof (the self-test runs
it): the same secret to `/tmp/x.md` still blocks. If your probe exited 0, check the
extension before concluding anything about the guard.

## Related

- `docs/GETTING-STARTED.md` §3 — the `jq`/`node` parser prerequisite and the
  fail-closed `AIOS_GUARD_NO_JSON_PARSER` behavior when neither is on PATH.
- `validation/check-scaffold-guard.mjs` (OGR08) — asserts a scaffolded workspace
  ships a working guard.
- `test/guard-selftest.test.mjs` — pins that the self-test goes red over a guard
  that fails to block the known-secret case.
- AIO-945 (the fail-open defect), AIO-953 (hand-verification traps), AIO-1000
  (UH2-1 mechanism verification).
