# AF1 — Agent-first onboarding contract (spec + playbook)

Owner: john@john-ellison.com
Parent epic: Agent-first onboarding.

**This document's path in the repo:** `docs/pre-ship/af1-agent-onboarding-contract.md`
(already present in this checkout — it is the spec you are reading; acceptance criteria that run
`spec eval` target this exact path).

Parent epic: Agent-first onboarding. Linear child title: **AF1 — Agent onboarding contract + canonical playbook**

## Why

Builders and operators need one machine-readable contract so a **cold-start agent** (no conversation
history) can onboard a new contributor without improvising paths, skipping validation, or conflating
team-brain access with individual workspace setup. Today onboarding is tribal knowledge spread across
`docs/GUIDE.md` and the website; there is no single agent-executable playbook, so agents guess flag
names, skip `validation/validate-all.sh`, and try to cross human-only gates they cannot pass.

## What

Author a new agent-onboarding contract document (see **New files to create**) that a cold-start agent
follows verbatim. It defines exactly five sections, each shipped under the **exact H2 heading token**
pinned in *Required document headings* below so the deliverable and its structural test cannot diverge:

1. **Canonical human doc URL** the agent must follow:
   `https://aiosbrain.dev/getting-started/onboarding-a-contributor/`
2. **Copy-paste agent system prompt** (block quoted in the doc, shipped verbatim — see below).
3. **Human-only gates** — browser OAuth, admin key issuance if self-serve fails, magic login link.
   The doc must instruct the agent to STOP and report a BLOCKER at each of these rather than attempt them.
4. **Expected end state** — the concrete verify commands and their observable outcomes (specified under
   *Expected end state contract* below, so the builder has ground truth without running the gated flow).
5. **Naming convention** — `--slug {handle}-workspace`, `--output ~/Projects/{handle}-workspace`,
   `--owner {handle}`, `--context employee|consultant`.

### Required document headings (exact tokens the doc test asserts)

The document MUST contain these five H2 headings verbatim (byte-for-byte), and the test in
`test/af1-agent-onboarding-doc.test.mjs` asserts each string exactly:

- `## Canonical human doc URL`
- `## Copy-paste agent system prompt`
- `## Human-only gates`
- `## Expected end state`
- `## Naming convention`

### Canonical CLI invocation form

The scaffolded workspace does **not** guarantee an `aios` binary on `PATH`. The canonical invocation
form throughout the doc, the prompt, and all acceptance criteria is `npm run aios -- <subcommand>`
(delegates to `scripts/aios.mjs`). The prompt below uses this form for every command so the agent has
one unambiguous invocation.

### Agent system prompt (ship verbatim in doc — canonical expected string)

This fenced block is the **canonical expected string**. `test/af1-agent-onboarding-doc.test.mjs`
extracts the first fenced code block that follows the `## Copy-paste agent system prompt` heading in
the shipped doc and asserts it is **byte-for-byte equal** to the reference constant embedded in the
test — including the two-space indentation on the `scripts/scaffold-project.sh` lines, the trailing
`\` line-continuation, and the blank lines. Any drift (whitespace, wording, a missing line) fails the
test. This removes the earlier "grep for two lines vs. exact block" ambiguity: the whole block is
pinned, not just the two verify-command lines.

```
You are onboarding a new AIOS individual contributor. Follow exactly:
https://aiosbrain.dev/getting-started/onboarding-a-contributor/

Rules:
- Ask the human for {handle} and context (employee|consultant) if not provided before scaffolding.
- Run every command in order. Do not skip validation/validate-all.sh.
- Scaffold with:
  scripts/scaffold-project.sh --context {employee|consultant} --slug {handle}-workspace \
    --output ~/Projects/{handle}-workspace --owner {handle}
- Stop and report a BLOCKER if a step requires human admin action, browser OAuth, or a secret you cannot obtain.
- Never commit API keys. Put AIOS_API_KEY in .env only.
- After setup, run: npm run aios -- status (must exit 0), validation/validate-all.sh . (must exit 0).
- Optional: configure `npm run aios -- mcp` for shell-less brain read (see docs/GUIDE.md, MCP setup).

