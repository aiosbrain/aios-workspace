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
aios update --no-pull    # skip the git pull + npm ci; only re-vendor governance (the old behavior)
aios update --stash      # auto-stash a dirty toolkit tree, pull, then restore it
aios update --no-install # skip npm ci even if the toolkit lockfile changed
aios update --from DIR   # use a specific toolkit checkout as the source
aios update --force      # take the toolkit version for every managed file
aios update --contribute <path>  # upstream a locally-improved managed file as a toolkit PR
```

Flow: (1) **git half** (`toolkit-pull.mjs`) — `git fetch` the toolkit and report
**"N commits behind"**, fast-forward the tracked branch (**refuse a dirty tree** unless
`--stash`; **refuse a non-fast-forward** and tell the user to reconcile by hand — never
clobber, never auto-merge someone's checkout), then `npm ci` **only when the toolkit already
has `node_modules`** (the owner uses the GUI/tests) **and** the pull moved
`package-lock.json`. Toolkit deps aren't needed for scaffolding or `aios` sync, so a
sync-only tester never eats a surprise install. Skipped for a freshly-cloned source (already
latest) or with `--no-pull`. (2) **vendor half** (`update.mjs` / `toolkit-merge.mjs`) — the
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

## Safety invariants (hardened through adversarial review)

- **`--check` is truly read-only w.r.t. the toolkit repo.** It reads the remote via
  `git ls-remote` (no `git fetch`, so no `refs/remotes/*` or `FETCH_HEAD` writes). When the
  remote object isn't local it reports "differs (behind)" without an exact count rather than
  fetching. An **unreachable remote never reads green** — a stale local tracking ref that
  happens to say 0 is reported as "unverified (offline?)", not "up to date".
- **`npm ci` never runs through a symlinked `node_modules`.** A git worktree symlinks it to the
  primary checkout's shared install; `npm ci` deletes `node_modules`, so following the symlink
  would erase the shared target. Detected with `lstat` and skipped.
- **An interrupted install self-heals.** The lockfile hash of the last successful install is
  recorded under the git common dir; deps are reconciled on every apply run (even `behind === 0`),
  so a pull that landed before `npm ci` ran is repaired next time instead of masked forever.
- **The vendor phase always runs code matching the source at its current HEAD, by construction.**
  Two review rounds each found a new race in *conditionally deciding* whether to hand off based on
  comparing independently-sampled HEAD reads — every fix patched one more read site instead of
  removing the need to compare reads at all. So the apply path never vendors in-process: it always
  hands off (re-exec `--no-pull`) to the source's own freshly-started CLI, which by construction
  reads its own files fresh. `cmdUpdate` is recursive (the spawned child re-invokes it); an
  internal env marker set only on that child (never a CLI flag) is the base case that stops it
  looping, not a HEAD comparison.
- **A conflicted toolkit is never vendored.** Two signals, both in the parent (before any
  hand-off) and independent of `--no-pull`/`--force`: an unmerged index AND a content scan of the
  managed source files (catches a `git add`-ed or hand-authored `<<<<<<<` marker).
- **`--check`/`--preview` cannot combine with `--contribute`** (which pushes a branch / opens a
  PR). Preview a contribution with `--contribute <path> --dry-run`.

## Non-goals

- No auto-commit/auto-push of the user's workspace content — ever.
- No second merge policy — self-update reuses the existing 3-way merge.
- No wholesale replace-the-install model — AIOS is a live git repo, not an npm global.
