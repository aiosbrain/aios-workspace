---
name: ai-code-review
description: Review AI-generated code, agent-produced diffs, pull requests, commits, or implementation summaries for security, correctness, maintainability, test coverage, supply-chain risk, and technical best practices. Use when the user asks to review AI-generated code, review an agent wrap-up, audit a PR from an AI coding agent, or validate claims like "CI green", "secrets rotated", "tests added", or "mergeable".
version: 1.0.0
access: team
compatibility: opencode
triggers:
  - review code
  - code review
  - ai code review
  - MERGE_READY
---

# AI Code Review

## Review Stance

Treat AI-generated code as untrusted until verified. Prioritize concrete defects, security risks, behavioral regressions, missing tests, and false claims over style feedback. Do not rubber-stamp summary claims; verify them against code, diffs, CI, logs, and tests whenever available.

When the user provides only an implementation summary, review the claims as claims. Identify what can be validated from available context, what remains unverified, and what artifacts are needed for a real code review.

## Inputs To Gather

Before reviewing, gather the most specific artifact available:

- PR URL, branch, commit SHA, patch, diff, or changed files.
- Agent wrap-up or transcript, if that is the only available input.
- Test output, CI status, dependency changes, migration files, generated files, and environment/config changes.
- Relevant product or security invariants from repo rules, docs, or contracts.

If reviewing a local repo, inspect the current worktree before making judgments:

```bash
git status --short
git diff --stat
git diff
git diff --staged
```

For PRs, inspect all commits and changed files, not just the latest commit or the summary.

## Security Checks

Always check security before maintainability:

- Secrets: no committed `.env`, keys, tokens, passwords, private certs, auth headers, raw credentials, or leaked secret values in logs, tests, snapshots, docs, fixtures, transcripts, or CI output.
- Secret handling: rotation claims are verified; old keys are invalidated; redaction is real; local-only secret files remain ignored; logs never print decrypted values.
- Injection: SQL, command, template, prompt, path traversal, SSRF, XSS, unsafe deserialization, YAML/XML parser risk, and JSON-RPC or line-protocol parsing errors.
- Auth and access control: no privilege bypass, missing tenant/user checks, insecure defaults, broad scopes, disabled validation, or trust of client-controlled values.
- Dependencies: new packages are necessary, reputable, pinned through the repo's package manager, license-compatible, and do not introduce risky install scripts or transitive attack surface without justification.
- Network and file I/O: URLs, paths, subprocess args, uploads, downloads, and archive extraction are validated and least-privilege.
- Cryptography: no homegrown crypto, weak randomness, hardcoded salts, insecure token comparison, or unauthenticated encryption.
- AI-specific risks: generated prompts, tool calls, connectors, MCP/agent gateways, and adapters do not allow prompt injection to escape boundaries or exfiltrate local/admin-tier data.

## Correctness And Architecture Checks

Review behavior as a user would experience it:

- Does the change solve the requested problem, including edge cases and failure paths?
- Are contracts, schemas, migrations, API versions, and protocol docs kept in sync?
- Are errors surfaced clearly without swallowing useful diagnostics or leaking sensitive data?
- Is concurrency, retry, timeout, cancellation, idempotency, and partial failure behavior safe?
- Are compatibility decisions intentional for persisted data, public APIs, CLI behavior, and shipped workflows?
- Does the implementation fit existing repo patterns rather than introducing unnecessary abstractions?
- Are generated or snapshot files deterministic and limited to what the change needs?

## Test Coverage Checks

Tests should prove the risky behavior, not merely execute happy paths:

- Unit tests for pure logic, parsing, mapping, validation, and edge cases.
- Integration or contract tests for adapters, APIs, CLI commands, database changes, auth, sync boundaries, and external service behavior.
- Regression tests for the specific bug or risk being addressed.
- Negative tests for invalid input, unauthorized access, malformed streams, missing config, timeout/error paths, and secret redaction.
- Fixture tests use realistic examples without embedding live secrets or private data.
- CI actually runs the relevant tests; "dev-only" tests are not enough for merge confidence.

If tests cannot be run, say so and explain the residual risk.

## Reviewing Agent Summaries