Report: workspace path, aios status summary, validate-all exit code, and every BLOCKER step.
```

### Expected end state contract (ground truth the doc must state)

The doc must document these verify commands and their observable outcomes so any reader knows the
target state without executing the human-gated flow:

- Workspace directory `~/Projects/{handle}-workspace/` exists and contains the files listed by
  `scripts/scaffold-project.sh`'s own completion summary (the script's printed output is the source of
  truth for the file list — the doc references it rather than duplicating it).
- `.env` contains `AIOS_API_KEY` and is git-ignored (never committed).
- `npm run aios -- status` exits `0` and prints a brain-connection summary line.
- `validation/validate-all.sh .` exits `0`.
- Success is defined as: workspace directory present **and** both commands above exit `0`. Anything an
  agent cannot reach (OAuth, admin-key issuance) is reported as a BLOCKER, not attempted.

## New files to create

Neither path below currently exists in the repo tree; both are deliverables of this slice. Parent
directories are created if absent.

- `docs/getting-started/agent-onboarding.md` — the deliverable. Parent dir `docs/getting-started/`
  does not yet exist and is created by this slice. Contains all five sections (under the exact heading
  tokens above) and the verbatim prompt block.
- `test/af1-agent-onboarding-doc.test.mjs` — structural test for the doc deliverable. Parent dir
  `test/` already exists (it holds `test/spec-eval-cli.test.mjs`). See *Testability*.

Note: `docs/pre-ship/af1-agent-onboarding-contract.md` (this spec) already exists and is **not** a new
file — it is the target of the `spec eval` acceptance criterion below.

## Acceptance criteria

Each criterion is observable via a command with a defined pass condition; all doc-structure checks run
without executing the gated onboarding flow, and none require brain access or secrets unless explicitly
noted.

- **Doc exists with all five exact headings**: `docs/getting-started/agent-onboarding.md` exists and
  contains the five H2 headings byte-for-byte: `## Canonical human doc URL`,
  `## Copy-paste agent system prompt`, `## Human-only gates`, `## Expected end state`,
  `## Naming convention`. Verified by `test/af1-agent-onboarding-doc.test.mjs` asserting each exact
  heading string is present. Pass = `node --test test/af1-agent-onboarding-doc.test.mjs` exits `0`.
