# AF3 — Workspace naming (`{handle}-workspace`) + context setup audit

Parent epic: Agent-first onboarding. Linear child: **AF3 — Workspace naming + context setup conventions**

## Why

Contributors land in `{handle}-workspace` with a populated `0-context/` — not generic slugs. Clear naming plus a post-scaffold location hint means a fresh contributor knows where their workspace lives and that its context directory is seeded.

## What

1. Update scaffold hints in `scripts/scaffold-project.sh` so `--help` documents the `{handle}-workspace` naming pattern.
2. Add a post-scaffold echo (new behavior) to `scripts/scaffold-project.sh`: after a successful scaffold, print exactly one line **to stdout** matching `Recommended location: ~/Projects/<slug>`, where `<slug>` is the value passed to `--slug`. The line MUST be written to stdout (not stderr), because the acceptance check greps piped stdout. This is a new line to add, not existing output to verify.
3. Ensure `scaffold/.claude/skills/workspace-setup/SKILL.md` naming guidance references the `{handle}-workspace` pattern. This is an **edit-if-absent** deliverable, not a read-only verification: if the string is present, no change is required; if the string is absent, the builder MUST add naming guidance to `SKILL.md` that includes the literal `{handle}-workspace` pattern. `SKILL.md` is `employee`-tier and editable within AF3 (see Tier-safety). Either way the file ends with the string present.
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
- **Escalation branch:** if `--context employee` does **not** populate a non-empty `0-context/`, the builder MUST stop and file a Linear finding against the employee context templates, recording the finding link in the AF3 PR. The builder MUST NOT edit `0-context/` templates to force the check to pass — those are `team`-tier and out of scope for AF3 (see Tier-safety).

AF3 is closeable when **exactly one** of these two branches is satisfied and recorded. Items 1–3 are independent editable deliverables and ship in the PR regardless of which item-4 branch is taken. The empty-`0-context/` case is therefore never a silent or ambiguous failure: it has a single defined, recorded outcome (a filed finding), and it does not block AF3.

## Acceptance criteria

Each criterion is individually observable. The item-4 criterion is branch-aware to match the **Item 4 closure** rule — there is no separate flat "must be non-empty" requirement.

- `scripts/scaffold-project.sh --help` output contains the string `{handle}-workspace` (`scripts/scaffold-project.sh --help | grep -q '{handle}-workspace'` exits **0**).
- Running the hermetic scaffold command above prints, **on stdout**, a line matching the regex `^Recommended location: ~/Projects/test-smoke-workspace$` (the added post-scaffold echo, using the provided `--slug`).
- The hermetic scaffold command above exits **0**.
- `validation/validate-all.sh /tmp/af3-smoke` exits **0**.
- **Context-population (branch-aware):** after the hermetic scaffold, **either** (a) `find /tmp/af3-smoke/0-context -type f | head -1` returns a path (pass branch) **or** (b) it returns empty and a Linear finding against the employee context templates is filed and its link recorded in the AF3 PR (escalation branch). AF3 requires exactly one of (a) or (b) to be true and recorded; both branches are acceptable closure states.
- **SKILL.md naming guidance:** `grep -q '{handle}-workspace' scaffold/.claude/skills/workspace-setup/SKILL.md` exits **0**. If it did not before this work, the builder edits `SKILL.md` to add the pattern (item 3, edit-if-absent) so this check exits **0** at PR time.
- `npm run aios -- spec eval docs/pre-ship/af3-workspace-naming-context.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** in the aios-workspace PR —
  1. scaffold `--help` hint update (adds `{handle}-workspace`),
  2. the new post-scaffold echo line written to **stdout** in `scripts/scaffold-project.sh`,
  3. SKILL.md naming guidance present — edited to add `{handle}-workspace` if it was absent,
  4. the context-population verification: run the hermetic scaffold command and record which item-4 branch applied — pass branch (non-empty `0-context/`), or escalation branch (empty → Linear finding filed and linked). The builder MUST NOT edit `0-context/` templates.
- **Operator verifies:** the hermetic scaffold command exits **0** on a local machine, and each acceptance-criteria check above is satisfied — where the branch-aware context-population criterion is satisfied by whichever single branch (pass or escalation) the builder recorded, per **Item 4 closure**.

## Optional follow-up (not blocking AF3)

- aios-website example updates — file a Linear child; not required to close AF3.

## Integration points

Existing files edited:

- `scripts/scaffold-project.sh` — `--help` text and the new post-scaffold stdout echo.
- `scaffold/.claude/skills/workspace-setup/SKILL.md` — naming-guidance string; edited to add `{handle}-workspace` only if the string is absent (item 3, edit-if-absent).

Existing files invoked as-is (no edits):

- `validation/validate-all.sh` — run against the scaffolded output for verification.

New files to create: none.

## Deps

Deps: none — runs in parallel with AF1. Item 4 has a soft dependency on existing employee-context seeding behavior, resolved deterministically by the two-branch **Item 4 closure** rule above (pass or filed-finding).

## Scope

In scope: naming pattern in `--help`; the post-scaffold stdout location echo; SKILL.md naming-guidance edit-if-absent (add `{handle}-workspace` when missing); and read-only verification that `--context employee` seeds a non-empty `0-context/`, with a defined escalation outcome if it does not — all within this repo.

Out of scope: renaming existing workspaces on disk; editing `0-context/` context templates (team-tier — escalated via a filed finding, never modified in AF3); aios-website example updates (deferred to optional follow-up).

## Build-with

Build-with: sonnet / low.

## Tier-safety

Sync/brain surfaces are not touched.

- `scripts/scaffold-project.sh` and `scaffold/.claude/skills/workspace-setup/SKILL.md` are `employee`-tier and editable within AF3 (items 1–3).
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
- **Context-population test (branch-aware):** after the hermetic scaffold, `find /tmp/af3-smoke/0-context -type f | head -1` either returns a non-empty path (pass branch closes item 4) or returns empty, in which case item 4 is closed by the escalation branch — a filed, linked Linear finding — per **Item 4 closure**. Exactly one branch is recorded; neither is a silent failure.
- **SKILL.md audit test:** `grep -q '{handle}-workspace' scaffold/.claude/skills/workspace-setup/SKILL.md` exits **0**. If it did not before this work, item 3's edit-if-absent step adds the pattern so this exits **0** at PR time.