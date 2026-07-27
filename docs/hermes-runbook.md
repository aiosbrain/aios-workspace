# Hermes always-on host runbook

How to run the AIOS ship pipeline — `aios relay`, `aios build`, and `aios
consolidate-findings` — **unattended, overnight, on the team's always-on Linux host**. This
guide assumes you have never seen that box: it walks the prereqs, invocation, cron/systemd
templates, and a verification checklist you can execute on the host.

> All paths here are placeholders. Substitute your own; never commit a real home path,
> hostname, or IP. Use `/home/<user>/<workspace>`, not a machine-specific absolute path.

---

## 1. Purpose & scope

The ship pipeline is designed to run without a human watching it. On an always-on host you
can schedule a nightly run that:

1. builds an approved plan on an isolated worktree (`aios build`),
2. opens a PR (`aios build --pr`),
3. runs mandatory exact-head Local Bugbot and, when selected or safety-required, waits for
   current-head CodeRabbit (`scripts/wait-for-bots.mjs`),
4. consolidates every review into one finding list (`aios consolidate-findings`), and
5. feeds blocking findings back into a fix round (`aios build --findings <file>`).

This runbook covers **only** running that pipeline on the host. It contacts **no** host from
the build itself — nothing here reaches out to a machine; you run these commands **on** the box.

---

## 2. Prereqs & non-interactive verification

Confirm each tool is present and non-interactively usable. Run every check over SSH in a
non-login shell to catch anything that only works in an interactive terminal.

| Tool | Check | Notes |
|------|-------|-------|
| Node ≥ 20 | `node --version` | ESM tooling; ≥ 20 recommended |
| git | `git --version` | worktrees are mandatory |
| GitHub CLI | `gh --version` && `gh auth status` | `gh auth login` is **interactive / user-only** |
| Cursor CLI | `cursor --version` | `cursor login` is **interactive / user-only** |
| Claude Code | `claude --version` | `claude login` is **interactive / user-only** |

The three `*login*` steps are **user-only** — they open a browser/device flow that an
unattended agent cannot complete. Do them once, interactively, before scheduling anything;
the nightly job then reuses the stored auth.

---

## 3. Invocation & env

Always invoke through the installed `aios` command so the
dotenvx-injected environment is applied:

```bash
cd /home/<user>/<workspace>
aios build plan.md feat/AIO-<n>-x --pr --issue AIO-<n> --log run.md
```

Two environment invariants:

- **`ANTHROPIC_API_KEY` is always stripped** from the spawned Claude Code child (G1 hardening
  in `scripts/relay-core.mjs`). `aios build` runs under `npm run aios` with a dotenvx-injected
  key, and without this strip the spawned Claude Code would flip from its own login/subscription
  auth to metered API billing. You do not need to unset it yourself — the strip is authoritative.
- **`AIOS_API_KEY` must be ABSENT for the test suite.** Run the tests as
  `env -u AIOS_API_KEY npm test` so a stray brain key can't perturb the offline tests.

---

## 4. cron template

Placeholder paths only. Redirect console output to a gitignored per-day log under `.aios/loop/`:

```cron
# Nightly AIOS ship run at 02:30. Replace <user>/<workspace>.
30 2 * * *  cd /home/<user>/<workspace> && /usr/bin/npm run aios -- build plan.md feat/AIO-<n>-x --pr --issue AIO-<n> >> /home/<user>/<workspace>/.aios/loop/nightly-$(date +\%F).log 2>&1

# Unattended roadmap walker: ship up to 3 unblocked issues from an epic each night at 03:00.
# roadmap-run invokes `aios ship --auto --auto-merge`; safety-sensitive work stops because
# --auto-merge is forbidden there and must be resumed through the operator gate.
0 3 * * *  cd /home/<user>/<workspace> && /usr/bin/npm run aios -- roadmap-run --epic AIO-<n> --max-issues 3 --comment-digest >> /home/<user>/<workspace>/.aios/loop/roadmap-$(date +\%F).log 2>&1
```

Notes:

- `.aios/` is gitignored — the log never gets committed.
- Escape the `%` in `date +\%F` for cron.
- No real home paths, hostnames, or IPs — keep the crontab free of machine-specific values.
- **`LINEAR_API_KEY` reaches the box via dotenvx** (`npm run aios` runs under `dotenvx run`); it is
  never written into the crontab. `roadmap-run` and `ship` need no other secret — Claude Code and
  Cursor use their own login auth, and `ANTHROPIC_API_KEY` is stripped from the builder subprocess.
