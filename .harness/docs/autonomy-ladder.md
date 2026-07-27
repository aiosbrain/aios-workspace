# The autonomy ladder — rolling out agents safely

**You don't climb to autonomy — you earn it through verification.** (AM pattern E5.)
The harness exists so a team can raise agent autonomy *without* raising risk: every
rung up the autonomy ladder is paid for with a stronger check. This is the document to
read before deploying agents into a team new to agentic engineering.

## The ladder

| Rung | Leash | Verification that earns it | Harness components |
|---|---|---|---|
| 0 — **Assisted** | Human accepts/rejects every diff; agent never runs commands unattended | Human review of everything | `AGENTS.md`, guard hooks (on from day one) |
| 1 — **Supervised** | Agent works a full task; human reviews the plan *and* the diff | `plan-first` plans; the check runs green; `verify-change` evidence | + `plan-first`, `verify-change`, `.harness/check` |
| 2 — **Gated** | Agent works semi-attended; human reviews the plan and the *review*, not every line | Fresh-context `code-review` + `security-reviewer` on every change; rubric MG1–MG7 | + `agents/`, `rubrics/code-review.md`, stop-verify-gate |
| 3 — **Delegated** | Agent runs on-the-loop (human samples); parallel sessions/worktrees | Adversarial verification of plans (`spec-readiness`); stop-gate blocking "done"; lane provenance on every merge | + `adversarial-verifier`, `models/routing.yaml`, worktree-per-agent |
| 4 — **Unattended** (not shipped in v0) | Loops run without a human present | Sandbox (container/microVM) + comprehensive tests + rollback + cost limits, all four | see [thin-spots.md](thin-spots.md) — deliberately deferred |

Movement rules:
- **Per task and per person, not global.** A team sits on different rungs for different
  work: rung 3 for well-tested CRUD, rung 1 for payments — and each engineer climbs at
  their own rate. Never set an org-wide "we are rung 3 now."
- **A rung is earned by evidence**: N consecutive tasks at the current rung with no
  P1 escaping to review. It's *lost* the same way — an escaped defect drops that work
  category one rung until the missing check exists (that's a `compound-learnings`
  entry: what guard would have caught it?).
- **Irreversible actions never climb.** Deploys, migrations on real data, force-pushes,
  external communications stay human-approved at every rung. The `guard-destructive`
  hook encodes the floor conservatively: every plain `git push --force`/`git push -f`
  is blocked, including feature branches. `--force-with-lease` remains available;
  `HARNESS_ALLOW_DESTRUCTIVE=1` is the explicit-approval escape hatch.

## The isolation ladder (runs alongside)

Match isolation to rung, not paranoia to everything:

| Rung | Minimum isolation |
|---|---|
| 0–1 | Permission rails (the adapter's allowlist/deny rules) |
| 2 | + devcontainer or equivalent (agent can't touch the host) |
| 3 | + git worktree per agent/session (parallel work can't collide); branch protection on `main` |
| 4 | + disposable sandbox (container/microVM), network egress policy, spend caps |

## Onboarding a team (the enablement pattern)

1. **Place, don't train.** Assess where each engineer actually is (do they review agent
   diffs? do they have a check? do they plan first?) and hand them the *one or two*
   components that unlock their next rung — not the whole pack.
2. **Make the infrastructure the standard, not the tool.** Guards, contracts, review
   gates, and lanes apply whichever runtime an engineer prefers (see `adapters/`).
   Tool pluralism with policy centralism survives ecosystem churn.
3. **Weekly compounding review.** Ten minutes: what went into the error ledger, which
   entry graduates into a hook/lint, which skill misfired and gets rewritten. This
   meeting is the harness improving itself; skip it and the pack goes stale.
4. **Measure escapes, not usage.** The KPI is defects escaping the review gate and
   time-to-verified-merge — not "how many agent sessions ran."
