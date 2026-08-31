# Changelog

All notable changes to the AIOS Workspace are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/); dates are
ISO-8601.

This is the **individual workspace** repo. The Team Brain sync contract
(`docs/brain-api.md`) is versioned separately; it is currently at **v1.22**
(additive within major `v1`). Entries predating a bump did not change the protocol.

## Unreleased

### Added

- **Packaged-artifact acceptance lane (AIO-1071).** The packed candidate — not a checkout — is now
  the release authority: one pack job emits the tarball + SHA-256 + inventory + provenance tuple,
  and six OS/Node cells (Linux/macOS × Node 22/24/26, `.github/workflows/package-acceptance.yml`)
  install that exact digest into empty-HOME, allowlisted, engine-strict environments and drive
  fresh-install, configured-use, mocked Linear/Slack, migration-interruption/repeat,
  registry-0.12.0 upgrade (stage-and-verify) and rollback journeys, plus nine fault-injection
  negative controls and a secret-sentinel evidence scan. Local single-cell equivalent:
  `npm run test:package-acceptance`. Live provider smokes stay operator-gated outside CI.

- **Portable CLI runtime foundation (AIO-1066).** The canonical `aios` bin now starts through a
  dependency-light bootstrap and loads legacy handlers only after registry selection. Ordinary
  registry-owned `help`, `version`, `doctor`, and `provenance` diagnostics remain usable with
  missing or invalid config and broken adapters. The foundation adds versioned user config,
  complete-root credential selection, destination/redirect trust, stable errors and output,
  symlink-safe atomic writes, and resumable byte-stable migration/rollback primitives.

### Changed

- Root and foundation runtime support is explicit at `22.x || 24.x || 26.x`; packed installation
  and diagnostic/config/migration smoke now run with engine-strict and an explicit environment
  allowlist across all three majors. The exact devtools pin will advance only after its separately
  gated compatibility release is published.

## [0.12.0] — 2026-08-21

**Minor release, and the licence changes.** AIOS Workspace is now **AGPL-3.0-only** (it was MIT
through `0.11.1`), with an Apache-2.0 carve-out for the vendored `.harness/`. If you depend on this
package, read that first — it is the one change in this release that can affect how you are allowed
to use it. `@aiosbrain/foundation` moves to `0.1.2` in two steps for the same
reason: `0.1.0` was published to npm under MIT and npm versions are immutable, so the relicensed
manifest needed a version of its own (`0.1.1`, published 2026-08-21), and the credential-resolution
fix below changed `brain-config.mjs` after that publish, so it needs one too.

Three shipped defects are fixed here that only a *published install* could see, which is the theme
of this release: `slack` and `linear` on your `PATH` could not run at all, `aios spec eval` could
not find its rubric, and a workspace's dotenvx-encrypted `.env` could not be decrypted without a
global `dotenvx`. All were invisible to a repo-only test suite, and the release now has a gate that
makes that class of bug visible.

### Changed

- **Licence: MIT → AGPL-3.0-only (RELIC-1).** The vendored `.harness/` directory stays Apache-2.0 as
  an explicit carve-out, and `LICENSE` is now in a form GitHub detects and displays.
- **Brain API contract: v1.20 → v1.22.** v1.21 adds `in_review` to the canonical task status set
  (between `in_progress` and `done`) — a row a pre-1.21 client read as `in_progress` may now arrive
  as `in_review`. v1.22 makes coverage arrive with its denominator, so a coverage figure can no
  longer be reported without the total it is a fraction of.

### Fixed

- **`slack` and `linear` on your `PATH` now run.** Both bins were tracked `100644` and shipped that
  way in the `0.11.1` tarball, so invoking either by name returned `permission denied`; only
  `scripts/aios.mjs` carried the exec bit. Invoking the same files through an interpreter always
  worked, which is why the defect survived so long. All three bin targets are now `100755` and the
  packed tarball is asserted to contain them that way.
- **`aios spec eval` finds its rubric on a published install (AIO-686, AIO-976).** The fallback path
  was module-relative and outlived the devtools repo split: it resolved into the sibling
  `@aiosbrain/aios-devtools` package, which ships no rubric. Resolution now goes through the
  sanctioned toolkit seam, lazily, so explicit `--rubric` and a repo-local rubric still take
  precedence and neither invokes the locator. Requires `@aiosbrain/aios-devtools@0.3.0`, which this
  release pins exactly.
- **`slack file` uploads no longer interpolate a filename into a header.** The upload path uses
  Slack's documented external flow with a raw `application/octet-stream` body, which removes the
  `Content-Disposition` injection surface rather than sanitizing it, and refuses any upload URL that
  is not `https` (or loopback `http`). Path arguments are opened under workspace containment with
  `O_NOFOLLOW` + `dir_fd`, so a symlink cannot redirect a read outside the workspace.
- **Secret ignores cover every `.env.keys`-derived file**, not only the exact name.
- **`LINEAR_API_KEY` survives a failing sibling dotenvx key (AIO-790).**
- **The brain-URL guard stops warning about differences that are not differences.**
- **Cursor hooks dispatch from the payload `cwd`.**
- **A fresh scaffold no longer ships a sample task row** that lands on a real PM board, and two
  client identifiers are removed from shipped skill docs.
- **The documented Linear invocation is one that can authenticate (AIO-1027).** The skill docs named
  `scripts/linear.mjs`, which is not vendored into scaffolded workspaces, so the documented command
  failed `MODULE_NOT_FOUND`. The first correction moved everything to
  `.claude/skills/aios-linear/linear.mjs`, which *is* vendored but performs no credential resolution
  at all — it worked only where `LINEAR_API_KEY` was already exported. Both are fixed: `linear <cmd>`
  (the PATH bin, which resolves the key) is the documented invocation, the skill path is an explicit
  fallback, and the missing-key error no longer tells the reader to re-run the command that just
  failed.
- **A published install can decrypt a workspace `.env` without direnv or a global `dotenvx`
  (AIO-1029).** `@dotenvx/dotenvx` shipped as a devDependency, so the tarball carried no copy and
  credential resolution fell back to a `dotenvx` on PATH that a member's machine may not have —
  `linear` and `slack` then failed "key not set" with the key sitting encrypted next to a valid
  `.env.keys`. It is now a runtime dependency, resolved with Node module resolution (the fixed
  `node_modules/.bin` path never worked in a hoisted local install), and `@aiosbrain/foundation`
  declares it as an optional peer for standalone consumers. The packed-artifact gate now asserts
  decryption from the installed tree with `dotenvx` stripped from PATH.
- **Worktree hydration never overwrites a branch's tracked `.claude/settings.json` (AIO-920).**
- **The write-time secret guard flags provider-shaped values under any binding name (AIO-952).**
- **The mutation-testing capability oracle is restored, closing a shotgun bypass (AIO-994, AIO-534).**

