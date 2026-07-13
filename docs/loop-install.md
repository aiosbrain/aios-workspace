# `aios loop install` — the scheduler (AIO-367)

Before this, `hooks/session-pulse.mjs` and `scripts/maturity-week-cmd.mjs` both told you to "add
the cron" or "run weekly (cron / a Claude routine)" — but no install path, plist, or crontab
snippet existed anywhere in this toolkit. `aios loop install` is that path.

## What it detects and installs

| Environment | Mechanism | Why |
|---|---|---|
| macOS (`process.platform === "darwin"`) | a `launchd` LaunchAgent per job, written to `~/Library/LaunchAgents/` | `StartCalendarInterval` gives **catch-up-on-wake** for free: if the laptop is asleep/closed at the scheduled time, launchd runs the job as soon as the system next wakes, instead of silently skipping it. Cron has no such mechanism. |
| Linux / anything else | a single marker-delimited block in the user's `crontab` | The realistic 24/7-box case for this toolkit's users — a server isn't expected to sleep, so cron's lack of catch-up doesn't matter. |

This is a deliberately simple heuristic (laptop ≈ macOS, always-on box ≈ everything else) — not
full OS/power-state probing. Override it with `--scheduler launchd|cron` if your setup doesn't
fit (e.g. a Linux laptop).

Three jobs are installed:

| Job | Command | Cadence |
|---|---|---|
| `daily` | `aios loop daily` | every morning, 08:00 |
| `weekly` | `aios loop weekly; aios maturity-week` | Monday morning, 08:15 — bundles the AM6 weekly maturity report into the same slot, since it has the same "run me weekly" cadence |
| `analyze` | `aios analyze` | hourly | it's ~3.7s locally, so instead of asking a human to remember a cron that doesn't exist, it just self-refreshes on a cheap cadence |

Logs land under `.aios/loop/logs/<job>.log` (admin-tier, outside `sync_include` — never pushed).

## Usage

```bash
aios loop install                 # detect + install
aios loop install --dry-run       # print the plan, write nothing
aios loop install --status        # is it currently installed?
aios loop install --uninstall     # remove the installed job(s)
aios loop install --scheduler cron   # override detection
```

Re-running `install` is idempotent: launchd overwrites the same labeled plist in place; cron
strips its own previously-installed block (marked `# >>> aios-loop-install (<slug>) begin/end
>>>`, the same convention `scripts/install-aios-shell.sh` uses for the `aios()` shell function)
before appending the current one. Neither path ever duplicates entries or touches a human's other
crontab lines / other LaunchAgents.

The invocation embedded in each job reuses the CLI's existing resolution — the same `bin/aios` /
`scripts/aios.mjs` shim chain `scripts/install-aios-shell.sh`'s `aios()` function and the
`"aios"` npm script already rely on. No new binary-resolution mechanism was introduced.

## F-C6 — authenticating a scheduled run (the dotenvx fix)

A cron/launchd job invokes the CLI directly, with none of the `dotenvx run --` wrapping that
normally decrypts `.env` into `process.env` at shell start (the env cascade described in
`../CLAUDE.md`). Before this fix, that meant `aios push` (and anything else needing
`AIOS_API_KEY`) failed with a misleading `no API key found in $AIOS_API_KEY (env or .env)` —
misleading because the key **was** there, just still encrypted.

The fix, in `scripts/brain-config.mjs`:

1. `isDotenvxEncrypted(repo)` detects dotenvx ciphertext in `.env` — a `DOTENV_PUBLIC_KEY=`
   header, or any `KEY=encrypted:...` line.
2. If a plaintext lookup for the requested key comes up empty **and** `.env` is dotenvx-encrypted,
   `decryptDotenvKey(repo, key)` shells out to this repo's own vendored `dotenvx`
   (`node_modules/.bin/dotenvx`, always present — it's a `package.json` dependency) to decrypt
   that one key using `.env.keys`, which dotenvx auto-discovers next to `.env`.
3. If `.env.keys` is missing (or decryption otherwise fails), `resolveBrainConfig` returns
   `dotenvx_encrypted: true`, and the CLI's `requireOnline` gate (in `scripts/aios.mjs` and
   `scripts/member-cli.mjs`) fails with an **actionable** error instead of the generic one:

   ```
   your .env is dotenvx-encrypted for $AIOS_API_KEY and no usable .env.keys was found to decrypt
   it — run under direnv/dotenvx (e.g. `dotenvx run -- aios push`), or set $AIOS_API_KEY directly.
   ```

**Net effect for a scheduled job:** as long as `.env.keys` sits next to `.env` on disk (the normal
state for any machine that has ever run `aios onboard`/`aios connect` — `.env.keys` is gitignored
but persists locally), a cron/launchd-invoked `aios push` or `aios loop weekly` authenticates
without needing direnv at all. Nothing about the direnv-hydrated path changes — that still wins
first, since `resolveBrainConfig` only reaches for decryption when the plaintext/process.env
lookup is empty.

## Roadmap note — not built here

Managed cloud scheduling (a hosted scheduler that runs `aios loop` for you, for teams that don't
want a laptop or a box to be the clock) is a plausible enterprise feature. **Out of scope for this
issue** — `aios loop install` is local-machine only (launchd/cron on the box you run it from).
