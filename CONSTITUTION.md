# Engineering Constitution

> The pinned engineering contract for this repository. Agents ingest the digest below
> every session; humans change the principles here **first**, then build. Adapted from
> the AIOS toolkit's Engineering Constitution (itself drawing on
> [GitHub Spec Kit](https://github.com/github/spec-kit)'s Spec-Driven Development).
>
> **Template note:** sections marked `TODO` are yours to fill for your repo/stack.
> Everything else is deliberately stack-agnostic.

---

## 1. Spec before code

Every non-trivial change follows **spec → plan → tasks → implement**:

1. **Spec** — a short document stating *what*, *why*, and the **acceptance criteria**.
   No greenfield code starts without one.
2. **Plan** — the implementation approach: modules touched, interfaces, trade-offs.
   The plan — not the diff — is where human review has the most leverage: a bad line
   in a plan becomes hundreds of bad lines of code.
3. **Tasks** — broken into tracker issues, each linking back to its spec.
   (`TODO: name your tracker and issue convention`)
4. **Implement** — built against the spec; its acceptance criteria are the definition
   of done. Code that drifts from its spec is a bug in one of them.

Spec readiness is checkable: grade a spec against [`rubrics/spec-readiness.md`](rubrics/spec-readiness.md)
before a builder (human or agent) picks it up.

## 2. Rules and rubrics are the success criteria

Conventions live in `AGENTS.md` and the rules files; machine-checkable success criteria
live in `rubrics/`. A new feature either reuses an existing rule/rubric or adds one —
it never invents ad-hoc success criteria inline.

## 3. Verification is the value

Trust comes from verified output, not speed or parallelism.

- Every task has **a check the agent can run itself** — tests, a build, a lint, a
  screenshot diff, a reproduction script. No check, no autonomy.
- Agent-authored changes pass a **fresh-context review** (a reviewer that didn't write
  the code) before merge. Output from non-frontier models *always* passes a review gate.
- Never weaken a guard, hook, or validator to make something ship.

## 4. The autonomy ladder

Autonomy is earned, not granted. Dial the leash per task and per risk:
human-in-the-loop for risky/irreversible actions; on-the-loop for routine work behind a
verification gate; off-the-loop only where a strong check makes it safe. Lengthening the
leash always means strengthening the check first. (See `docs/autonomy-ladder.md`.)

## 5. Compounding is mandatory

The last step of every task is codification: a mistake becomes a lint rule, hook, or
`AGENTS.md` line; a discovered procedure becomes a skill; a repeated command becomes a
script. Work that doesn't compound is work you'll pay for again.

## 6. Simplification bar

- Prefer deleting code to adding it.
- No new dependency without a stated reason.
- No abstraction before the second concrete use (YAGNI).
- Cleanup passes are behavior-preserving, stay inside the changed hunks, and are gated
  by re-running the checks.

## 7. Stack rules (yours)

`TODO:` state your language/framework versions, module-boundary rules, error-handling
conventions, and anything an agent must never touch (payments, migrations, auth).
Keep it short — every line here costs context every session.

---

## Agent digest

The block below is the machine-read distillation of §1–7. Inject it into every
plan/build/review prompt (a `SessionStart` hook, a rules-injector plugin, or your
pipeline's prompt assembly). When a principle above changes, update the digest in the
same commit. Keep it ≤ 30 lines.

<!-- agent-digest:start -->
- Spec before code: non-trivial changes follow spec → plan → tasks → implement; the
  spec's acceptance criteria are the definition of done. Review effort goes into the
  plan, not just the diff.
- Success criteria live in AGENTS.md rules + rubrics/. Reuse or extend one — never
  invent ad-hoc success criteria inline.
- Verification is the value: every task has a check the agent can run itself;
  agent-authored changes pass a fresh-context review before merge; non-frontier model
  output always passes a review gate; never weaken a guard/hook/validator to ship.
- Autonomy is earned: lengthening the leash always means strengthening the check first.
  Risky or irreversible actions stay human-in-the-loop.
- Compound every task: mistakes become guardrails (lint/hook/AGENTS.md line), procedures
  become skills, repeated commands become scripts.
- Simplification bar: prefer deletion; no new dependency without a stated reason; no
  abstraction before the second concrete use; cleanup passes are behavior-preserving and
  check-gated.
<!-- agent-digest:end -->