- `roadmap-run` writes a morning digest every run to `.aios/loop/roadmap-digest-<date>.md`; a
  non-fast-forwardable `main` halts the walk (the next issue would otherwise base off stale state).

---

## 5. systemd service + timer templates

Prefer systemd where you want restart/observability semantics. A oneshot service + timer:

`/etc/systemd/system/aios-nightly.service`:

```ini
[Unit]
Description=AIOS nightly ship run
After=network-online.target

[Service]
Type=oneshot
User=<user>
WorkingDirectory=/home/<user>/<workspace>
ExecStart=/usr/bin/npm run aios -- build plan.md feat/AIO-<n>-x --pr --issue AIO-<n>
StandardOutput=append:/home/<user>/<workspace>/.aios/loop/nightly.log
StandardError=append:/home/<user>/<workspace>/.aios/loop/nightly.log
```

`/etc/systemd/system/aios-nightly.timer`:

```ini
[Unit]
Description=Run the AIOS nightly ship at 02:30

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now aios-nightly.timer`; inspect with
`systemctl status aios-nightly.service` and `journalctl -u aios-nightly.service`.

For the unattended roadmap walker, use the same shape with a `roadmap-run` `ExecStart` (again,
`LINEAR_API_KEY` arrives via dotenvx, not the unit file):

```ini
# /etc/systemd/system/aios-roadmap.service — [Service] ExecStart line
ExecStart=/usr/bin/npm run aios -- roadmap-run --epic AIO-<n> --max-issues 3 --comment-digest
```

Pair it with an `aios-roadmap.timer` (`OnCalendar=*-*-* 03:00:00`). `roadmap-run` calls `aios ship
--auto --auto-merge` per issue, so both operator gates are intentionally skipped on the host.

---

## 6. Verification checklist (dry-run on the host)

Before trusting a schedule, a teammate should see all of the following succeed on the box:

```bash
# 1. The five CLI versions + gh auth
node --version && git --version && gh --version && cursor --version && claude --version
gh auth status

# 2. Relay + build dry-runs (no git side effects, no merge/PR)
npm run aios -- relay "smoke: no-op task" feat/smoke --dry-run
npm run aios -- build plan.md feat/smoke --dry-run

# 3. The consolidator is invocable
node scripts/consolidate-findings.mjs --help

# 4. ship dry-run works offline (no LINEAR_API_KEY needed) and roadmap-run degrades cleanly
env -u LINEAR_API_KEY npm run aios -- ship AIO-<n> --dry-run
env -u LINEAR_API_KEY npm run aios -- roadmap-run --epic AIO-<n> --dry-run   # clean "key not set" message, non-zero

# 5. Offline tests pass without a brain key
env -u AIOS_API_KEY npm test
```

The live end-to-end dry-run on the actual box is the orchestrator's job; this checklist makes
that run executable by a teammate who has never logged in before.

---

## 7. Troubleshooting

- **Review timeouts.** `aios build` auto-retries a timed-out review **once** with a doubled
  timeout, and the default review timeout **adapts to the diff size** (`300s + 60s/10k chars`,
  capped `600s`). If a large diff still times out, pin a higher explicit value with
  `--cursor-timeout <seconds>` or `code_review_timeout_s` in `.aios/loop-models.yaml`. See
  [`agent-build.md` → Review resilience](./agent-build.md#review-resilience).
- **Missing auth.** A nightly failure that mentions login/authorization almost always means a
  `*login*` session expired. Re-run the interactive `gh auth login` / `cursor login` /
  `claude login` once; the scheduled job then resumes.
- **Worktree cleanup.** Non-converged builds preserve their worktree for resumption. List
  stragglers with `git worktree list`, prune removed ones with `git worktree prune`, and remove
  a specific one with `git worktree remove <path>`. The build's tripwire guarantees the primary
  checkout is never touched, so cleanup is always safe to do from it.

See also: [`agent-build.md`](./agent-build.md) (the build loop + the full ship pipeline) and
[`workflows.md`](./workflows.md) (per-step model config + the pipeline narrative).
