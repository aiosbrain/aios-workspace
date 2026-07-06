---
status: draft
owner: john
access: team
created: 2026-07-06
type: spec
tags: [opencode, ON8, smoke-test]
parent: docs/specs/opencode-native/epic.md
---

# Spec — ON8: End-to-End Smoke Test

## Why

After ON1–ON7 are implemented, the workspace should be usable as a first-class OpenCode
project. A single end-to-end smoke test catches integration issues — does the whole
stack (AGENTS.md + opencode.json + commands + agents + instincts + brain sync) work
together in a real OpenCode session? This is the last mile.

## What

A documented smoke test run covering 7 verification steps, written to
`docs/specs/opencode-native/smoke-report.md`. Each step passes or fails with specific
evidence (screenshot description, command output, error message).

### Smoke test steps

1. **Session orientation.** Open a fresh OpenCode session in john-workspace. Verify the
   agent correctly identifies the workspace as "John's AIOS workspace for Pravos/Vibrana"
   after reading AGENTS.md. No manual prompting needed.

2. **Spine navigation.** Ask the agent to read the current OKRs. It should navigate to
   `0-context/okrs.md` without being told the path.

3. **Brain sync.** Run `aios status` from OpenCode bash. Verify output shows blocked and
   clean buckets matching the expected format.

4. **Command invocation.** Invoke an OpenCode command (e.g., process-meeting with a dummy
   path). Verify the command loads and runs its workflow.

5. **Instincts trigger.** Observe that the instincts plugin fires on session start
   (drift check output visible). Optionally: trigger the access gate by attempting to
   write a secret pattern to a team-tier file — should be blocked.

6. **Agent invocation.** Invoke a project subagent (e.g., decision-extractor with a
   sample transcript). Verify it reads the decision log rule and produces correctly
   formatted output.

7. **Plugin clean.** Verify no errors in OpenCode startup logs from the instincts plugin
   or any misconfiguration.

## Acceptance criteria

- `docs/specs/opencode-native/smoke-report.md` exists with all 7 sections
- Each section has a `PASS` or `FAIL` verdict with evidence
- All 7 steps pass (no FAIL verdicts)
- Steps 1-2 demonstrate AGENTS.md and opencode.json are working
- Steps 3 and 5 demonstrate brain sync and instincts plugin are working
- Steps 4 and 6 demonstrate commands and agents are working
- Step 7 confirms no configuration errors

## Integration points

- `AGENTS.md` — tested in step 1
- `opencode.json` — tested in steps 1, 4, 6 (agent loading, command loading)
- `.opencode/command/*.md` — tested in step 4
- `.opencode/agents/*.md` — tested in step 6
- `.opencode/plugins/aios-instincts.ts` — tested in steps 5, 7
- `scripts/aios.mjs` — tested in step 3
- `0-context/okrs.md` — tested in step 2

## Deps

- ON1–ON7 all complete
- OpenCode installed and functional
- `AIOS_API_KEY` set for brain sync (step 3)

## Scope

In scope: 7-step smoke test, documented report, all-pass requirement.
Deferred: Automated smoke test (CI), performance benchmarks, multi-session testing.

## Build-with

sonnet / low

## Tier-safety

Smoke report is team-tier. Brain sync step uses dry-run or push of team-tier content only.
No admin data is created or transmitted during testing. The instincts plugin's access gate
should block any accidental admin content push (verification step 5).

## Testability

The smoke report itself is the test artifact. Each step is independently verifiable by
reading the report. Steps that involve OpenCode session behavior are described with
sufficient detail that a second person could reproduce them.