When the input is a wrap-up from another AI agent:

1. Extract each concrete claim: commits, PR numbers, files changed, dependencies added, keys rotated, CI green, live verification, mergeability, tests added, and work left untouched.
2. Verify claims against source artifacts. Use GitHub, git history, diffs, CI checks, package lockfiles, and test output where available.
3. Treat unverifiable claims as open risk, not truth.
4. Look for gaps between the summary and reviewable evidence: missing diffs, omitted files, secret handling details, skipped tests, unpushed commits, or "environment allowed" caveats.
5. Flag claims that are too broad, such as "fully closed out", "all live-verified", "secret-free", or "mergeable", unless evidence supports them.

## Finding Severity

Use severity labels consistently:

- `Critical`: exploitable security issue, secret leak, data loss, auth bypass, supply-chain compromise, or production-breaking regression.
- `High`: likely bug, contract break, missing access check, broken CI/test gate, unsafe migration, or major untested behavior.
- `Medium`: edge-case bug, maintainability issue with real future cost, insufficient tests for important logic, or unclear error handling.
- `Low`: minor quality, naming, style, documentation, or test clarity issue.

Avoid vague feedback. Every finding should include:

- The affected file, PR, commit, or claim.
- The concrete risk or failure mode.
- Why the current evidence supports the finding.
- A suggested fix or next verification step.

## Mergeability Declaration

Every code review must include a clear mergeability declaration. Do not leave the user to infer it from the findings.

- Use one of these exact declarations: `Ready to merge`, `Not ready to merge`, or `Conditionally ready to merge`.
- Put the declaration in its own `## Mergeability` section after findings and before open questions.
- If the declaration is `Not ready to merge`, identify the blocker(s) that must be fixed first.
- If the declaration is `Conditionally ready to merge`, state the concrete conditions that must be satisfied before merge, such as a specific CI job passing or a missing artifact being verified.
- If the declaration is `Ready to merge`, mention any residual non-blocking risk or test gap briefly.

## Output Format

Lead with findings. If there are no findings, say that clearly and mention remaining test gaps or unverifiable claims.

Use this structure:

```markdown
## Findings

- `Severity` `file-or-claim`: Concrete issue and impact. Include the suggested fix or verification step.

## Mergeability

- `Ready to merge` / `Not ready to merge` / `Conditionally ready to merge`: One-sentence rationale.

## Open Questions

- Any missing artifact, ambiguity, or claim that could not be verified.

## Verification

- Tests, CI checks, git/GitHub commands, secret scans, or docs reviewed.
- Anything that could not be run or inspected.
```

For a summary-only review, replace file paths with claim references, for example: `High` `claim: secrets rotated`.

## Review Discipline

Do not include praise before findings. Keep summaries brief and secondary. Do not expose secret values in the review. If a secret appears in the input, refer to it generically, recommend rotation, and avoid repeating it.

## Approval Criteria for MERGE_READY

`MERGE_READY` is only for code that is ready to merge, not plans, summaries, or unverified claims. Emit `MERGE_READY` only when all of these conditions pass:

| # | Condition | What disqualifies |
|---|-----------|-------------------|
| 1 | **No blocking findings** | Any `Critical`, `High`, or unresolved merge-blocking `Medium` finding. |
| 2 | **Evidence reviewed** | Only an implementation summary was provided, the diff/PR/commit could not be inspected, or key changed files were unavailable. |
| 3 | **Required verification passed or is concretely evidenced** | Relevant CI/tests/security scans were not run, failed, or are claimed without evidence. |
| 4 | **Safety-critical surfaces are covered** | Auth, access control, secrets, migrations, data contracts, dependency changes, destructive operations, or public API changes are present but unreviewed or unresolved. |
| 5 | **Mergeability declaration is `Ready to merge`** | The review says `Not ready to merge` or `Conditionally ready to merge`. |

Do **not** emit `MERGE_READY` for summary-only reviews, conditional approvals, missing CI, unverified secret-rotation claims, unresolved security questions, or "looks good if tests pass" outcomes.

When all conditions pass, append this token **alone on the very last line** of the response:

MERGE_READY
