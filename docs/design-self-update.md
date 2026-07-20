# Design: `aios update` self-update — "auto-update like Claude Code"

**Status:** tier 1 shipped (`aios update` now pulls the toolkit too); tiers 2–3 proposed.
**Tracking:** [AIO-463](https://linear.app/je4light/issue/AIO-463).

## The problem

A contributor's AIOS install is really **two** repos, not one:

1. **The toolkit checkout** — a clone of `aios-workspace` (canonical at
   `AIOS_TOOLKIT_DIR`, default `~/Projects/aios/aios-workspace`). Holds all command
   code, `scaffold/`, validators, hooks. Has `node_modules`.
2. **The personal workspace** — the numbered spine (`0-context/` … `5-personal/`) the
   person actually works and commits into. Its CLI is a **thin shim** that forwards
   every `aios <cmd>` to the toolkit checkout, so command code never needs vendoring.

A scaffolded workspace also carries a **vendored copy** of the governance surface
(`.claude/{skills,rules,rubrics,commands}`, `hooks/`, `validation/`) — files Claude Code
and the validators read *in place*. `aios update` re-syncs exactly that surface from the
toolkit checkout via a 3-way merge.

The gap John hit: **`aios update` re-vendored FROM the toolkit checkout but nothing pulled
the checkout itself.** If that clone is stale, then:

- every `aios <cmd>` runs **stale command code** (the shim forwards to a stale checkout), and
- `aios update` faithfully re-vendors **stale governance**.

Unlike Claude Code (an npm global that `claude update` replaces wholesale), an AIOS
workspace is a live git repo the user commits into — so "get the latest" is not one
`npm i -g`; it is *pull the toolkit, reinstall its deps, then re-vendor governance into
my workspace without clobbering my own edits*.

## The update channel must separate two things

| Channel | What it is | Who owns it | Mechanism |
|---------|-----------|-------------|-----------|
| **Toolkit / scaffold updates** | command code, `scaffold/`, governance files | the project | `git pull` the toolkit checkout + `npm ci`; re-vendor into the workspace |
| **The user's own workspace content** | the numbered spine, their notes/decisions/work | the user | never touched by update — only the user commits here |

The vendored governance files are the one overlap. They live *inside* the user's repo but
are *owned by the toolkit*. The 3-way merge (`toolkit-merge.mjs`) already draws that line
correctly: committed local edits are merged, uncommitted edits are skipped (never
clobbered), personal additions are never deleted, conflicts land in
`.aios-incoming`/`.aios-merge` sidecars — never inline into a file that gets executed.
Self-update **reuses** that machinery; it does not invent a second merge policy.

## Tier 1 (shipped): one command, `aios update`

`aios update` does both halves end-to-end — bring the toolkit checkout current, then
re-vendor from it. (An earlier draft split this into a separate `aios upgrade` wrapper; a
single command is the right model — the two halves are one operation.)

```
aios update              # pull the toolkit (git + npm ci) + 3-way-merge governance
aios update --check      # dry-run: how far behind is the toolkit / this workspace? (no writes)
aios update --preview    # classify every managed-file change (implies --no-pull; no writes)
aios update --dry-run    # alias for --preview, UNLESS combined with --contribute (see below)
aios update --no-pull    # skip the git pull + npm ci; only re-vendor governance (the old behavior)
aios update --stash      # auto-stash a dirty toolkit tree, pull, then restore it
aios update --no-install # skip npm ci even if the toolkit lockfile changed
aios update --from DIR   # use a specific toolkit checkout as the source
aios update --force      # take the toolkit version for every managed file
aios update --contribute <path>  # upstream a locally-improved managed file as a toolkit PR
```

Flow: (1) **git half** (`toolkit-pull.mjs`) — classify the toolkit's remote status and report
it, fast-forward the tracked branch (**refuse a dirty tree** unless `--stash`; **refuse a
non-fast-forward** and tell the user to reconcile by hand — never clobber, never auto-merge
someone's checkout), then `npm ci` **only when the toolkit already has `node_modules`** (the
owner uses the GUI/tests) **and** the working lockfile's hash differs from the one recorded
at the last successful install (reconciled on every apply run, not just when the pull itself
moved the lockfile — so an install interrupted between the pull and `npm ci` self-heals on
the next run instead of being masked forever). Toolkit deps aren't needed for scaffolding or
`aios` sync, so a sync-only tester never eats a surprise install. Skipped for a
freshly-cloned source (already latest) or with `--no-install`. (2) **vendor half**
(`update.mjs` / `toolkit-merge.mjs`) — the
pre-existing 3-way re-vendor, now working from the freshened toolkit.

**Which toolkit gets pulled.** The shim and the CLI share **one** env var,
`$AIOS_TOOLKIT_DIR` (the toolkit checkout; the entrypoint derives as `<dir>/scripts/aios.mjs`).
The shim may still forward here via a relative path, so `update` resolves the source from
**the checkout it is executing from** (the running `aios.mjs`) ahead of the `~/Projects/...`
default — it always pulls/vendors the exact toolkit the user is running. `--from DIR` /
`$AIOS_TOOLKIT_DIR` still override. (The predecessor `$AIOS_TOOLKIT_CLI` — a direct path to
the entrypoint — is honored as a deprecated alias with a nudge, so existing custom-path
configs don't break.)

**Where it may run.** `aios update` resolves only a workspace (`aios.yaml`) or the toolkit
checkout (`scaffold/` + `scripts/aios.mjs`) — an explicit `--repo` is validated the same way,
so it can never be pointed at an arbitrary directory to re-vendor into. `--check` always
reports status (read-only); `--no-pull` only skips the pull on an *apply* run.

Run **inside the toolkit checkout itself** (John's case — his `aios-workspace` *is* the
toolkit), `aios update` just does the git half (nothing to re-vendor into).

**Bootstrapping caveat:** the very first rollout is chicken-and-egg — a checkout that predates
this change has an `aios update` that only re-vendors. Testers (and Chetan) run **one**
`git pull` in the toolkit dir the first time; after that `aios update` self-maintains. Fresh
installs at onboarding already get it.

## Tier 2 (proposed): check-on-launch, notify, one-command apply

Make it *feel* like Claude Code without nagging or auto-mutating a repo the user commits into.

1. **Check on launch (throttled).** On any `aios <cmd>`, at most once per N hours (state in
   `~/.cache/aios/upgrade-check.json`), a **non-blocking, backgrounded** compare of local vs
   remote. Two signals, cheap first:
   - **Version manifest (no network):** the workspace stamp (`.aios-toolkit-version`:
     toolkit semver + `brain-api` contract version) vs the local toolkit's
     `package.json`/`docs/brain-api.md`. This already powers onboarding's `toolkit_stale`
     flag (`onboard-inspect.mjs`) — reuse it.
   - **git rev (network):** `git fetch` in the toolkit + the "N commits behind" count from
     tier 1's `trackingStatus()`.
   Never block the invoked command; never fetch on every call; honor an opt-out
   (`AIOS_NO_UPGRADE_CHECK=1` / `aios.yaml: upgrade_check: false`).
2. **Notify, don't mutate.** A one-line banner when behind:
   `AIOS is 4 commits behind (v0.7 → v0.8). Run 'aios update' to update.` Mirrors Claude
   Code's footer. Print at most once per throttle window; suppress in non-TTY/CI.
3. **One-command apply.** The banner's suggested command *is* tier 1 — nothing new to learn.
   Optional `aios update --yes` for the unattended path.

**Why not auto-apply silently?** Because the toolkit checkout may hold the user's own
uncommitted work, and the workspace holds their committed content. Claude Code can replace an
npm global unattended; AIOS cannot safely mutate a repo the user is actively working in. The
safe default is **notify + explicit apply**; the merge policy that protects local edits stays
in the re-vendor.

### Version manifest (already exists, formalize)

`.aios-toolkit-version` (written by scaffold + every `aios update`) is the manifest:

```
<full-sha>
toolkit-version 0.7.0
brain-api 1.10
synced-at 2026-07-17T…Z
source /Users/…/aios-workspace
```

Tier 2 reads the same fields the check already uses — no new format. A future `--json` on
`aios update --check` gives the GUI/onboarding a machine-readable "behind by / from → to".

## Tier 3: tracking

Linear [AIO-463](https://linear.app/je4light/issue/AIO-463) (team AIO) — this doc is the
design reference; tier 1 ships under it.

## Safety invariants (hardened through three adversarial review rounds)

`aios update`'s self-update flow has been through 6-7 iterations; three review rounds (the
initial `code-review-pr343.md`, then two build-readiness rounds on the follow-up
consolidation) found bugs clustering into recurring root causes — several "fixed" more than
once in different shapes before the underlying mechanism was actually consolidated. What
follows is the current, consolidated design — described in terms of what the code actually
does, not aspirational invariants layered on top of it.

### One immutable pinned snapshot is the coherency mechanism

Every apply run — whether it pulled, was given `--no-pull`, or resolved a freshly-cloned
ephemeral source — ends with `srcDir` (the toolkit checkout) pinned into an **immutable git
worktree snapshot** (`createPinnedSnapshot`, `scripts/toolkit-pull.mjs`) at one specific
commit, created via `git -c core.hooksPath=/dev/null worktree add --detach` (hooks
disabled — this is an internal, disposable read-only checkout, not a workspace a human or
agent is about to work in; without disabling them, this toolkit's own post-checkout hook
would hydrate config and even run `npm run build:loop` on every single `aios update`).
**Everything downstream — the 3-way merge, `gen-catalog`, and the metadata read for the
version stamp — operates only against that frozen snapshot, never the live checkout again.**
This is what makes "the stamped sha matches what was actually vendored" true by
construction: there is no window in which a concurrent mutation to `srcDir` could affect
what gets vendored, because nothing mutable is ever read after the snapshot is taken.

For a real pull, the snapshot is captured **inside `pullToolkitCheckout`'s apply path, after
the fast-forward succeeds but before a `--stash` restore pops the user's stash back** — the
only point in the whole flow guaranteed both current and clean. Capturing it any later (e.g.
back in the caller, after `pullToolkitCheckout` returns) is wrong: the stash-pop already
happens inside that function, so a later capture would see the user's dirty tree again and
refuse every legitimate `--stash` run.

### The vendor step is structurally non-recursive, not recursion-guarded

Earlier designs (both the original conditional re-exec and a first attempt at hardening it
with an env-var loop guard) tried to make a single recursive `cmdUpdate` call safely decide
"have I already handed off." Every version of that idea had a real flaw — up to and
including the fact that a presence-based env-var check (`AIOS_UPDATE_VENDOR_CHILD`) cannot
distinguish "set by my own parent" from "set by anything else already in the environment"
(a leaked debug export, a CI step, ...), so any pre-existing value silently defeated it.

The fix removes the recursion instead of guarding it. `cmdUpdate`'s apply path
unconditionally hands off — spawning the pinned snapshot's own `scripts/aios.mjs` with a
hidden, exact-allowlisted flag, `--vendor-apply-only --from <snapshotDir> --repo <repo>
[--force] [--result-file <path>]` (nothing else is accepted in that combination — enforced
before any read/write). The function that flag dispatches to (`cmdVendorApplyOnly`,
`scripts/update.mjs`) has **no hand-off logic anywhere in it** — it resolves `--from`, runs
the merge, writes the stamp, and returns. It cannot spawn a child because there is no code
path in it that does — not guarded against recursing, structurally incapable of it. There is
no env var, nothing ambient, nothing left to pollute.

`--result-file` exists only because `stdio: "inherit"` (needed for live progress on what can
be a slow operation) means the parent can't read the spawned child's return value any other
way; the child writes its structured result there as JSON, and the parent reads it back for
`changedCount`/`vendorSafety` in its own returned result.

### One remote-state classifier, used identically by check and apply

`acquireRemoteState(dir, { mode })` (`scripts/toolkit-pull.mjs`) is the single owner of "how
does this toolkit checkout relate to its remote," used by both `--check`/`--preview`
(`mode: "readonly"`, `git ls-remote` — zero writes, no `refs/remotes/*`/`FETCH_HEAD`
mutation) and apply (`mode: "apply"`, a real **pruning** fetch — `--prune` is the fix for a
deleted/renamed upstream branch, which a plain fetch would otherwise leave silently trusted
via a stale local tracking ref). It returns one of seven discriminated states — never an
overloaded nullable-count/boolean-verified tuple that two independent call sites could
classify differently:

| State | Meaning | `--check` green? | Apply proceeds? |
|---|---|---|---|
| `no-upstream` | branch never had `@{u}` configured | Yes, if the workspace stamp matches | Yes — nothing to pull |
| `current` | verified: local HEAD === remote ref | Yes | Yes |
| `behind` | verified: remote is ahead | No | Yes — fast-forwards |
| `diverged` | verified: local HEAD has commits the remote doesn't | No | No — hard refuse |
| `missing-upstream-ref` | `@{u}` was configured but the remote no longer has that ref | No, never | Yes — vendors from local state, explicit non-green warning |
| `unreachable` | couldn't reach the remote at all (network/auth) | No, never | Yes — same as above (preserves offline usability) |
| `local-status-error` | the remote query succeeded but a LOCAL git op then failed | No, never | **No — hard refuse** (a local failure is not "acceptable offline") |

`remoteMessage(state)` is the one function producing the human-readable line for each state,
shared by the plain-apply log and the `--check` verdict text.

### Source cleanliness and vendor safety are fail-closed, identical across all three modes

`sourceCleanliness(dir)` is **tri-state** (`"clean" | "dirty" | "inspection-error"`), not
boolean — a `git status` failure must never be conflated with "clean" (the boolean `isDirty`
this replaced did exactly that, via a swallow-to-`false` helper). `vendorSafety(srcRoot)`
(`scripts/update.mjs`) composes an unmerged-index check (`unmergedPaths` — now throws on a
genuine git failure instead of silently reporting zero unmerged paths) with a content scan
for conflict markers across **both** `MANAGED_PATHS` and `SEED_IF_ABSENT` (a marker in a
seed-only source file used to be invisible to any check), requiring the full opener +
divider + closer to be present (not just an isolated `<<<<<<<`, which a doc example could
trigger). Any inspection failure anywhere along the way — a permission-denied subdirectory,
a file disappearing mid-scan — is surfaced as an `errors` entry and treated exactly as
unsafe as a real conflict: **fail-closed, never fail-open.**

Both checks run identically in `--check`, `--preview`, and apply — no mode-specific gating.
`--check`/`--preview` evaluate them directly against the live source (inherently
point-in-time, same honest scope as remote-state classification); apply's authoritative,
TOCTOU-immune evaluation happens inside `cmdVendorApplyOnly`, against the pinned snapshot. A
dirty or uninspectable source is refused outright — even under `--no-pull` — because there
is no coherent sha that could truthfully represent an uncommitted diff.

### The programmatic result contract

`cmdUpdate` returns a structured object for every mode — never a bare exit code, never
`process.exit()` — so a programmatic caller (onboarding, tests) can read
`.applyAllowed`/`.reasons` directly instead of parsing console text or interpreting a `0`/`1`
that can't disambiguate "safe" from "conflicted" from "dirty" from "diverged" (`--check`
intentionally returns `exitStatus: 0` even when non-green, since check mode reports rather
than fails hard). Every *expected* failure (dirty tree, unresolved conflict, bad `--from`, an
unknown/incompatible flag, a non-fast-forward, an uninspectable local repo) throws
`UpdateError` (`scripts/cli-common.mjs`) rather than exiting; `cmdUpdate` is the one place
that catches it and converts it into a printed message plus a non-zero result. A genuinely
unexpected error (anything that isn't `UpdateError`) is deliberately left to propagate to the
CLI dispatcher's own catch-all — it should surface loudly, not be silently absorbed as
"update failed." This is what makes `pullToolkitCheckout`/`cmdUpdate` safely callable
in-process, directly, by both `scripts/onboard-command.mjs` and the test suite — no more
routing error-path assertions through a spawned child just to survive a `process.exit`.

`onboard-command.mjs`'s toolkit-upgrade subsection (`runToolkitUpgrade`) reads exactly this:
if either `--check` or `--preview`'s `applyAllowed` is `false`, the apply confirmation is
never offered — one clear warning built from `.reasons`, and the rest of onboarding
continues regardless (a toolkit-upgrade problem never aborts onboarding wholesale).

### `--contribute` stays mutually exclusive with read-only modes

`--check`/`--preview` cannot combine with `--contribute` (which pushes a branch and can open
a PR) — enforced before `resolveSource` ever runs, so no network/clone side effect happens
first. Preview a contribution with `--contribute <path> --dry-run`.

## Non-goals

- No auto-commit/auto-push of the user's workspace content — ever.
- No second merge policy — self-update reuses the existing 3-way merge.
- No wholesale replace-the-install model — AIOS is a live git repo, not an npm global.
