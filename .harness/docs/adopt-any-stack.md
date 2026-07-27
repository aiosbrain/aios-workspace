# Adopting the harness on any stack

The pack is stack-agnostic by construction: skills and rubrics are methodology, hooks
are POSIX shell keyed on file patterns, and the contracts (`AGENTS.md`,
`CONSTITUTION.md`) are templates you fill. Adapting to a stack means answering five
questions and writing the answers into the contracts.

## The five questions

1. **What is "the check"?** The single command that proves work is good — the most
   important line in the whole adoption.
   - TypeScript: `npm run lint && npm run typecheck && npm test`
   - PHP: `composer lint && vendor/bin/phpstan && vendor/bin/phpunit` (or `vendor/bin/pest`)
   - Python: `ruff check . && mypy . && pytest`
   Write it into `AGENTS.md` (Commands + Verification) and `.harness/check` (the
   stop-gate). No check = no autonomy; if the repo has no test suite yet, the *first*
   harness task is creating one, however small.
2. **What must agents never touch?** Env files, lockfiles, migrations, generated code,
   vendored code — plus your specifics (payment code? auth?). Write them into
   `.harness/protected-paths.txt` and `AGENTS.md` Boundaries.
3. **What does "good" look like here?** Name one exemplar file per major component kind
   in `AGENTS.md` Conventions ("copy `src/api/users.controller.ts` for a new
   controller"). Agents imitate far better than they obey.
4. **How are DB changes made?** The highest-risk stack-specific policy. Usually:
   migrations only via the generator (`prisma migrate` / `artisan make:migration` /
   `alembic revision`), never hand-edited — protect the migrations dir and state the
   generator command in `AGENTS.md`.
5. **What formatter is law?** The `post-edit-format.sh` hook auto-detects prettier /
   ruff / black / pint / php-cs-fixer / gofmt / rustfmt. Make sure the repo actually
   ships its formatter config so "formatted" is deterministic.

## Order of adoption (a team, an existing repo)

1. **Day 1 — contracts + guards.** `AGENTS.md` (the five answers above),
   `CONSTITUTION.md`, the three guard hooks. Zero workflow change; pure safety net.
2. **Week 1 — the check + verify-change.** Wire `.harness/check`; engineers start
   ending agent tasks with `verify-change`. If tests are thin, this is where that debt
   becomes visible — good.
3. **Week 2 — plan-first + code-review.** Non-trivial work starts in a plan the human
   reviews; agent-authored diffs get a fresh-context review. This is the biggest
   quality jump in the whole pack.
4. **Week 3+ — the compounding flywheel.** `compound-learnings` after every corrected
   mistake; the error ledger grows; hooks graduate out of it. Enable the stop-gate for
   engineers who've earned longer leashes. Introduce lanes (`models/routing.yaml`)
   only after the review gate is habitual.

Don't switch everything on at once — see [autonomy-ladder.md](autonomy-ladder.md) for
why and for the per-engineer rollout.

## Monorepos / multi-stack repos

One `AGENTS.md` at the root for shared facts; nested `AGENTS.md` files per
package/service for stack-specific commands (most runtimes merge them nearest-first).
Hooks and protected paths are defined once at the root — patterns are path-based, so
one list covers all stacks.