### Added

- **A connector routing guard (`hooks/connector-routing-guard.mjs`), enabled by default.** Generic
  Linear MCP calls that are *provably* AIOS-targeted — an `AIO-<n>` identifier or a configured team
  marker in a structured team field — are blocked with a message naming the AIOS CLI to use instead.
  Ambiguous and customer Linear work is never blocked. Bash commands are **advised, never blocked**:
  a shell string cannot be soundly classified (every language on the machine is an HTTP client), so
  the guard does not pretend otherwise. Configure via `.aios/connector-routing.json` with
  `mode: "block" | "warn" | "off"`. This enforces Claude Code only — there is no Codex or OpenCode
  parity claim.
- **A packed-artifact golden-path gate (`test/npm-pack-golden-path.test.mjs`).** It packs the
  tarball, installs it into a clean prefix, and asserts what users actually receive: bin file modes,
  every bin runnable by bare name, the Slack verb surface including `file` and `resolve`, the exact
  devtools pin, and a rubric-less `spec eval`. **All three defects fixed above would have been
  caught by this test**, and none were caught by the repo suite.
- **`slack resolve --member`** — read-only member lookup, so a recipient can be resolved without a
  live send probe.
- **`aios-linear` can create and list projects**, and set project and priority at creation
  (AIO-942); it also catches the descriptions Linear silently corrupts.
- **A claim-check guard and the `check-claim` skill** — surfaces unverified "it works" claims.
- **Scaffolded workspaces ship the validators their own rules cite (AIO-965).**
- **A byte-parity CI gate for the two canonical `aios-linear` skill copies (AIO-927)** — the repo
  keeps a dev-facing copy and a scaffold copy, and nothing previously made editing one imply editing
  the other.
- **`linear` gains a finding template and label-filtered listing (AIO-999).**
- **`npm run guard:selftest`** — one command to prove the write-time secret guard is live (AIO-953).

### Upgrading

`npm i -g @aiosbrain/aios@0.12.0`. No migration steps. If you have a workspace scaffolded from an
earlier release, `aios update` brings the hook and validators across; the routing guard arrives
enabled, and `mode: "off"` in `.aios/connector-routing.json` disables it.

## [0.11.1] — 2026-08-17

**Patch release. Install it if you installed `0.11.0`.** A clean-container test of the *published*
`0.11.0` artifact — not the checkout, the tarball users actually get — found a defect worse than
the one `0.11.0` was cut to fix.

**On any machine without `jq`, the shipped write-time secret guard returned "allow" instead of
blocking, and said nothing.** `hooks/team-ops-guard.sh` used `jq` to read the tool payload, but
`jq` was never declared as a runtime dependency and every `jq` call was wrapped
`2>/dev/null || true`. So `set -euo pipefail` never saw the missing binary, `TOOL_INPUT` came back
empty, and the script fell through to its final `exit 0 # allow`. An AWS key was written straight
through the guard in the sandbox at **exit 0, with no stdout and no stderr** — the guard did not
fail loudly, it failed silently, which is the part that matters. The same silence covered
access-tier enforcement and frontmatter enforcement, which run through the same hook.

The bug hid from everyone who could have caught it: macOS ships `/usr/bin/jq` and GitHub's
`ubuntu-latest` pre-installs it, so the dev machine, CI and the release gate all agreed the guard
worked. That is the same shape as the `OGR09` and `ajv` defects `0.11.0` fixed — a dependency that
is ambient everywhere it was tested and absent where it ships.

### Fixed

- **The secret guard no longer needs `jq`, and can no longer fail open silently (AIO-864).**
  Payload extraction now tries `jq`, then falls back to `node` — not an assumption, since `node`
  runs the toolkit, Claude Code itself, and the sibling `PreToolUse` hook registered in the same
  `settings.json` array. `jq` is still preferred when present (a cheaper process on a per-write
  hook). A parse *failure* is now distinguished from an absent field, and **no verdict fails
  CLOSED** (`exit 2`) with a named `AIOS_GUARD_NO_JSON_PARSER` diagnostic that names `jq` as the
  cause. `AIOS_GUARD_ALLOW_UNPARSED=1` restores the permissive behavior, but shouts on every
  invocation — silence is not reachable in any branch. Regression coverage runs the *shipped* hook
  under a `PATH` stripped to curated symlinks with `jq` and/or `node` removed (7 of its 9 cases
  fail on the pre-fix hook), plus a new clean-container CI lane that installs the packed tarball
  into a bare `node:22` image and asserts the guard blocks a secret both with and without `jq`.
- **The install docs no longer pin a release that rots.** `GETTING-STARTED.md` and `README.md` told
  new users, in bold, to clone **`v0.10.0`** — the release whose validators fail on a clean install,
  which is exactly what `0.11.0` existed to fix. Both now resolve the newest tag at clone time with
  `git ls-remote --sort=-v:refname`, so the instructions cannot point at a stale release again.
  Prerequisites now document `jq` (and the `node` fallback) and the npm-install-before-validating
  caveat.
- **The brain-api revision claim in the `0.11.0` notes below.** That section said the contract moved
  "v1.15 → v1.17"; the header of this file and `docs/brain-api.md` both said **1.20**, and 1.20 is
  what the `v0.11.0` tag contains. The `0.11.0` paragraph is corrected in place, including the fact
  that v1.20 is the one step in that range that is not a pure superset.

### Added

- **`aios validate`** — runs the toolkit's validators against a workspace. A scaffolded workspace's
  own `validation/` holds only `secret-patterns.txt`, so `validation/validate-all.sh .` cannot work
  there, and a global install previously had to know the path
  `/usr/local/lib/node_modules/@aiosbrain/aios/validation/`. `aios validate <path>` works from
  anywhere, including outside a workspace, and so does `aios validate --help` — asking a command
  how to use it must never depend on standing in a workspace. It execs `validate-all.sh` through
  its own shebang rather than spawning `bash` by name, so a writable `PATH` entry cannot choose the
  shell that runs the security validators.

**Public CLI command inventory: 53 → 54.**

## [0.11.0] — 2026-08-17

**This release supersedes `0.10.1`, which was never tagged and never published.** A `0.10.1`
version string reached `package.json` and a changelog heading, but no npm artifact and no git tag
ever existed for it — so the `0.10.1` install and the `0.10.1` checkout its notes pointed at were
never runnable. Everything that section described ships here instead. `0.10.0` is the previous
installable release, and this is the upgrade from it.

**The headline fix is that a fresh global install can now complete its own documented validation
step.** In `0.10.0`, `validation/validate-all.sh` ran `OGR09 — Skill Library`, which reads
`gui/server/skill-library/`. That path was never in `package.json`'s `files` array, so the
validator that the install instructions tell you to run exited `ENOENT` on every clean
`npm i -g @aiosbrain/aios`. OGR09 now lives in `aiosbrain/aios-workspace-gui` with the tree it
actually owns, and the core validator suite no longer reaches outside the published tarball.

