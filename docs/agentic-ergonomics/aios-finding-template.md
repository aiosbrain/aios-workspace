---
# Findings are deterministic-gated like any spec; the drain PR later runs the full loop.
eval_tier: deterministic
spec_gate: block
safety: false
type: finding
---

# TITLE — the violated property, in one line

## What

<!-- The defect itself: repo + file:line and the exact observable — a failing command,
     a wrong output, a missing file, a scanner verdict. -->

(TODO: `path/to/file.ts:NN` — what is wrong)

## Evidence

<!-- How it was reproduced and on which commit of origin/main. Fetch first; a stale
     local checkout is not evidence. A finding without a reproduction is det:unverified. -->

(TODO: command run, observed output, and the `origin/main` sha it reproduced on)

## Failure scenario

<!-- Concrete, not theoretical: who hits this and what they see. -->

(TODO: the concrete way this bites)

## Suggested fix

<!-- Direction, not a mandate — leave latitude to the drain PR. -->

(TODO: suggested direction, citing any sibling fix to mirror)

## Classification

<!-- Applied as LABELS at file time — one per dimension; repeat fence:* if several
     apply. Canonical vocabulary + queries: aios monorepo docs/finding-taxonomy.md.
     File with:
       aios linear create "<title>" --template finding \
         --label finding --label repo:<r> --label defect:<c> \
         --label sev:<s> --label det:<d> --label fence:<f>
     sev:* maps 1:1 onto the consolidate-findings vocabulary
     (aios-devtools scripts/severity.mjs: Critical/High/Medium/Low). -->

- repo: (TODO)
- defect: (TODO: logic | security | gate-integrity | test-integrity | verifiability | contract-drift | docs | perf)
- sev: (TODO: critical | high | medium | low)
- det: (TODO: deterministic | flaky | unverified)
- fence: (TODO: none, or every fenced surface the fix crosses)

## Provenance

<!-- Which consolidate-findings run, code-review-<slug>.md artifact, or reviewer found
     this, and when. Findings deliberately left out of a PR's scope say so here. -->

(TODO: source artifact / reviewer, date)
