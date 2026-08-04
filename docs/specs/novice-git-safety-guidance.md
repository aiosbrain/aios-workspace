---
eval_tier: full
spec_gate: block
safety: true
type: issue-spec
---

# Git safety guidance for novice AIOS workspaces

## What / why

Scaffolded AIOS workspaces already create a Git repository and an initial commit, but a novice
can continue making agent-driven edits for a long time without realizing that the current worktree
is their recovery boundary. Add a low-noise safety experience that makes the worktree state visible,
offers an obvious local checkpoint command, and protects high-risk agent runs with a recoverable
baseline.

The builder must evaluate the least intrusive design that still helps novice users. Advanced users
must be able to understand, dismiss, or configure the guidance without weakening existing guards.

## Outcomes

- A user can see when the workspace is dirty, has no usable baseline, or has not been checkpointed
  recently, with actionable but non-blocking guidance by default.
- `aios checkpoint` (or the builder's justified equivalent) creates a clearly identified local Git
  checkpoint without publishing secrets or changing remote state.
- A high-risk autonomous/batch agent run has a recoverable local baseline before it can mutate files,
  or it fails closed with a clear explanation and recovery action.
- Advanced users are not spammed during ordinary interactive work and retain an explicit opt-out or
  configuration path for informational nudges only.

## Interface / integration points

- `scripts/scaffold-project.sh` — already initializes Git and creates the initial commit.
- `scripts/aios.mjs` and the CLI command modules — add or expose checkpoint/status behavior.
- `scripts/onboard-inspect.mjs` — surface Git readiness during onboarding/preflight.
- `hooks/team-ops-guard.sh` and `hooks/file-governance-guard.mjs` — preserve existing write and
  governance enforcement; do not replace them with model-driven checks.
- `scripts/cli/usage.mjs` — document the user-facing command and guidance.
- `docs/GETTING-STARTED.md` and scaffold Git workflow templates — teach the recovery model at the
  point of onboarding.

## Dependencies

Depends on: existing scaffold Git initialization and workspace governance hooks.

## Scope

**In:**

- Inspect current Git/worktree state and define novice-facing states and message frequency.
- Design and implement a local checkpoint command or equivalent with safe commit semantics.
- Choose and implement the least noisy trigger for high-risk agent runs.
- Add deterministic tests for no-Git, clean, dirty, first-checkpoint, checkpoint-failure, and
  secret-bearing/uncommittable worktree cases.
- Update onboarding/help text with concise recovery guidance.

**Deferred:**

- Automatic remote creation or remote push.
- Full snapshot/version-store abstraction outside Git.
- Obsidian integration.
- New autonomous-agent policy tiers beyond the checkpoint safety requirement.

**Fenced out:**

- Do not weaken existing protected-path, secret, tier, or primary-checkout guards.
- Do not silently commit or publish private content; checkpoint behavior must be local-only and
  transparent.

## Implementation approach

The build agent should compare at least these designs before choosing one:

1. warning-only plus explicit `aios checkpoint`;
2. warning plus automatic local checkpoint before high-risk runs;
3. a hybrid where automatic checkpoints occur only for dirty/uncheckpointed high-risk runs and are
   suppressed after a recent checkpoint.

Prefer a hybrid if it can be made deterministic and quiet. Define “high-risk,” checkpoint naming,
recent-checkpoint age, failure behavior, and how users inspect or recover a checkpoint. Treat a
dirty worktree as normal user state, not as permission to discard or reset changes.

## Acceptance criteria

### Automated

- `node --test test/scaffold-project.test.mjs test/git-checkpoint.test.mjs` exits 0 and proves that a
  scaffolded workspace contains an initial Git commit and Git workflow guidance.
- `node --test test/git-checkpoint.test.mjs` covers clean, dirty, missing-Git, no-identity,
  secret-bearing, checkpoint-failure, and repeated-run/noise cases.
- `node --test test/high-risk-agent-checkpoint.test.mjs` proves that a high-risk run cannot begin
  mutation without either a verified baseline or an explicit safe stop.
- `node --test test/git-checkpoint.test.mjs` proves checkpoint creation never pushes, resets, stages
  secrets, or overwrites user content.
- Existing governance and runtime conformance suites exit 0.

### Manual

- A novice can understand the warning and create a checkpoint without knowing Git terminology.
- An advanced user can run ordinary interactive sessions without repeated noisy prompts and can
  configure informational guidance without disabling hard safety guards.
- Recovery from a simulated bad agent write is demonstrated using the generated checkpoint.

## Source

Follow-on from the AI salon incident analysis: destructive agent writes in an unversioned/disabled-
Git workspace. AIOS already scaffolds Git; this slice hardens discovery and use of that recovery
boundary for novice users.

## Build-with

Build-with: Opus / high effort; implementation choice is intentionally open, with a small UX review
for warning frequency and advanced-user noise.

## Tier safety

No brain/sync surfaces touched.
