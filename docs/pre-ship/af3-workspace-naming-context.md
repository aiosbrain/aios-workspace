# AF3 — Workspace naming (`{handle}-workspace`) + context setup audit

Parent epic: Agent-first onboarding. Linear child: **AF3 — Workspace naming + context setup conventions**

## Why

Contributors land in `{handle}-workspace` with a populated `0-context/` — not generic slugs. Clear naming plus a post-scaffold location hint means a fresh contributor knows where their workspace lives and that its context directory is seeded.

## What

1. Update scaffold hints in `scripts/scaffold-project.sh` so `--help` documents the `{handle}-workspace` naming pattern.
2. Add a post-scaffold echo (new behavior) to `scripts/scaffold-project.sh`: after a successful scaffold, print exactly one line **to stdout** matching `Recommended location: ~/Projects/<slug>`, where `<slug>` is the value passed to `--slug`. The line MUST be written to stdout (not stderr), because the acceptance check greps piped stdout. This is a new line to add, not existing output to verify.
3. Ensure the file `scaffold/.claude/skills/workspace-setup/SKILL.md` exists and contains naming guidance that references the `{handle}-workspace` pattern. This file is a **new file to create if absent** (see New files to create). The builder MUST:
   - If the file already exists but the string `{handle}-workspace` is missing, **edit** the file to add naming guidance containing that literal pattern.
   - If the file does **not** exist, **create** the file (including any missing parent directories under `scaffold/.claude/skills/workspace-setup/`) and add naming guidance containing the literal `{handle}-workspace` pattern.
   In both cases the file ends with the `{handle}-workspace` string present. `SKILL.md` is `employee`-tier and editable within AF3 (see Tier-safety).
4. Verify — by observable post-scaffold state only — whether a fresh scaffold with `--context employee` populates a non-empty `0-context/` directory. The check is `0-context/` is non-empty after scaffold; it does **not** assume any specific subdirectory name. This is a read-only verification of existing, unedited scaffold behavior; the `0-context/` context templates are `team`-tier and out of scope for editing. Item 4 has a **defined two-branch outcome**, and AF3 closure depends on exactly one of those branches being satisfied and recorded — see **Item 4 closure** below.

Scaffold command (exact, hermetic — cleans the output dir first):

```bash
rm -rf /tmp/af3-smoke
scripts/scaffold-project.sh --context employee --slug test-smoke-workspace \
  --output /tmp/af3-smoke --owner test-smoke
validation/validate-all.sh /tmp/af3-smoke
```

## Item 4 closure (single authoritative rule)

Item 4 depends on existing, unedited scaffold behavior (`--context employee` seeding `0-context/`). Its closure is governed by this rule, which is the authoritative statement — the acceptance list and operator verification below defer to it:

- **Pass branch:** if `--context employee` populates a non-empty `0-context/` after the hermetic scaffold (`find /tmp/af3-smoke/0-context -type f | head -1` returns a path), the context-population check passes as-is — no file edits required.
- **Escalation branch:** if `--context employee` does **not** populate a non-empty `0-context/`, the builder MUST stop and file a Linear finding against the employee context templates, recording the finding link in the AF3 PR. The builder MUST NOT edit `0-context/` templates to force the check to pass — those are `team`-tier and out of scope for AF3 (see Tier-safety). Exact filing details are in the **Escalation branch — Linear finding specifics** section.

AF3 is closeable when **exactly one** of these two branches is satisfied and recorded. Items 1–3 are independent editable deliverables and ship in the PR regardless of which item-4 branch is taken. The empty-`0-context/` case is therefore never a silent or ambiguous failure: it has a single defined, recorded outcome (a filed finding), and it does not block AF3.

## Escalation branch — Linear finding specifics

The builder must follow these instructions when the escalation branch is taken. No decisions are left to the builder — every field is specified.

- **Project/team:** File the finding under the `aio-sh` project. If the `employee-context-templates` sub-project exists inside `aio-sh`, file it there; otherwise file on the main `aio-sh` board. Apply the label `employee-context` to the issue.
- **Finding template (copy verbatim):**
  ```
  Title: [AF3] Employee context templates: 0-context/ empty after scaffold with --context employee

  Description:
  During AF3 context-population verification, `scripts/scaffold-project.sh --context employee ...`
  produced an empty `0-context/` directory. The expected behavior is that the employee context
  templates seed at least one file. This finding is filed as part of the escalation branch defined
  in the AF3 spec. The AF3 PR will not edit the templates directly.
  ```
- **Recording the link:** After filing, post a single comment on the AF3 PR (in the main PR conversation, not a review comment) containing only the public link to the Linear finding. The comment must include the full URL of the finding.

These steps make the escalation branch fully observable and self-contained for a builder with zero conversation history.

## Acceptance criteria

Each criterion is individually observable. The item-4 criterion is branch-aware to match the **Item 4 closure** rule — there is no separate flat "must be non-empty" requirement.

