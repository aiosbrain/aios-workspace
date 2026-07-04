# The Maturity Loop — weekly report + belts (`aios maturity-week`, AM6 / AIO-231)

**Status:** the weekly cadence layer of the Agentic Maturity Loop. Where AM2's SessionStart
brief (`hooks/maturity-brief.mjs`) nudges you on your weakest axis *each session*, the weekly
report shows **trajectory**: did your Spine level move, which axis gained, and exactly what
unlocks the next belt.

Sibling contracts: [`build-paradigm.md`](./build-paradigm.md) (how a slice ships),
[`rails.md`](./rails.md) (permission rails), and the domain spec
[`../v1-operator-loop/domains/maturity-loop.md`](../v1-operator-loop/domains/maturity-loop.md).
The scoring is the shipped AEM analyzer — five axes → Spine L1–L5 in
[`../../scripts/analyze/aem.mjs`](../../scripts/analyze/aem.mjs), coaching text in
[`guidance.mjs`](../../scripts/analyze/guidance.mjs).

---

## Weekly maturity snapshot

```bash
npm run aios -- maturity-week            # → 3-log/maturity/week-<ISO-MONDAY>.md
npm run aios -- maturity-week --json     # machine shape on stdout (no file written)
npm run aios -- maturity-week --out <p>  # write somewhere other than the default
npm run aios -- maturity-week --project <slug>   # override the project filter
```

- **Reads** AM1's local session store (`.aios/loop/maturity/sessions.ndjson`, written by the
  SessionEnd capture hook). Nothing is fetched and **nothing is pushed** — the output is a
  local **admin-tier** file (`access: admin` frontmatter) under `3-log/`, which never syncs.
- **Needs ≥ 5 captured sessions this week** for the project to give a placement; below that it
  writes an honest "insufficient data — N of 5" note rather than faking a read. The **prior
  week is optional** — with ≥ 5 sessions last week too you get level + per-axis deltas;
  otherwise this week's placement/belt still render and the deltas start next week.
- **Project filter:** sessions are tagged by the *session's* working-directory basename slug
  (same as AM2's brief), so a run from a subdir is scoped to that subdir. Pass `--project` to
  override.
- **Week boundary is UTC Monday** — consistent with the rest of the analyzer's UTC bucketing
  and the store's `ended_at`. The report filename is `week-<ISO-Monday>.md`.

### Belts

The Spine level maps to a belt so progression is legible: **L1 White · L2 Yellow · L3 Green ·
L4 Brown · L5 Black**, with a **🥷 Ninja Master** honorific at a perfect L5 (every axis 4/4).
The **next-belt** section lists the concrete signal moves that unlock the next level — and
because those thresholds are read straight from `aem.mjs`'s band constants (not a duplicated
table), what you're told to do is exactly what the scorer rewards. When you're at or under the
**verification gate** (the Spine caps at L3 without verification), the verification blocker is
listed first.

### Cadence

There is **no scheduler in this slice** — run it weekly by hand, from a cron job, or from a
Claude routine, e.g.:

```bash
# weekly, Monday morning
npm run aios -- maturity-week
```

Wiring a bundled scheduler (and the instinct-distillation / effectiveness-scoring stages of the
loop) is later AM work — see the domain spec's roadmap.