A second instance of that same shape was found while cutting this release and fixed here too:
`ajv` was a **devDependency**, but OGR15 (`validation/check-delivery-skill-suite.mjs`) imports it
at module scope and ships in the tarball. A global install resolves only `dependencies`, so the
validator suite still died — on a different validator, with a different error. `ajv` is now a
runtime dependency, and a packaging test asserts that **no** shipped module imports a
devDependency, so there is no third instance.

The Team Brain API document revision moves **v1.15 → v1.20** across this release — this paragraph
said "v1.15 → v1.17" until `0.11.1`, having been written before the last two contract PRs landed
in the same tag, and the header of this file and `docs/brain-api.md` both already said 1.20. Five
steps, four of them additive within major `v1`:

- **v1.16** documented the already-shipped authenticated `GET /api/v1/attribution` and
  `GET /api/v1/timeline` reads.
- **v1.17** accepts the backward-compatible v2 shape of `metrics.codebase_health`.
- **v1.18** and **v1.19** are BACKFILLED: delegated agent tokens (`aiosd_*`) on
  `GET /api/v1/items`, then on `POST /api/v1/query`. Both had already shipped in `aios-team-brain`
  without landing in the contract first, so the canonical and vendored copies of the pinned
  fixture had silently diverged at 1.17 vs 1.19. Recorded rather than skipped. Member `aios_*`
  keys are byte-for-byte unchanged by both.
- **v1.20** makes the `POST /api/v1/items` payload limits explicit: `rows` bounded at 5,000 per
  payload, the transport ceiling raised 1.2 MB → 5.4 MB, `body` unchanged at 1 MB.

**v1.20 is the one step that is not a pure superset.** A payload above 5,000 rows that was compact
enough (~60–130 B/row) to fit under the old 1.2 MB gate was accepted before and now returns
`422 invalid_payload`. That window is narrow and every realistic client gets strictly more room,
but it is a behavior change rather than a documentation-only one, so it is called out here instead
of being folded into an "additive, nobody has to move" summary. No route's runtime or wire behavior
changed in v1.16–v1.19.

### Added

- **Per-PR review-evidence gate (AIO-777)** — a PR is mergeable only while a write-access
  reviewer's attestation names its **current** head SHA; a push makes prior evidence stale and
  the `review-evidence` commit status goes red until the new head is re-reviewed. Exemptions are
  a `REVIEW_EXEMPT` comment naming the same head, so an exemption cannot go stale either. The
  body validator is a
  recorded copy of the hub's release-gate validator. Scope is deliberate and narrow: it answers
  "has anything reviewed this exact commit?", not "is that review honest?" — every write-access
  actor is trusted. See `docs/pr-review-evidence.md`.
- **Code Maintenance Loop Phase 0 (AIO-610)** — codebase-health v2 distinguishes the observed
  score from evidence completeness and automation admission, loads per-repository capability
  profiles, and emits stable redacted findings for Team Brain. Missing, stale, or errored required
  evidence now produces an `unknown` gate and can never admit background remediation.
- **v1 integration contract artifacts (AIO-835)** — `packages/integration-sdk/contracts/v1/`
  ships the versioned integration contract, its JSON schemas, and the evidence fixtures that pin
  it. The validator rejects single-label provider hosts, repeated DNS root dots, and
  `mutation_class` values outside the capability taxonomy, and distinguishes an unknown
  capability from a declared extension rather than silently accepting either.
- **`aios --version` / `aios -v`** now print the installed package version instead of the usage
  banner. Previously neither flag matched a command, so the CLI fell through to help text and
  there was no way to ask an installed CLI what version it was.
- **Global connector install and Slack multiline preservation** — connectors install globally
  rather than per-workspace, and the `slack-personal` connector stops collapsing multiline
  message bodies into a single line.
- **Runtime-agnostic reviewer presets for adversarial-review steps** — `loop-models` presets are
  no longer tied to one agent runtime.
- `aios analyze --json` exposes typed `chat`, `command`, `edit`, and `doc` actions for every
  maturity axis, plus the exact blockers to the next maturity spine level when the workspace is
  below L5 (AIO-706).