- `scripts/scaffold-project.sh --help` output contains the string `{handle}-workspace` (`scripts/scaffold-project.sh --help | grep -q '{handle}-workspace'` exits **0**).
- Running the hermetic scaffold command above prints, **on stdout**, a line matching the regex `^Recommended location: ~/Projects/test-smoke-workspace$` (the added post-scaffold echo, using the provided `--slug`).
- The hermetic scaffold command above exits **0**.
- `validation/validate-all.sh /tmp/af3-smoke` exits **0**.
- **Context-population (branch-aware):** after the hermetic scaffold, **either** (a) `find /tmp/af3-smoke/0-context -type f | head -1` returns a path (pass branch) **or** (b) it returns empty and a Linear finding against the employee context templates is filed according to the **Escalation branch — Linear finding specifics** section, and its link is posted as a PR comment (escalation branch). AF3 requires exactly one of (a) or (b) to be true and recorded; both branches are acceptable closure states.
- **SKILL.md naming guidance:** `grep -q '{handle}-workspace' scaffold/.claude/skills/workspace-setup/SKILL.md` exits **0** after the builder has completed item 3 (creating the file and/or adding the pattern as needed). The file must exist and contain the literal string at PR time.
- `npm run aios -- spec eval docs/pre-ship/af3-workspace-naming-context.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** in the aios-workspace PR —
  1. scaffold `--help` hint update (adds `{handle}-workspace`),
  2. the new post-scaffold echo line written to **stdout** in `scripts/scaffold-project.sh`,
  3. SKILL.md naming guidance present: if `scaffold/.claude/skills/workspace-setup/SKILL.md` already exists, it is edited (or left untouched) to contain `{handle}-workspace`; if it does **not** exist, the file is created (with any missing parent directories) and the naming guidance including `{handle}-workspace` is added,
  4. the context-population verification: run the hermetic scaffold command and record which item-4 branch applied — pass branch (non-empty `0-context/`), or escalation branch (empty → Linear finding filed according to the **Escalation branch — Linear finding specifics** section and link posted as a PR comment). The builder MUST NOT edit `0-context/` templates.
- **Operator verifies:** the hermetic scaffold command exits **0** on a local machine, and each acceptance-criteria check above is satisfied — where the branch-aware context-population criterion is satisfied by whichever single branch (pass or escalation) the builder recorded, per **Item 4 closure**.

## Optional follow-up (not blocking AF3)

- aios-website example updates — file a Linear child; not required to close AF3.

## Integration points

Existing files edited:

- `scripts/scaffold-project.sh` — `--help` text and the new post-scaffold stdout echo.

New files to create (if absent):

- `scaffold/.claude/skills/workspace-setup/SKILL.md` — created with naming guidance that contains the literal `{handle}-workspace` pattern. Any missing parent directories must be created as part of item 3.

Existing files invoked as-is (no edits):

- `validation/validate-all.sh` — run against the scaffolded output for verification.

## Deps

Deps: none — runs in parallel with AF1. Item 4 has a soft dependency on existing employee-context seeding behavior, resolved deterministically by the two-branch **Item 4 closure** rule above (pass or filed-finding).

## Scope

In scope: naming pattern in `--help`; the post-scaffold stdout location echo; SKILL.md naming-guidance provision (create the file if missing, or edit it if present but lacking the pattern); and read-only verification that `--context employee` seeds a non-empty `0-context/`, with a defined escalation outcome if it does not — all within this repo.

Out of scope: renaming existing workspaces on disk; editing `0-context/` context templates (team-tier — escalated via a filed finding, never modified in AF3); aios-website example updates (deferred to optional follow-up).

## Build-with

Build-with: sonnet / low.

## Tier-safety

Sync/brain surfaces are not touched.

- `scripts/scaffold-project.sh` and `scaffold/.claude/skills/workspace-setup/SKILL.md` are `employee`-tier and editable within AF3 (items 1–3). If `SKILL.md` must be created, it is a new `employee`-tier artifact.
- Context templates under `0-context/` remain `team`-tier and are **not** edited by this work. The scaffold only copies existing templates and does not alter their tier tagging.
- Item 4 verifies scaffold output **without** editing those templates — if the seeding behavior is absent, the builder escalates by filing a Linear finding (escalation branch of **Item 4 closure**) rather than modifying team-tier files.

## Testability

Acceptance is demonstrable by the following named checks. The smoke test is hermetic: it removes `/tmp/af3-smoke` before scaffolding so a re-running builder cannot get a false pass/fail from stale output.

- **Help-string test:** `scripts/scaffold-project.sh --help | grep -q '{handle}-workspace'` exits **0**.
- **Echo test (stdout-scoped):** running the hermetic scaffold command and piping **stdout** through `grep -Eq '^Recommended location: ~/Projects/test-smoke-workspace$'` exits **0**. (The echo must target stdout; a stderr write fails this check by design.)
- **Scaffold + validation smoke (hermetic):**
  ```bash
  rm -rf /tmp/af3-smoke
  scripts/scaffold-project.sh --context employee --slug test-smoke-workspace \
    --output /tmp/af3-smoke --owner test-smoke && \
    validation/validate-all.sh /tmp/af3-smoke
  ```
  exits **0**.
- **Context-population test (branch-aware):** after the hermetic scaffold, `find /tmp/af3-smoke/0-context -type f | head -1` either returns a non-empty path (pass branch closes item 4) or returns empty, in which case item 4 is closed by the escalation branch — a Linear finding filed per **Escalation branch — Linear finding specifics** and its link posted as a PR comment — per **Item 4 closure**. Exactly one branch is recorded; neither is a silent failure.
- **SKILL.md audit test:** `grep -q '{handle}-workspace' scaffold/.claude/skills/workspace-setup/SKILL.md` exits **0** after the builder has ensured the file exists and contains the pattern. If the file or pattern was missing before, item 3's create-or-edit step guarantees this exit code at PR time.