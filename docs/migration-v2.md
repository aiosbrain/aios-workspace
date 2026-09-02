# Migrating to `@aiosbrain/aios` v2.0.0

v2.0.0 makes the **published npm package the distribution root** of the AIOS CLI
(AIO-635 / AIO-1064): `npm i -g @aiosbrain/aios` alone gives every stamped workspace a
working `aios` and a working `aios update` — no git checkout, no `AIOS_TOOLKIT_DIR`, no
Python, no `jq`. The one canonical surface is `aios <command>`; the connector routes are
`aios linear …` and `aios slack …`.

## What changed

- **Stamp format 2.** `.aios-toolkit-version` keeps its v1 line shape (line 1 is a full
  40-char sha) and gains keyed lines: `stamp-format 2`, `package`, `package-version`,
  `package-integrity`, `manifest-digest`, `base-store`. The upgrade is a one-way ratchet —
  v2 always writes format 2, including for `--from <checkout>` sources.
- **Content-addressed merge bases.** Every successful `aios update` persists the
  just-synced managed content into `.aios/toolkit-bases/` (blobs + `index.json`, committed
  to your workspace repo). The next update 3-way-merges against that store — which is what
  lets an immutable npm install act as an update source, with zero git operations against
  it.
- **One toolkit classifier.** `checkout` / `registry` / `workspace` roots are classified
  by one resolver; a registry root skips the pull half entirely and `aios update` **never
  writes into the npm prefix** — upgrading the install itself is `aios update --self`
  (or `npm i -g @aiosbrain/aios@<version>`).
- **Shim + shell v2.** The workspace shim resolves, in order: `AIOS_TOOLKIT_DIR`
  (set-but-invalid is a hard error), the deprecated `AIOS_TOOLKIT_CLI`, the stamp's
  recorded source, a PATH-installed `aios` (realpath + containment guarded), then the
  legacy relative-layout guesses. The zsh `aios()` function gains a `command aios` branch
  with an `AIOS_SHELL_SHIM` recursion sentinel — rerun `scripts/install-aios-shell.sh` to
  pick it up (it never edits `~/.zshrc` without you running it).
- **Connector cutover complete.** The executable provider-client copies that used to live
  under `.claude/skills/aios-linear/linear.mjs` and
  `.claude/descriptors/skills/{linear-direct,slack-personal}/` are **removed at v2.0.0**;
  their capabilities live in the built-in adapters. The published `linear`/`slack` bins
  remain **warning-only delegates through the whole v2 window** (removable no earlier than
  v3.0.0), so rolled-back muscle memory keeps working.

## Migration notes (read before upgrading)

1. **Node 24/26 upgrade path from 0.12.0.** The published `@aiosbrain/aios@0.12.0` pins
   `@aiosbrain/aios-devtools@0.3.0`, whose engines declare `>=22 <23`. A real
   0.12.0 → v2 rehearsal on Node 24 or 26 therefore requires installing the **legacy**
   baseline with engine-strict off (`npm_config_engine_strict=false npm i -g
   @aiosbrain/aios@0.12.0`). Only the legacy install needs the relaxation; the v2
   candidate installs strict on 22.x, 24.x and 26.x.
2. **Slack consent narrowing (AIO-1068).** An **environment-sourced** Slack user token is
   refused toward a **workspace-domain** brain destination: ambient `SLACK_USER_TOKEN`
   never gets POSTed to a brain URL that was resolved from an untrusted workspace's own
   config. Passing the token explicitly — `aios slack connect --stdin` or as an argv
   value — is the consent path for a workspace-domain destination.

## Runbook

All commands below are executed against the packed v2 candidate during release
acceptance (`npm run test:package-acceptance` is the automated authority; this is the
human-readable sequence).

### Fresh machine

```sh
npm i -g @aiosbrain/aios@2
aios --help
aios doctor --json
aios provenance --json          # installType: "registry"
```

### Scaffold + first update

```sh
aios onboard --inspect          # read-only preflight
# scaffold a workspace (or use an existing one), then from the workspace:
aios update --check
aios update                     # vendors governance from the installed package,
                                # seeds .aios/toolkit-bases, writes the format-2 stamp
aios doctor                     # workspace-stamp: format 2; base store verified
```

### Upgrade from 0.12.0 (existing workspace)

```sh
npm_config_engine_strict=false npm i -g @aiosbrain/aios@0.12.0   # legacy baseline (note 1)
npm i -g @aiosbrain/aios@2
aios update                     # reads the v1 stamp, merges, records .aios/rollback.json,
                                # ratchets the stamp to format 2
aios update                     # repeat: byte-stable no-op (only synced-at may move)
```

### Rollback (any time during the v2 window)

```sh
aios update --rollback          # restores the recorded pre-upgrade stamp/config snapshots
                                # and prints the exact reinstall command from
                                # .aios/rollback.json (runs it only on interactive confirm)
```

### Canonical commands

```sh
aios linear --help
aios linear get AIO-73
aios slack --help
aios slack whoami
```

### Legacy delegates (stderr warning, identical stdout + exit status)

```sh
linear get AIO-73               # deprecation notice on stderr; removal ≥ v3.0.0
slack whoami                    # same
```

## Recovery commands (all stable)

- `aios doctor` — stamp format, base-store/index integrity, migration-journal state,
  rollback-record presence.
- `aios update` — re-entry IS the resume path after any interruption; no separate flag.
- `aios update --rollback` — reinstall-plus-restore (ADR 0002 §9; never a reverse
  field-by-field migration).
- `aios provenance --json` — which install is actually running when PATH, checkout, and
  shell-function shadowing disagree.