- The maturity capture hook accepts `AIOS_MATURITY_TRANSCRIPT_MAX_MB`. Its safe default is now
  50 MB instead of 10 MB so high-activity sessions are not silently omitted; invalid overrides
  fall back to the default (#550).
- Scaffolded workspaces get the Linear factory harness, gated on `pm_tool` so it is only wired
  up where Linear is actually the configured tracker (AIO-844).
- The `evolve` skill ships into scaffold, so every newly scaffolded workspace gets it
  (AIO-741).

### Changed

- **BREAKING — `gui/` and `src-tauri/` are deleted from this repo.** Authority for the Workspace
  GUI and the Tauri shell moved to `aiosbrain/aios-workspace-gui`. Neither directory was ever
  part of the `@aiosbrain/aios` tarball, so a CLI install is unaffected; this changes what a
  **source checkout or fork** contains. See the migration note below.
- **BREAKING — core no longer owns or runs the Skill Library writer or OGR09.** `validate-all.sh`
  now runs **14** validators instead of 15 (OGR01–OGR08 and OGR10–OGR15). The writer
  (`scripts/lock-skill-library.mjs`) and the validator (`validation/check-skill-library.mjs`) are
  removed. The equivalent gate runs in `aiosbrain/aios-workspace-gui` CI against the vendored
  library it owns. The separate marketplace catalog writer remains in core and now fails closed
  when its catalog is absent (AIO-612).
- **`engines.node` is now `>=22`, with the upper bound dropped.** `0.10.0` declared
  `>=22 <23`, which made `npm i -g @aiosbrain/aios` warn or fail on Node 23+ for no reason the
  code required. CI now proves the supported range rather than asserting it (AIO-628).
- Codex maturity analysis recognizes current custom-tool events and delegated child sessions,
  attributes them to their human-root session, and counts only shell-backed execution wrappers as
  verification. The analysis cache schema moves to v2, so the first run reparses stale v1 cache
  entries (AIO-722).
- Brain reporting in CI is **opt-in** rather than on by default (AIO-809).
- Every CI job carries an explicit timeout, so a hung job fails in minutes instead of hours.

### Fixed

- A scaffolded workspace's CLI shim now resolves its `aios-workspace` checkout with no setup.
  It reads the `source` line the scaffolder already writes into `.aios-toolkit-version` (and
  every `aios update` rewrites), consulted after `AIOS_TOOLKIT_DIR` and the deprecated
  `AIOS_TOOLKIT_CLI` entrypoint and before the legacy relative-directory guesses. Previously the
  shim resolved only when someone exported an env var or their layout happened to match one of
  three hardcoded sibling paths — which the documented clone directory did not. Existing
  workspaces already carry the required stamp, so they need one managed-file `aios update`, not a
  re-scaffold. An old shim that cannot find its checkout needs a one-time bootstrap through the
  global/toolkit CLI, a recognized sibling layout, or `AIOS_TOOLKIT_DIR`; after the update, the
  stamp removes that layout requirement. `AIOS_TOOLKIT_DIR` is unchanged and still wins, and is
  still how the GUI is pointed at a checkout (AIO-814). A follow-up made the resolution one seam
  contract shared across the repo split rather than a per-caller guess (AIO-663).
- **Cursor multi-root sessions no longer have every tool call denied.** The fail-closed hook
  configuration misfired when a Cursor workspace had more than one root folder, so the guard
  denied everything instead of only what it was scoping out (AIO-864).
- **The worktree guard is scoped to the repo that vendors it**, so it stops firing on unrelated
  sibling repositories in a multi-repo session (AIO-858).
- **Scaffolded workspaces no longer receive the cross-repo Cursor guard.** That guard is a
  toolkit-development control and was never meant to govern an individual contributor's own
  workspace (AIO-864).
- Harness hooks allow commands to run in a checkout that has no vendored harness, instead of
  blocking them outright (AIO-864).
- Transcript ingestion normalizes the `private` audience alias instead of hard-failing the whole
  batch on it.
- Optional coverage dependency installation is now genuinely fail-open: an `npm ci`
  failure cannot prevent the repository or a newly scaffolded consumer from reaching its Brain
  scan. Regression guards enforce the behavior in both workflow copies (AIO-697).
- Explicit-only skills now reject malformed `$skill-id-suffix` and `/skill-id-suffix`
  invocations instead of letting a word-boundary match bypass semantic-routing restrictions
  (AIO-695).
- Explicit skill routing now ignores URL, filesystem-path, and embedded-token sigil substrings
  while preserving real `$skill` and `/skill` invocations (AIO-741).
- Root and merge coverage paths treated `gui/client/package.json` as ownership of the client
  suite and ran it with `npm --prefix gui/client`, keeping client coverage alive through npm
  workspace deregistration until the source was removed (AIO-742). The CI coverage artifact is
  now the sole scanner input (AIO-729).
- The public-secret gate classifies a narrow set of committed dummy fixtures without suppressing
  nearby opaque credentials, and forces text-mode scanning so a tracked NUL byte cannot hide a
  later finding (AIO-726).
- Secret-scan failures still identify the rule, relative file, and exact line number, but replace
  the matched source line with `[REDACTED]` before findings are written or printed. Exit behavior
  remains fail-closed (AIO-743).
- **`ajv` moved from `devDependencies` to `dependencies`.** OGR15's
  `validation/check-delivery-skill-suite.mjs` and `scripts/integration-contracts/fixtures.mjs`
  both ship in the npm tarball and import `ajv` at module scope, but a global install resolves
  only runtime dependencies — so both crashed with `ERR_MODULE_NOT_FOUND` outside a dev checkout.
  A new packaging test walks every `.mjs`/`.cjs`/`.js` file `npm pack` would ship and fails if any
  of them imports a devDependency.
- Debt patrol resolves its target before scoring it, instead of scoring an unresolved reference
  (AIO-787).
- The installer persists the personal agent workspace rather than dropping it on reinstall.
- Worktree creation restores incomplete shared dependencies instead of leaving a half-linked
  tree (AIO-765).
- Toolkit commit/push policy is never injected into a scaffolded workspace by the worktree
  tooling.
- The `aios-linear` skill supports exact relation removal, and its diverged copies were
  consolidated into one (AIO-810).

### Repository-only changes and package boundary

- The `evolve` skill audits actual local skill reads, routing evidence, and catalog parity with
  prompt text omitted by default. When an operator opts into excerpts, secret-bearing assignments
  are redacted in full, including short, punctuated, whitespace-containing, and URL values
  (AIO-741).
- Root `.github/` workflows, `.harness/`, `.cursor/`, and regression tests remain source-only.
  The npm tarball ships `scripts/`, `hooks/`, `validation/`, `dist/`, `packages/foundation/src`,
  the managed `scaffold/` tree, `CHANGELOG.md`, and the pinned Brain contract documents. The
  routing, analysis, capture, validation, scaffold, connector, and `--version` changes above are
  therefore inside the published package boundary; the `evolve` audit half of AIO-741, the
  integration-contract fixtures, and the harness/Cursor guard fixes are source-only.

### Breaking, migration, and rollback

- Upgrade the CLI and the template used for newly scaffolded workspaces with
  `npm install -g @aiosbrain/aios@0.11.0`. There is no configuration, stored-data, or Brain API
  migration from `0.10.0`. The optional transcript-size environment variable needs no action.
- **Node version:** the `<23` upper bound is gone. Node 22 and newer are supported. If you pinned
  an older Node to work around the previous bound, you can unpin it.
- **GUI relocation:** if you consumed `gui/` or `src-tauri/` from a **source checkout** of this
  repo, clone `aiosbrain/aios-workspace-gui` and build from there. Point it at a toolkit checkout
  with `AIOS_TOOLKIT_DIR`, which is unchanged. A global `@aiosbrain/aios` install never contained
  these directories, so CLI users have nothing to do.
- **Validation ownership change:** `validation/validate-all.sh` no longer runs OGR09 and now runs
  14 validators. Consumers that vendor or operate the GUI Skill Library must run its integrity
  gate from `aiosbrain/aios-workspace-gui`; treating the core validator as an OGR09 substitute is
  no longer supported. This is also what makes `validate-all.sh` pass on a clean global install
  for the first time.
- A global install does not rewrite the managed workflow already copied into an existing
  workspace. To apply the scaffold workflow fix there, use the explicit managed-file update below.
- To apply the fix to an existing workspace, check out Workspace `v0.11.0`, then run
  `aios update --from <path-to-v0.11.0-checkout> --no-pull` from that workspace. Review and
  commit the resulting managed-file update normally.
- To roll back the copied workflow, repeat that update from a Workspace `v0.10.0` checkout;
  reinstall `@aiosbrain/aios@0.10.0` as well if the CLI must also be rolled back. The `0.10.0`
  line retains the devtools extraction, preflight, and migration docs. Note that rolling the CLI
  back to `0.10.0` restores the `ENOENT` on `validation/validate-all.sh` described above.

## [0.10.0] — 2026-08-03

The standalone Workspace release completes the devtools extraction and makes the
published CLI the supported installation boundary. The Team Brain API contract is
unchanged at **v1.15**.

### Added

- **One-click Team Brain Create path (AIO-445)** — `aios onboard` explains the Railway app +
  Postgres deployment and cost boundary, stops for approval before opening the official template,
  and can resume directly into Join when deployment is ready.
- **Devtools migration preflight (AIO-665)** — `npm run check:devtools` resolves every delegated
  command, reports whether it came from the pinned package or `AIOS_DEVTOOLS_DIR`, and fails with
  actionable installation and rollback guidance when the package is unavailable.
- **Brain-reporting scaffold CI** — newly scaffolded workspaces include the protected-main scan
  workflow and report real codebase-health and coverage evidence instead of silently treating
  missing coverage as zero.
- **`aios-deck` skill** — a reusable, brand-themeable deck builder with a visual QA gate.

### Changed

- The pinned onboarding orchestration contract is v3. Create now uses the stable
  `https://aiosbrain.dev/deploy/team-brain/` front door, then reuses Join's canonical-origin human
  gate and `GET /api/v1/me` proof. No Brain origin or API key is persisted before validation, and
  onboarding still never pushes workspace content.
- **Devtools ownership moved out of core (AIO-661/AIO-662)** — `ship`, `build`, `roadmap-run`,
  `spec`, and `consolidate-findings` now dispatch to exactly pinned
  `@aiosbrain/aios-devtools@0.2.0`; their former in-tree implementations and tests were removed.
  The dispatch seam remains fail-open for unrelated core commands and fail-closed with an
  actionable diagnostic for each delegated command.
- The scan-on-merge workflow and its scaffold source now use immutable Action and scanner SHAs,
  exact hash-locked dependencies, lifecycle scripts disabled during installation, and narrowly
  scoped Brain credentials. It runs only after a push to protected `main`.

### Fixed

- Coverage production now writes its artifact even when a test suite fails; GUI coverage is
  optional and no longer collides with the core report key.
- SR18 scope-fence evaluation now distinguishes a per-file “leave unchanged” instruction from a
  blanket scope freeze, carries Scope semantics into nested headings, and exits them at the correct
  sibling level. Devtools CI is pinned to the reviewed current-core implementation.
- Daily operator-loop items reject malformed due dates instead of accepting invalid calendar text.

### Migration (0.9.x → 0.10.0)

- Global installs: `npm install -g @aiosbrain/aios@0.10.0`, then run
  `npm run check:devtools` from a toolkit checkout when validating the delegated command package.
- Adjacent devtools development: export `AIOS_DEVTOOLS_DIR=/path/to/aios-devtools`; the preflight
  names that source explicitly. Remove the variable to return to the pinned npm dependency.
- Rollback: install `@aiosbrain/aios@0.9.1`, whose tarball still contains the in-tree devtools
  implementations. The complete procedure is in `docs/devtools-migration.md`.

## [0.9.1] — 2026-08-01

The CLI becomes an independently installable npm package (AIO-668). Nothing in
the sync protocol changes — brain-api stays at **v1.15**. The patch bump exists
because v0.9.0 was tagged before this packaging work; publishing post-tag
content as `0.9.0` would misrepresent what the tag points at.

### Added

- **`@aiosbrain/aios` npm package** — `package.json` is now publishable
  (`aios-workspace` → `@aiosbrain/aios`, `private` removed, public
  `publishConfig`), with a `files` allowlist shipping exactly the CLI's traced
  runtime surface: `scripts/`, `scaffold/`, `validation/`, `hooks/`, the
  prebuilt `dist/` operator-loop, the relative-path foundation sources
  (`packages/foundation/src`), and the pinned contracts (`docs/brain-api.md`,
  `docs/ENGINEERING-CONSTITUTION.md`, `docs/GETTING-STARTED.md`). `gui/`,
  `src-tauri/`, `test/`, `examples/`, and `.github/` do not ship.
  `@aiosbrain/foundation ^0.1.0` is declared as a real dependency (local dev
  keeps resolving the `packages/foundation` workspace copy). **Not yet
  published** — the first publish is a deliberate `publish-npm.yml` dispatch.
- **Golden-path pack test + CI lane** (`npm run test:pack-golden`,
  `test/npm-pack-golden-path.test.mjs`) — packs the tarball, installs it into a
  clean prefix, then runs `aios --help`, scaffolds a consultant workspace,
  runs `validation/validate-all.sh --quick`, and drives offline
  `aios status`/`push --dry-run` from the installed location only, proving the
  CLI is repo-clone-independent.
- **`publish-npm.yml`** — tokenless npm Trusted Publishing (OIDC) via
  `workflow_dispatch` with an explicit version input that must match
  `package.json`; runs the golden-path gate before `npm publish`.

### Fixed

- `npm run gui` in a GUI-less install now fails with one actionable diagnostic
  instead of a cryptic module-not-found from the spawned server, and
  `scaffold-project.sh` recreates `.opencode/.gitignore` when the scaffold
  source lost it to npm's tarball `.gitignore` stripping.

## [0.9.0] — 2026-08-01

The multi-repo split release (AIO-594/AIO-597): the one-repo layout is cut along
declared, tested seams into a published foundation package, a standalone GUI
repo, and a devtools repo — while the core toolkit in this repo stays
authoritative for every cut surface until the deferred deletion PRs land. The
Brain API contract stays within major `v1` at revision **1.15**.

### Added

- **`@aiosbrain/foundation` 0.1.0 published to npm (public)** — the shared hub
  modules (`runtimes`, `workspace-parse`, `brain-config`, `linear-client`,
  `brain-client`, `git-files`, `constitution`) extracted into the
  `packages/foundation/` npm workspace; the old `scripts/` paths remain as
  one-line re-export shims so nothing consuming them breaks. (AIO-601, #492,
  renamed from `@aios-alpha/monorepo` in #502)
- **Toolkit-runtime seams + contracts** — the GUI reaches the toolkit only
  through the toolkit-location contract (`--toolkit-dir` → `AIOS_TOOLKIT_DIR` →
  pre-split relative fallback; `docs/gui-toolkit-contract.md`), and the
  devtools-bound command set (`ship`, `build`, `roadmap-run`, `spec-eval`,
  `spec-publish`, `consolidate-findings`) reaches core-staying modules only
  through `scripts/toolkit-locate.mjs` (`docs/devtools-toolkit-contract.md`).
  (AIO-600 C1–C5 #495–#499, AIO-594 #511)
- **Boundary gate** — `scripts/check-boundaries.mjs` encodes the repo seams as
  import rules and runs as a named CI gate (`check:boundaries`), including rule
  **R6**: core must not import the devtools path set. (AIO-597 #464/#486,
  AIO-594 #508)
- **`aios codebase-health`** — composed codebase-health scorer + rubric + CLI
  with an advisory CI baseline delta (AIO-605, #494). Brain API revision
  **1.15** adds an optional, scalar-only `metrics.codebase_health` object on
  `POST /codebases` (AIO-608, #489); the scan-on-merge workflow can attach the
  snapshot to its scan payload — opt-in via the `AIOS_PUSH_CODEBASE_HEALTH=1`
  repo variable (default OFF in the workflow; enabled on the canonical repo).
  (AIO-608, #501)
- **`aios repo-bootstrap`** — governance stamp installer for split repos, used
  to bootstrap the cut repositories. (AIO-602, #493)
- **Delivery manifest tooling** — durable split-delivery manifest with read-only
  reporting (AIO-595, #491) and `aios delivery status` cross-repo
  PR/worktree/branch reconciliation (AIO-579, #466).

### Changed

- **GUI + desktop shell cut to `github.com/aiosbrain/aios-workspace-gui`** —
  filtered history from core at freeze SHA `d6dcdeb` (tag `cut/gui-freeze`).
  The in-tree `gui/` + `src-tauri/` remain present and authoritative in 0.9.0;
  their deletion from core is a deferred post-demo PR (AIO-612). (AIO-603 #500,
  AIO-594 #509)
- **Devtools command set cut to `github.com/aiosbrain/aios-devtools`** —
  bootstrapped via `aios repo-bootstrap` with pinned-toolkit CI; the in-tree
  `scripts/` implementations remain authoritative until the removal PR lands.
  (AIO-594)
- **Harness guards hardened** — command segmentation + cwd scope fixed in the
  guard hooks (AIO-637, #513), shell redirects parsed without quoted false
  positives (#472), and the hook installers never clobber tracked
  `core.hooksPath` policy hooks (AIO-638, #503/#504).
- Also in this release: TypeScript covered by typescript-eslint with warn-only
  complexity budgets (AIO-598, #487); the file-size gate flipped to
  default-deny with a ratchet (#463); CI lanes path-filtered (AIO-599, #467);
  the leak gate enforces a name-free baseline on push, not just merge (#450);
  the Claude Code statusline ships to every scaffolded workspace (#485); the
  spec-eval adversarial layer is opt-in (AIO-573, #460); Local Bugbot is
  optional — current-head cloud review satisfies the review gate (AIO-567,
  #484).

### Migration (0.8.0 → 0.9.0)

- **Existing workspace owners:** run `aios update` once, and set
  `AIOS_TOOLKIT_DIR` in your workspace `.envrc` to your toolkit checkout. No
  re-scaffold is needed.
- **Standalone GUI installs** (from `aios-workspace-gui`) must locate the
  toolkit explicitly — set `AIOS_TOOLKIT_DIR` or pass `--toolkit-dir`; the
  relative fallback only resolves in the in-tree monorepo layout
  (`docs/gui-toolkit-contract.md`).
- **In-tree GUI still works:** because the deletion is deferred (AIO-612), the
  `gui/` + `src-tauri/` trees in this repo are still present and authoritative
  in 0.9.0 — nothing changes for in-tree GUI users this release.
- **Desktop (Tauri)** is adjacent-checkout mode only and not demo-ready;
  self-contained bundling is AIO-581, owned by the GUI repo.

## [0.8.0] — 2026-07-28

Onboarding V2 and the first complete Operator Loop release train. This release
standardizes inspect-first setup across Personal, Join, and Create paths; makes
toolkit updates previewable and approval-gated; and advances the additive Brain
API contract through **v1.14**.

### Added

- **Onboarding V2** — `aios onboard --inspect --json` discovers an existing
  toolkit/workspace before mutation, then guides exactly one Personal, Join, or
  Create path. Join validates the approved Brain origin and API key through
  `GET /api/v1/me`; Create remains guide-only; onboarding never pushes content.
- **Operator Loop and Unified Inbox** — action-oriented daily/weekly workflows,
  governed connector ingestion, durable attention state, task writeback, and
  the CLI-first inbox surface.
- **`aios stakeholders (--owns | --who | --meeting)`** — query the team
  Company-Graph over the new team-tier `GET /api/v1/company-graph` endpoint
  (brain-api **v1.5**, additive): who owns a workflow domain, one person's
  role/reports-to/owned workflows, and meeting attendees derived from item
  frontmatter. Team-tier only — an external key is rejected up front on every
  mode via a `GET /me` probe. Exposed over MCP as `brain_stakeholders`.
  (AIO-141)

### Changed

- **Safe toolkit updates** — `aios update --preview` reports its safety check and
  proposed mutations before explicit approval, while managed governance files
  retain three-way merge and conflict-preserving behavior.
- **PR review evidence cleanup** — `aios ship` now treats Local Bugbot as the mandatory canonical
  review, persisted against the exact branch head and verified base SHA. CodeRabbit is
  `ready-for-review` label-gated, optional for Standard PRs, mandatory for safety-sensitive PRs,
  and must provide substantive current-head text. `--reviewers` selects `coderabbit` and/or the
  default `gpt-5.5`; the old `bugbot` name is a deprecated no-op alias. Safety-sensitive changes
  reject `--auto-merge`.

### Fixed

- Hardened secrets, access-tier, worktree, local-review, transcript-grounding,
  connector, and update boundaries so failures remain explicit and recoverable.

## [0.7.0] — 2026-07-04

Cognitive Ergonomics **shadow band** rollout (epic AIO-211): CE and Agentic
Maturity visible against each other in the CLI, cockpit GUI, and Team Brain —
always badged **shadow · uncalibrated**; raw attention signals never sync.
Sync contract stays **v1**; `ce_band` is an additive **v1.3** field on
`POST /api/v1/metrics`. (AIO-212–AIO-222.)

### Added

- **`aios analyze --push`** — includes optional `ce_band` (`0`–`4` or `null`) on
  each daily metrics payload; scored client-side vs the operator's own baseline.
  (AIO-218, #175)
- **TUI CE line** — Cognitive ergonomics shadow band, 14-day AM/CE dual sparkline,
  and attention tips in `aios analyze` text output. (AIO-213)
- **GUI Maturity panel** — cockpit shows AM axes plus CE shadow band and 30-day
  trend (local-only shadow semantics). (AIO-215)
- **Session pulse Stop hook** — after each session, a throttled Stop hook reads
  precomputed `last_summary` (AM + CE + weakest-axis tip); cron recipe in
  `docs/GUIDE.md` §7 keeps analyze state fresh. (AIO-214, #170)
- **`aios analyze --calibrate`** — Phase B calibration harness (Spearman rho vs
  autonomy, MERGE/PROMOTE/HOLD/NOT_ENOUGH_DATA verdict); analysis-only, writes
  a local verdict artifact under `.aios/`. (AIO-216)

### Changed

- **Display rename** — "Agentic Engineering Maturity (AEM)" → **Agentic Maturity
  (AM)** in user-facing copy; wire metric id `aem-individual` and axis keys
  unchanged. (AIO-212)

### Documentation

- **`docs/brain-api.md` v1.3** — documents optional `ce_band` on
  `POST /api/v1/metrics` (provenance-only; brain persists verbatim). (AIO-217)

## [0.6.0] — 2026-07-03

The ship pipeline release: the agent build loop grows into a **fully gated,
unattended issue pipeline** — one command takes a Linear issue from recon to a
merged PR behind operator gates, and a serial walker runs the roadmap overnight.
(AIO-157–AIO-165 · PRs #120, #125, #129. Full contract: `docs/agent-build.md`.)

### Added

- **`aios ship AIO-<n>`** — the whole gated loop for one Linear issue: recon →
  plan → build → PR → review → fix → merge → cleanup, behind a **plan gate** and
  a **merge gate** (both default ON; in a non-TTY context an active gate exits
  with a `*_GATE_BLOCKED` code instead of hanging — cron safety). Recon reads
  only git-tracked, deny-filtered files referenced by the untrusted issue text,
  and the recon model step runs with **no tools at all**; the merge gate requires
  green CI, a CLEAR consolidator, and a path-gated `SAFETY_APPROVED` review when
  the diff touches a safety surface. A stable `SHIP_EXIT` table names every
  outcome; `--dry-run` previews the resolved step plan offline. (AIO-163, #129)
- **`aios roadmap-run (--label|--epic|--project)`** — the unattended serial
  walker: ships one **unblocked, unassigned, Todo** issue at a time via
  `aios ship --auto --auto-merge`, fast-forwards `main` between issues, and
  writes a deterministic morning digest every run — the `SHIP_EXIT` code decides
  continue / skip / halt. (AIO-164, #129)
- **`aios pr`** — idempotent push + `gh pr create` (an already-open PR for the
  head branch is reused, never duplicated), argv-only, with the `AIO-<n>` key
  always in the PR title so the repo automations fire. Chained by
  `aios build --pr` after the same pre-ship gates as `--merge`. (AIO-159, #120)
- **`aios consolidate-findings --pr <n> --issue AIO-<n>`** — merges CI checks,
  the PR diff, Bugbot/CodeRabbit comments + reviews, and an optional GPT-5.5
  review into **one severity-ranked finding list** with fail-closed max-severity
  inheritance (a red **or still-pending** CI board can never be CLEAR). Prints
  `VERDICT=CLEAR|BLOCKED`; exits 0 CLEAR · 3 BLOCKED · 1 error.
  `aios build --findings <file>` then seeds a fix round from the must-fix
  subset (all Critical/High + plan-conformance Medium). (AIO-161, #125)
- **Per-step model config** — `scripts/loop-models.mjs` resolves a model,
  reasoning effort, and timeout per pipeline step (default matrix →
  `.aios/loop-models.yaml` → CLI flag), with a fail-closed **cross-family
  diversity guard** (builder vs code reviewer, planner vs plan reviewer must be
  different model families) and a **Claude-runner guard** (Claude-runner steps
  reject non-Claude ids). A present-but-malformed config **fails loudly**; only
  a missing file falls back to defaults. Tracked example:
  `docs/loop-models.example.yaml`. (AIO-162, #120)
- **Review resilience** — the review call auto-retries **exactly once** on
  timeout with a doubled timeout, and the default review timeout **adapts to
  the real diff size** (`300s + 60s/10k chars`, capped 600s) unless pinned via
  `--cursor-timeout` / `code_review_timeout_s`. (AIO-160, #125)
- **Hermes runbook** (`docs/hermes-runbook.md`) — operating the pipeline
  unattended overnight on an always-on host. (#125)

### Changed

- **Builder hardening — the G1–G7 pipeline closures** (AIO-157, AIO-158, #120):
  `ANTHROPIC_API_KEY` is **stripped from the Claude Code builder child** so the
  builder always runs on its own login auth, never a dotenvx-injected metered
  key; every builder call is prefixed with a **fence** (no push, no PR,
  worktree-only) backed by a `GIT_CEILING_DIRECTORIES` env fence and the
  primary-checkout tripwire; `aios build --log` now **appends** across runs
  instead of clobbering.
- **`wait-for-bots` default flip** (AIO-158, #120): **require-all is now the
  default** — a bot still missing at timeout exits `2` so the pipeline never
  proceeds to review on incomplete signals. `--any` restores the old
  proceed-on-timeout behavior; `--require-all` stays as a no-op alias; and
  `--bots <list>` (#129) gates on a subset.
- **Sync contract → v1.2** (`docs/brain-api.md`, additive): optional task-row
  `parent` / `labels` / `priority` on both `POST /api/v1/items` and the
  `GET /api/v1/tasks` writeback, so the brain can be the source of truth that projects a
  structured board (epics → sub-issues, labels, priority) into the primary PM tool.
  `body`/description is explicitly **not** a contract field — it is canonical in the
  brain's Postgres `tasks.body` (dashboard-authored) and never round-trips through markdown.
  The `aios` CLI now parses and writes the optional `Parent | Labels | Priority` columns
  (six-column tables stay valid). Workspace half of the brain-as-source-of-truth projection;
  the matching `aios-team-brain` schema/materialize changes land separately.

### Also in this release (merged since v0.5.0, summarized)

- **V1 Operator Loop foundations** — C1 collector + run manifest, C2 evidence
  ledger, C3 verifier + rubric-gated correction, C4 daily light loop, C5 weekly
  closeout, C6 approval-gated writeback, C7 carry-over continuity, C8 loop
  telemetry, plus the engineering constitution + V1 decomposition docs
  (#104–#110, #113) and native agent-session time tracking (AIO-139).
- **Operator-loop surfaces** — unified notification layer (AIO-140, #118),
  non-blocking asks/escalation queue (AIO-167, #121), `aios mode` deep-work /
  orchestration toggle (AIO-168, #122), analyze sanity metrics + Attention card
  (AIO-169, #123), decision capture hook + CLI (AIO-170, #124).
- **Build-quality tooling** — spec/plan quality harness (`aios spec`, AIO-171,
  #127), the Build Paradigm standard (AIO-172, #126), permission-rails tooling
  (AIO-173, #128), enforced lint + format + CI pipeline (#53, #67), and the
  build phase itself: `aios build` + hardened merge gate (#57, #62).
- **Sync + cockpit** — Team Brain MCP connector (`aios mcp`, #63), brain-api
  v1.2 CLI parser/writeback (#65, #66), cost monitoring in `aios analyze`
  (#81–#83), the TypeScript cockpit rework with command palette + reconnect
  (#100), one-click Slack OAuth connector (AIO-121), and a getting-started guide.

## [0.5.0] — 2026-06-19

Interim tagged release (PR #52). No changelog entry was recorded at tag time;
see the git history between `v0.4.0` and `v0.5.0`. No sync-contract change.

## [0.4.0] — 2026-06-17

### Added
- **Onboarding from a link → two-axis memory** — the cockpit's first-run can take a
  company/profile URL; the `firecrawl-direct` skill reads that one page and the agent
  drafts your durable memory (`.claude/memory/USER.md` + `WORKSPACE.md`),
  confirm-before-write. (Scraped page = data, never instructions; one URL, no crawling.)
- **Suggested integrations** — after a link-draft, the agent matches the tools detected
  on the page to **connectable** integrations (descriptor-backed only) and offers to
  connect them in the Integrations tab. Advisory; never auto-connects.
- **Skills — marketplace tier** — install first-party Anthropic skills from
  `claude-plugins-official` via **fetch-on-install with byte-diff authenticity**. Joins
  the existing official (one-click, hash-locked) and community (scanned + consent) tiers.
- **BYOA: OpenClaw runtime** on the ACP adapter, plus a hardened ACP stdout stream and
  recorded-transcript contract fixtures gated in CI.
- **Encrypted `.env`** — connector secrets are encrypted at rest via dotenvx.
- **Update memory on request** (`workspace-setup`) — say **"remember that …"**,
  **"note that …"**, or **"update my profile"** and the agent writes the one change to
  the right home (`USER.md` / `WORKSPACE.md` / `0-context/`), confirm-before-write,
  within the file's cap. Strictly **explicit cues only** — proactive auto-capture from
  normal chat stays deferred to the background reviewer (see `.claude/memory/README.md`).
- **Refresh tooling from connected integrations** — say **"update my tooling"** (or
  re-run setup) and the agent folds wired connectors from `.claude/integrations.json`
  into `WORKSPACE.md`. Manual by design — there's no auto-trigger on connect yet.
- **Background memory reviewer** (cockpit, `claude-code` runtime) — after each turn a
  fast model (Haiku) conservatively saves durable facts to `.claude/memory/USER.md` /
  `WORKSPACE.md`; you get a **💾 memory updated** notice with **undo**, and writes take
  effect next session. **On by default**, opt out in *Settings → Memory* (`memory_review`
  in `aios.yaml`). Strict trust boundary: the model only proposes tiny structured facts
  and deterministic, fail-closed server code does the writing — runtime-gated (no
  Anthropic call on other runtimes), secrets never sent or written, single-line/no-code
  facts only, per-file cap, human edits never clobbered (dirty-tree skip + compare-and-
  swap undo), and nothing is `git commit`ted. New: `gui/server/memory-reviewer.mjs`,
  `gui/server/memory-files.mjs`.

## [0.3.0] — 2026-06-17

The cockpit overhaul: the local GUI (`npm run gui`) becomes a real workspace
cockpit — model choice, resumable chats, personality, an official-skills library,
and a draft-from-a-link onboarding path. No change to the spine, validators,
guard, harnesses, or the Team Brain sync contract.

### Added

#### Cockpit chat (#16)
- **Model picker** — switch between **Sonnet 4.6** (default; fast and cheap) and
  **Opus 4.8** from the chat header, **mid-session and with no reconnect**. The
  choice persists to `agent_model` in `aios.yaml`; an unknown value degrades to
  Sonnet with a visible warning.
- **Resumable chat history** — a Chats sidebar lists every saved conversation
  (titled from its first message, newest first). Reopen one to replay its
  transcript and resume the same session; `+ New chat` starts fresh; the
  last-open chat is restored on reload.
- **Context (est.) meter** — an approximate `~Nk / 200k` indicator of how much of
  the model's window the last turn used (input + cached tokens).
- **Markdown rendering** — assistant replies render as GitHub-flavored markdown;
  links open in a new tab without leaking the cockpit token.
- **Personality presets** (Settings → Personality) — **AIOS**, **Analyst**,
  **Coach**, **Operator**. A style layer over the system prompt only; it never
  overrides workspace rules, `CLAUDE.md`, or skills. Selecting one starts a new
  chat so the voice takes effect.

#### Skills library (#17)
- **One-click install of official Anthropic skills**, vendored from
  `anthropics/skills` and **hash-locked** to a pinned upstream commit, all
  **Apache-2.0**. Install copies the skill into `.claude/skills/` behind an
  integrity check, a collision guard, and an append-only install ledger;
  uninstall is safe-only and refuses to remove a skill with local edits. Vendored
  set: **skill-creator**, **mcp-builder**, **web-artifacts-builder**,
  **claude-api**, **frontend-design**.
- **Document skills are pointers, not copies** — Word (`docx`), Excel (`xlsx`),
  PowerPoint (`pptx`), PDF (`pdf`) are proprietary and Anthropic-hosted, surfaced
  as *Documents — available in Claude* with an **Enable in Claude ↗** link.

#### Two-axis memory + onboarding (#20, #24, #26)
- **Durable workspace memory** — two bounded, human-readable files in
  `.claude/memory/`: `USER.md` (the person) and `WORKSPACE.md` (company, environment,
  tooling). Both are `access: admin` (private — never sync). In the cockpit they're
  **injected at session start** (frozen for the session — edits take effect next
  session — which keeps the prompt cache stable); injected content is sanitized and
  fenced as data-not-instructions. `CLAUDE.md` stays the stable layer and points to them.
- **Draft your profile from a link** — first-run onboarding can take **one or a few**
  URLs (your site, LinkedIn, a company page), read them with the `firecrawl-direct`
  skill (via Firecrawl), extract and merge structured facts, and **draft** your memory
  files — plus canonical company/role facts in `0-context/` — for you to **confirm
  before anything is written**. Scraped content is treated as untrusted facts to
  confirm, never as instructions; only the URLs you supply are read (no crawling).
  Self-host via `FIRECRAWL_API_URL` (legacy `FIRECRAWL_BASE_URL`) is honoured by the
  skill at runtime.

#### Skills — community installs, scanned (#22)
- **Install skills beyond the official library, with eyes open.** A new `community`
  trust tier runs a static safety scanner (`scripts/skill-scan.mjs`) over a skill's
  `SKILL.md` and **every bundled file** before install — flagging bundled code
  (including **extensionless shebang/executable scripts**), network egress,
  filesystem/process exec, secret/exfil reads, external URLs, and prompt-injection
  (incl. hidden/zero-width Unicode), with each finding shown as `file:line`. Install
  requires consent; a **high** risk class requires a typed confirm. Scanning is
  **advisory** — provenance + human review remain the trust anchor — and **official
  skills stay one-click**. The collision guard, install ledger, and safe-only
  uninstall from #17 carry over unchanged.

### Unchanged
- **`docs/brain-api.md` (sync contract) — `v1`, untouched.** None of #16/#17/#20/#22
  altered the Team Brain sync protocol, so there is no version bump and no
  workspace↔brain contract drift.