- **Verbatim prompt present (byte-for-byte)**: the first fenced code block after
  `## Copy-paste agent system prompt` equals the canonical expected string in *Agent system prompt*
  above, byte-for-byte (whitespace, `\` continuation, and indentation included). Verified by the doc
  test comparing the extracted block against its embedded reference constant (exact string equality,
  not a substring grep).
- **Canonical invocation is consistent**: the doc contains zero bare-`aios ` runnable command
  invocations outside the fenced prompt example; all runnable commands use `npm run aios -- `. Verified
  by the doc test (assertion for absence of lines matching `^\s*aios `).
- **Spec self-evaluates deterministically clean (no secrets)**:
  `npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md --no-llm` exits `3`
  (`NOT_EVALUATED` — deterministic layer clean, LLM layer opted out). This is the cold-CI gate: it runs
  with no brain access and no secrets. A deterministic must-fail would instead exit `1`, so exit `3` is
  the observable pass condition here. The **full adversarial pass** (`spec eval` without `--no-llm`,
  exit `0`) requires brain access plus an API secret and therefore runs only in an environment where
  those are provisioned; it is explicitly **not** part of the cold-CI gate.
- **Naming-convention flags present in the doc**:
  `grep -E -- '--(slug|output|owner|context)' docs/getting-started/agent-onboarding.md` returns matches.
  Verified by the doc test.
- **Naming-convention flags are real (not tautological)**: the four flags the doc documents must match
  flags actually accepted by the authoritative script. Observable command:
  `for f in slug output owner context; do grep -qE -- "(^|[[:space:]])--$f\b" scripts/scaffold-project.sh || { echo "missing --$f in scaffold-project.sh"; exit 1; }; done`
  must exit `0`. The doc test runs this same check programmatically (reads `scripts/scaffold-project.sh`
  and asserts each of `--slug/--output/--owner/--context` appears in the script's argument parsing), so
  a doc that documented a wrong flag set (e.g. `--project-slug` while the script accepts `--slug`) fails
  against the script rather than passing tautologically. Both the doc grep and the script cross-check
  must pass.
- **Tier-safety posture statements present**: `docs/getting-started/agent-onboarding.md` contains these
  literal substrings (case-sensitive): `Admin-tier content never syncs`, `Default-deny on missing`,
  and `422`. Verified by `test/af1-agent-onboarding-doc.test.mjs` (grep assertions on the doc body).
  Pass = `node --test test/af1-agent-onboarding-doc.test.mjs` exits `0`.
- **Website cross-link (separate deliverable — see Scope)**: after the website PR merges,
  `grep -q "agent-onboarding" aios-website/src/content/docs/getting-started/onboarding-a-contributor.mdx`
  succeeds; if the website ships in a separate repo/PR, a cross-repo handoff note is recorded in the epic
  comment. This criterion is explicitly gated on the website PR and does **not** block the workspace-repo
  deliverable.

## Integration points (existing files)

- `scripts/scaffold-project.sh` — referenced flags (authoritative source for `--slug/--output/--owner/--context`,
  cross-checked by the doc test) and post-scaffold completion output (source of truth for the scaffolded
  file list).
- `scripts/aios.mjs` — provides `status` and `mcp` subcommands invoked as `npm run aios -- <cmd>`, and
  the `spec eval` command used in acceptance.
- `validation/validate-all.sh` — mandatory gate referenced in the prompt.
- `docs/GUIDE.md` — existing operator guide referenced for optional MCP setup; referenced generally, no
  specific section/table is load-bearing for this slice.
- `test/spec-eval-cli.test.mjs` — existing test kept green; confirms the `test/` parent dir exists for
  the new doc test.
- `aios-website/src/content/docs/getting-started/onboarding-a-contributor.mdx` — canonical human steps;
  edited only in the website-repo deliverable (see Scope / module boundary). Assumed **absent** from the
  default workspace checkout.

## Module boundary

Primary deliverable and all must-path acceptance run in the **workspace repo** checkout: the new
`docs/getting-started/agent-onboarding.md` and `test/af1-agent-onboarding-doc.test.mjs`, plus
`spec eval --no-llm` against this spec. The `aios-website` mdx edit is a **separate deliverable** that
lands in the `aios-website` repo. The builder should assume the `aios-website` tree is **not** present
in the workspace checkout unless it is checked out as a sibling; the default path is a cross-repo handoff
(a website PR + an epic comment recording it).

All must-path acceptance criteria in this slice are satisfiable in the default checkout without the
website tree: heading/prompt/invocation checks read the new doc, flag verification uses
`scripts/scaffold-project.sh` as the authoritative source, and `spec eval --no-llm` needs no secrets.
The only website-dependent criterion is the separately-gated cross-link, which does not block the
workspace-repo deliverable.

## Deps

Deps: none for the workspace-repo deliverable — documentation slice referencing already-shipped
`docs/GUIDE.md`, `scripts/scaffold-project.sh`, `scripts/aios.mjs`, and `validation/validate-all.sh`.
The cold-CI `spec eval --no-llm` gate has **no** secret/brain dependency. The full adversarial
`spec eval` (exit 0) and the optional website cross-link have out-of-band dependencies (brain access +
API secret; write access to the `aios-website` repo respectively) and are both handled as separate,
non-blocking paths — see Scope and Testability.

## Scope

In scope: the agent playbook markdown (`docs/getting-started/agent-onboarding.md`), its structural test
(`test/af1-agent-onboarding-doc.test.mjs`), and the verbatim prompt block. The website cross-link mdx
edit is in scope **only if** the `aios-website` tree is available in the same checkout; otherwise it is
handed off via a website PR + epic comment.

Out of scope (deferred): CLI `aios onboard --agent` mode; hosted "paste URL" web UI; automated smoke
runner that executes the full onboarding flow; the full adversarial `spec eval` (exit 0) run, which is
performed only in a secret-provisioned environment and is not a cold-CI gate.

## Build-with

Build-with: sonnet / low — documentation and cross-links only; no runtime code paths change.

## Tier-safety

Trigger: the doc describes brain-sync surfaces (`npm run aios -- status`, `mcp`) and admin-key issuance.

Posture the doc must state (authoritative **within this contract** — the doc states these directly and
does not depend on an unverifiable external section/table; align with `docs/GUIDE.md` where present):

- Admin-tier content never syncs.
- Default-deny on missing `access:` metadata.
- Admin push returns `422`.

This slice introduces **no** sync behavior changes and emits **no** tier-tagged signals; it only
documents existing posture. Because no signals are emitted, SR10's signal-contract-shape requirement
does not apply — there is no emitted signal for which a tier-tagged contract reference would be needed.

## Testability

Automated (named tests, reproducible in a cold environment with no brain access or secrets):

- `node --test test/af1-agent-onboarding-doc.test.mjs` — new test asserting: (a) the five exact H2
  heading tokens are present (`## Canonical human doc URL`, `## Copy-paste agent system prompt`,
  `## Human-only gates`, `## Expected end state`, `## Naming convention`); (b) the fenced prompt block
  after the prompt heading is **byte-for-byte equal** to the canonical expected string embedded in the
  test (full-block equality, not a two-line grep); (c) no bare runnable `aios ` invocations
  (`^\s*aios ` absent); (d) `--slug/--output/--owner/--context` present in the doc **and** each of
  those four flags present in `scripts/scaffold-project.sh`'s argument parsing (script read
  programmatically — catches a doc that documents flags the script does not accept); (e) tier-safety
  posture substrings present (`Admin-tier content never syncs`, `Default-deny on missing`, `422`).
  This demonstrates
  the core doc-deliverable acceptance without touching the human-gated onboarding flow.
- `npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md --no-llm` — expected exit
  `3` (deterministic-clean, LLM opted out); no secrets required. This is the reproducible cold-CI gate
  for spec readiness.
- `node --test test/spec-eval-cli.test.mjs` — remains green (spec-eval CLI regression).

Requires secrets / not a cold-CI gate (documented so no criterion silently assumes an unavailable env):

- Full adversarial `npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md` (no
  `--no-llm`) → exit `0`. Requires brain access + API secret; run only where provisioned.
- Website link-check in the `aios-website` build (only in the website-repo deliverable).

Manual (not a gate, cannot run in CI): a cold agent session given only the playbook URL + prompt
completes scaffold + `validation/validate-all.sh` where a human is present to clear OAuth/admin gates.
This is documented as manual because the gates are human-only by design; the automated doc test above
is the reproducible pass/fail result for the deliverable.