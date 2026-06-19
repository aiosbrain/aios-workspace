---
name: agentic-maturity
description: |
  Place the workspace owner on the Agentic Engineering Maturity (AEM) model and give
  them a prescribed next step. Seeds objective signals from `aios analyze` (local
  session logs) when available, confirms with a short interview, applies the
  verification cap, writes the placement + journey to .claude/memory/MATURITY.md, and
  prescribes the highest-leverage patterns to practice next. Use when the user says
  "assess my agentic maturity", "level me up", "what should I learn next", "how good am
  I with AI", "rate my AI workflow", or on a periodic check-in to track progression.
kind: skill
version: 1.0.0
triggers:
  - assess my agentic maturity
  - agentic maturity
  - level me up
  - what should I learn next
  - how good am I with AI
  - rate my AI workflow
  - am I getting better at agentic engineering
  - my AEM level
---

# Agentic maturity self-assessment + journey

Place the owner on the **AEM Spine** (L1–L5) and score the five **Axes** (0–4), then
write a durable placement and prescribe the next patterns to practice. The model and
rubric are canonical in `agentic-engineering-maturity/` (root); this skill reads the
local copies: the scoring bands in `individual.rubric.json` and the pattern catalogue
in `curriculum.md` (both in this skill folder).

**Core rule (do not violate):** the Spine level is **capped at L3 if the Verification
axis scores ≤ 1**. No real agentic maturity without verification — say so plainly if it
applies.

**Asking (chat UI):** ask in **plain chat messages** — do NOT use the AskUserQuestion
tool (it can't render in the cockpit). Ask the confirmation questions as **one short
numbered batch** and invite a free-form reply.

## Step 1 — Seed objective signals (best effort)

Run the local analyzer to get signal-based scores from the owner's real session logs:

```bash
npm run aios -- analyze --since 30d --json
```

If it returns a placement, use its `placement.spine`, `placement.axes`, and
`placement.weakest` as the **starting hypothesis**. If no logs are found (new machine,
other tools), skip to the interview and place from answers alone — say which you used.

## Step 2 — Confirm with a short interview

Signals are a proxy; confirm and adjust. Ask these as one batch (answer in any order):

1. **Spine** — which is most true *under pressure* (not your best day)?
   read the five `spine[].placement` lines from `individual.rubric.json`.
2. **Verification** — when an agent finishes, how do you confirm it's correct?
3. **Context** — how do you manage what the model sees across a session?
4. **Autonomy** — how do you decide how much an agent does on its own?
5. **Learning** — when an agent makes a mistake, what happens next time?
6. **Cost/governance** — how aware are you of token cost and tier/permission discipline?
7. **Delegation** — roughly what % of your work is *delegated-and-verified* to agents?

Map each answer to a 0/2/4 band using the `axes[].bands` in the rubric. Reconcile with
the signal hypothesis; when they disagree, trust the interview but note the gap.

## Step 3 — Place + apply the cap

- Spine = the owner's reliable default mode, cross-checked against the signal level.
- Apply the **verification cap**: if Verification ≤ 1, hold the Spine at L3 (or below).
- Identify the **weakest axis** — it drives the prescription.

## Step 4 — Prescribe the next step

Look up the matching entry in `patternMap` (by spine, and weakest-axis when present),
then name the patterns from `patternTitles`. Read the matching section of
`curriculum.md` and give the owner **2–3 concrete patterns** to practise next, each with
the single first action they should take this week. Lead with the highest-priority one
(verification-first entries are marked `"priority": "highest"`).

## Step 5 — Write the durable record

Update `.claude/memory/MATURITY.md`:
- Set the **Current placement** block (date, Spine level + name, the five axis scores,
  weakest axis, whether the cap applied, and whether signals or interview drove it).
- Append a one-line **History** row so progression is visible over time.
- Set **Active journey** to the prescribed module + patterns.

Then tell the owner their placement in one tight paragraph, the one rule if the cap bit,
and their first action. Offer to re-check in a few weeks (progression shows in History).

## Quality bar

Before finalising, self-check against `.claude/rubrics/agentic-maturity.md`: the cap was
applied correctly, the prescription targets the weakest axis, and MATURITY.md was
actually written. Revise until it passes.
