---
name: maturity-report
description: |
  Produce an AI-transformation maturity report + roadmap deliverable from the three AEM
  scopes — the individual (workstation), the codebase(s), and the team. Pulls the owner's
  placement, scores the relevant repos, folds in the team rollup if a brain is connected,
  and writes a client- or company-ready roadmap into 2-work/. Use when the user says
  "maturity report", "transformation roadmap", "AEM report", "assess our agentic maturity",
  or when preparing an engagement or team readout.
kind: skill
version: 1.0.0
triggers:
  - maturity report
  - transformation roadmap
  - AEM report
  - assess our agentic maturity
  - agentic maturity readout
---

# Maturity report

Assemble a single, honest AI-transformation readout from the three AEM scopes and write
it as a deliverable. The AEM model is canonical in `agentic-engineering-maturity/` (root)
and published at `/agentic`. Assess → place → prescribe, then package as a roadmap.

## Step 1 — Gather the three scopes

- **Individual (workstation):** read `.claude/memory/MATURITY.md`. If empty, run the
  `agentic-maturity` skill first (or `npm run aios -- analyze --since 30d --json` for a
  signal-based placement). Note the Spine level, axis scores, and weakest axis.
- **Codebase(s):** for each repo in scope, run
  `npm run aios -- assess-codebase <path> --json` and record level + % + the ranked gaps.
  (Use `--push` to also record it in the Team Brain.)
- **Team (if a brain is connected):** ask the brain for the rollup —
  `npm run aios -- query "what % of our repos are at agentic-readiness L3+ and which are lowest?"`
  — or read the Maturity dashboard. Skip gracefully if offline.

## Step 2 — Place + apply the cap

Summarize each scope's level. Apply the **verification cap** wherever it bites (Spine
held at L3 if verification is weak; a repo with no testing pillar can't exceed L3). State
the cap plainly — it is usually the highest-leverage finding.

## Step 3 — Prescribe (weakest-axis first)

For the individual, use `npm run aios -- learn` (maps the placement to patterns). For each
codebase, the gaps from `assess-codebase` ARE the backlog to reach the next level. For the
team, name the one or two systemic levers (shared evals, an AI stance, an internal platform
of skills) that move the most repos.

## Step 4 — Write the deliverable

Create `2-work/agentic-maturity-report.md` with `status: draft`, `owner`, and (for an
outward readout) `access: client`/`company`. Structure:

1. **Executive summary** — where they are in one paragraph + the single biggest lever.
2. **Scorecard** — a table: scope · current level · weakest dimension · target.
3. **Findings** — per scope, honest and specific (lead with the verification cap if it bit).
4. **Roadmap** — sequenced next steps, each tied to a concrete AEM pattern and an owner.
   Order by leverage: verification first, then context/automation, then orchestration.
5. **How we measure progress** — re-assess cadence (quarterly for people, per-PR for repos
   via `assess-codebase`, quarterly for the team) and the headline metric (% repos at L3+).

Keep it honest and non-inflating — a low placement stated plainly is more useful than a
flattering one. Cite the canonical model (`/agentic`) so the reader can self-serve.

## Quality bar

A real placement for every scope you could reach; the verification cap applied where it
bites; every roadmap item tied to a named pattern and an owner; the deliverable written to
`2-work/` with correct frontmatter (so the spine validators pass and it can be shared).
