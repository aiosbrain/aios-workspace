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
aios update --stash      # auto-stash a dirty toolkit tree, pull (or just pin, with --no-pull), then restore it
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
the next run instead of being masked forever). A checkout that predates marker tracking
(node_modules present, no marker recorded) is **seeded, not reinstalled**, when the run's
pull didn't move the lockfile — `npm ci` deletes `node_modules` before installing, so
treating "no marker yet" as "install pending" would destroy a healthy install on the first
post-upgrade run (offline, unrecoverably). Seeding trusts the install only when npm's own
completed-install artifact (`node_modules/.package-lock.json`) is present — an interrupted
`npm ci` never writes it, so a broken pre-marker install is never recorded healthy. When
the artifact is ABSENT, the state is **unverifiable, not broken** — pnpm/yarn/bun and
npm ≤6 never write it, so a healthy non-npm install lands in the same bucket as an
interrupted `npm ci`. The rule is **never destroy what can't be verified**: warn, leave
`node_modules` untouched, record no marker. This holds **unconditionally in the pre-marker
state — including when this run's pull moved the lockfile** (gating it on "the lockfile
didn't move" would make the tolerance last exactly until the first lockfile-moving pull);
only a VERIFIED pre-marker npm install with a moved lockfile falls through to the normal
reinstall, exactly like a recorded-but-mismatched marker. The unverifiable case re-evaluates
every run and self-heals the moment the owner runs `npm ci`. npm is the only
*supported* manager (see the supported source envelope below); other managers' installs
are tolerated, never destructively "repaired". A source with **no lockfile at all**
records a `no-lockfile` sentinel in the marker (not "nothing"); the marker key is
recomputed **from disk after npm returns** — a lockfile-less `npm install` generates
`package-lock.json`, and recording the pre-npm sentinel over it would force a second
destructive reinstall — so a stale marker genuinely converges after one reinstall
instead of re-running `npm install` on every apply forever. Toolkit deps aren't needed for scaffolding or
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
--stamp-source <live-checkout-or-clone-url> [--force] [--result-file <path>]` (nothing else
is accepted in that combination — enforced before any read/write). The separate source
value keeps the disposable snapshot path out of `.aios-toolkit-version`; a local update
records the durable live checkout path, while an ephemeral fallback records its clone URL.
The function that flag dispatches to (`cmdVendorApplyOnly`, `scripts/update.mjs`) has **no
hand-off logic anywhere in it** — it resolves `--from`, runs the merge, writes the stamp,
and returns. It cannot spawn a child because there is no code
path in it that does — not guarded against recursing, structurally incapable of it. There is
no env var, nothing ambient, nothing left to pollute.

`--result-file` exists only because `stdio: "inherit"` (needed for live progress on what can
be a slow operation) means the parent can't read the spawned child's return value any other
way; the child writes its structured result there as JSON, and the parent reads it back for
`changedCount`/`vendorSafety` in its own returned result.

**Cross-version skew.** The child is the *snapshot's* CLI, so the snapshot must understand
the hand-off flags — a snapshot of a toolkit that predates `--vendor-apply-only` would die
on its own flag validation with an opaque "unknown flag". Sources that apply without
fast-forwarding to current `main` (a pinned `--from`/`$AIOS_TOOLKIT_DIR`, an
offline/`no-upstream` checkout) can genuinely be that old, so before spawning, the parent
probes the snapshot's `scripts/update.mjs` for the flag and refuses with an actionable
message ("predates the self-update hand-off protocol — pull that checkout first") instead.
Any future change to the hand-off flag set must extend the probe the same way.

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
| `unreachable` | couldn't reach the remote at all (network/auth), AND the stale local tracking ref **positively** shows no local-only commits | No, never | Yes — same as above (preserves offline usability) |
| `local-status-error` | a LOCAL git op failed — after a successful remote query, **or** while estimating offline divergence (missing tracking ref: local-only commits can't be ruled out) | No, never | **No — hard refuse** (a local failure is not "acceptable offline") |

The offline distinction matters: `--prune` can legitimately delete the local tracking ref
(upstream renamed/removed), and a later offline run then can't count local-only commits at
all. "Couldn't count" is never coerced to "not ahead" — an indeterminate estimate classifies
as `local-status-error`, not `unreachable`, so apply never vendors a checkout whose
divergence can't be ruled out. The same rule holds in **readonly** mode with the remote
*reachable*: when the ls-remote'd sha isn't fetched locally AND the stale estimate itself
fails (tracking ref missing), `--check`/`--preview` classify `local-status-error` rather
than a plain `behind` — previously that fell through to `behind`/`applyAllowed: true`, and
onboarding could offer an apply that the apply-mode fetch would then hard-refuse as
diverged *after* the user confirmed.

### The supported source envelope (normative)

A toolkit source is **supported** only when it is ALL of:

1. **a real git checkout that is its own toplevel** — not an unpacked tarball, not a plain
   copy, not a non-git dir nested inside some other repository;
2. **npm-managed** — `node_modules` produced by npm v7+, with the committed
   `package-lock.json` the toolkit ships. Other package managers are *tolerated* (their
   installs are never destroyed or "repaired") but never managed;
3. reachable at a single stable path (`--from` / `$AIOS_TOOLKIT_DIR` / the running
   checkout / the default clone path).

Everything outside the envelope gets **one honest structural refusal, not handling**. This
is the design's convergence rule: refusals don't breed edge cases the way handling does,
so hardening rounds must shrink toward the envelope boundary instead of chasing the
combinatorial input space beyond it.

The envelope gate lives at **one choke point**: `resolveSource` (`scripts/update.mjs`)
calls `assertGitToolkitSource` on the winning local candidate, so every flow that touches
a source — check/preview/apply, **`--contribute`**, and onboarding — refuses a non-git
copy with the actual diagnosis before any git subprocess can run against it (or, worse,
resolve an **enclosing** repository and stash/fetch/branch/push there).
`pullToolkitCheckout` keeps its own assert as a backstop for direct callers. A refused
winning candidate is never silently skipped in favor of the next candidate — updating
from a different source than the one the user configured would be worse than the refusal.
Because the gate runs in every mode, a structurally-unusable source is an **expected
failure even under `--check`** (structured `mode: "error"`, `exitStatus: 1`) — the one
deliberate exception to check-mode's exit-0 reporting rule below: there is no meaningful
"report" about a directory the tool cannot even interrogate.

Two more local states classify as `local-status-error` rather than slipping through as
`no-upstream`: a **detached HEAD** (`--abbrev-ref HEAD` → literal `"HEAD"` — a paused
rebase/bisect or a checkout pinned at a sha; without the check it would green straight
through and vendor whatever ancient commit is parked there), and **half-configured
tracking** (exactly one of `branch.<b>.remote`/`branch.<b>.merge` set). Both carry a
`detail` field naming the exact problem and the one-command fix, surfaced in the refusal
message and `--check` reasons. The readonly probe (`git ls-remote`) runs with a 30s
timeout so a dropping network can't hang `--check`/`--preview`/onboarding for git's
default transport duration; a timeout lands in the same catch as any unreachable remote.

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
than fails hard — except for a source outside the supported envelope, per the envelope
section above, where there is nothing coherent to report on). `applyAllowed` blocks not
only on the pre-flight signals (remote state,
source cleanliness, vendor safety) but also on a **failed apply itself** — a vendor child
that dies without writing its result file leaves every pre-flight signal green, and
`applyAllowed: true` on that result would lie to any caller reading the contract. The
remote-state gate is an **allowlist** — `REMOTE_APPLY_ALLOW_STATES`
(`current`/`behind`/`no-upstream`/`unreachable`/`missing-upstream-ref`), exported by
`toolkit-pull.mjs` beside the classifier that owns the vocabulary and shared by BOTH
gates that consume it (`buildResult`'s `applyAllowed` and `pullToolkitCheckout`'s
apply-mode refusals, including the self-update nothing-to-pull no-op) — so any state a
future classifier change adds blocks by construction at every gate at once, and the two
files can't drift. Two more fail-closed rules: a result whose safety signals were ALL
never computed reads `applyAllowed: false` for **every** mode, present and future (no
mode list — a mode list would itself be a blocklist; this is why the toolkit-self
`--no-pull` no-op still reports real cleanliness), and a `contribute` result never
advertises apply permission at all (it isn't an apply). Every
*expected* failure (dirty tree, unresolved conflict, bad `--from`, an
unknown/incompatible flag, a non-fast-forward, an uninspectable local repo, a workspace-side
symlinked/escaping managed destination, and every `--contribute` refusal) throws
`UpdateError` (`scripts/cli-common.mjs`) rather than exiting; `cmdUpdate` is the one place
that catches it and converts it into a printed message plus a non-zero result. Managed-write
containment (`assertDestPathSafe`) additionally runs as a **pre-flight scan over the
complete write+delete set before the first write** — `plannedDestRels` enumerates every
destination the apply could touch (managed + seed writes, the `.aios-incoming`/
`.aios-merge` conflict sidecars, and upstream-deletion targets) via the same helpers the
write loop itself calls (`entryFiles`, `deletionCandidates`), so the scanned set and the
touched set cannot drift, and one bad destination refuses the whole apply all-or-nothing
instead of dying mid-loop over a half-vendored workspace. On the
apply side, ONE `finally` owns the pinned snapshot's entire lifetime — every exit path
(refusal, plain system error, normal return) removes the snapshot worktree, so no new exit
can reintroduce the leak class of hand-placed cleanup calls. A genuinely
unexpected error (anything that isn't `UpdateError`) is deliberately left to propagate to the
CLI dispatcher's own catch-all — it should surface loudly, not be silently absorbed as
"update failed." This is what makes `pullToolkitCheckout`/`cmdUpdate` safely callable
in-process, directly, by both `scripts/onboard-command.mjs` and the test suite — no more
routing error-path assertions through a spawned child just to survive a `process.exit`.

`onboard-command.mjs`'s toolkit-upgrade subsection (`runToolkitUpgrade`) reads exactly this:
if `--preview`'s `applyAllowed` is `false`, the apply confirmation is never offered — one
clear warning built from `.reasons`, and the rest of onboarding continues regardless (a
toolkit-upgrade problem never aborts onboarding wholesale). Preview alone gates the offer:
`applyAllowed` is derived identically in `--check` and `--preview`, so a leading `--check`
call was pure duplication (a second `ls-remote` round-trip + a second vendor-safety scan
for the same answer) and was dropped. The confirmed apply is **pinned to exactly what was
previewed**: it passes `--no-pull` (the preview classified the checkout's current HEAD, so
the apply must not fast-forward past it) plus `--expect-src-head <previewed sha>` (every
result carries `.srcHead`; a source that moved between the two steps is refused with a
re-preview message). The pin's contract is binary — enforced or refused, never
accepted-and-ignored: `--expect-src-head` REQUIRES `--no-pull` (a pull is by definition
moving past the pinned state) and is refused outright with `--check`/`--preview`/`--dry-run`
(read-only modes apply nothing to pin) — both as incompatible-flag expected failures, on
every branch including the toolkit-self one. Consent binds to the merge report the user
actually saw — never to
whatever the source happens to contain by apply time; a toolkit whose remote has newer
commits gets a "run `aios update` afterward" note instead of a silent bigger apply.

Two more honesty rules on the apply side: run **inside the toolkit checkout itself**
(self-update), a tree with WIP — **uncommitted changes OR committed local-only commits**
(ahead-only "diverged", behind 0) — is a **no-op success** when there is nothing to pull:
nothing is ever vendored, so WIP gates nothing and no snapshot is pinned. The committed
state is strictly safer than the uncommitted one and must never fare worse. A checkout that
is diverged AND behind still refuses (a fast-forward is genuinely impossible), an
uninspectable repo (`local-status-error`) stays fail-closed, and only a real pull demands a
clean tree or `--stash`. And a **failed `gen-catalog`** leaves the version
stamp **unwritten** (same model as merge conflicts — the failure lands in `.reasons`, the
stamp stays at the old base, and `--check` keeps reporting the workspace behind until a
re-run succeeds); its three fixed destinations are containment-checked at the same
chokepoint as every other managed write.

### `--contribute` stays mutually exclusive with read-only modes

`--check`/`--preview` cannot combine with `--contribute` (which pushes a branch and can open
a PR) — enforced before `resolveSource` ever runs, so no network/clone side effect happens
first. Preview a contribution with `--contribute <path> --dry-run`.

## Non-goals

- No auto-commit/auto-push of the user's workspace content — ever.
- No second merge policy — self-update reuses the existing 3-way merge.
- No wholesale replace-the-install model — AIOS is a live git repo, not an npm global.
