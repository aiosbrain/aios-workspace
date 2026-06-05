# Dynamic-Workflow Harnesses — Design Study

The skills in `scaffold/.claude/skills/` are **dynamic multi-agent workflow
harnesses**: instead of asking one agent to do a whole task in one context, they
spawn focused sub-agents and add an independent verification stage. This doc records
what we learned building and A/B-testing them — single-pass skill vs. harness, on
identical inputs — so contributors know *when* a harness helps and *how* to build one.

## The failure modes harnesses fix

A single long-running context degrades in three ways on big, parallel, adversarial
tasks:

- **Laziness** — declares done after partial progress (handles 20 of 50 items).
- **Self-preferential bias** — trusts its own findings when asked to verify them.
- **Goal drift** — loses fidelity to the objective across many turns.

Harnesses counter these structurally: one agent per unit of work (earns coverage),
and a separate agent to verify (defeats self-bias).

## What the A/B study found

Four harnesses were each compared against a single-pass baseline on the same inputs,
scored by an independent judge.

| Workflow | Outcome | Lesson |
|----------|---------|--------|
| Decision-log audit | **Harness wins, decisively** | A single pass emitted many findings, ~80%+ false positives; adversarial verification cut them to a small verified set. One-verifier-per-rule made coverage *structural*, not asserted. |
| Scope-creep detection | **Harness wins on precision** | A binary keep/drop refuter drove false accusations to zero — but also discarded true positives. Fix: **re-grade severity** (out-of-scope → watch → in-scope) instead of keep/drop. |
| Transcript → decisions | **Tie on extraction; harness wins on pipeline** | Both extract equally well on a short transcript; the harness's value is automatic **dedup** + per-decision **grounding**, not raw recall. |
| Weekly synthesis | **Single-pass wins** | With no fidelity check, fan-out *amplified* one reader's hallucination into the headline. When sources fit one context, single-pass kept fidelity. (This harness is on the roadmap, to be rebuilt **with** a fidelity verifier.) |

**The deciding variable was always verification, not parallelism.** A fan-out without
an independent grounding step can do *worse* than a single pass.

## The conventions (also in skills/README.md)

1. **Adversarial verification is the value.** Any harness emitting findings/claims
   needs an independent `verify(claim, evidence) → {real, reason, severity}` stage.
2. **Re-grade severity, don't keep/drop.** Preserves precision *and* recall.
3. **Read shared context once; pass excerpts inline.** Every agent re-reading the same
   file is the dominant cost.
4. **Earn coverage structurally** — one agent per rule/item beats "check everything."
5. **Batch by group to control agent count.** Agent *count* × per-agent context
   overhead — not file size — drives token cost. (In one audit, batching verification
   by rule took a run from ~80 agents / millions of tokens to ~16 agents / a fraction
   of the cost, with coverage intact.)
6. **Keep each agent's structured output small** — a single agent asked to emit a large
   digest can stall.
7. **Gate by input size** — single-pass is cheaper and as good for small inputs.
8. **Synthesis needs a fidelity gate** — completeness ≠ correctness.
9. **`args` is a JSON string** — `JSON.parse(args)`.
10. **Read-only** — return data; the caller writes.

## Cost note

Harness runs cost meaningfully more than a single pass (often multiples). Use them
where the verification genuinely pays off — large or adversarial tasks, or where a
wrong answer is expensive — and keep single-pass skills for routine small work.

## Try it

Every harness ships with the synthetic `examples/sample-engagement/`, which is seeded
with deliberate issues. See that folder's README for the expected findings, and run a
harness with `repoPath` pointed at it.
