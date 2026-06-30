The heavy weekly cadence — the verified deliverable and the payoff the daily loop builds toward.

**Flow:** full 7-day C1 manifest → draft **two** artifacts → C3 verifier + correction → present for approval → propose next-week actions.

**Two artifacts from one run:**
- **Private operator brief** (admin-tier, owner only) — the honest internal picture: everything, including private notes.
- **Shareable digest** (team / external-safe) — tier-filtered, every claim backed by the C2 ledger, passed through the C3 verifier.

**What must feel magical (roadmap M1):**
- The user recognizes their *actual* week, not a generic summary.
- It catches something they'd have missed: a stale blocker, an unlogged decision, an unowned next action, an unsafe-to-share note.
- They trust the digest because they can inspect evidence + redactions + verifier status.
- They finish with concrete next-week actions, not just a recap.

**Acceptance:**
- One run emits both artifacts at the correct tiers; verifier status visible before any approval.
- Next-week actions are produced and can be approved (feeds C6 writeback + C7 carry-over).
- Median closeout < 20 min after setup (exit criterion).
- Runs from CLI and cockpit against the same plan/review/approve model.

---

## Implementation (CLI)

`aios loop weekly` runs the closeout from the CLI:

```
aios loop weekly                       # owner brief + team digest (offline, default)
aios loop weekly --as external         # owner brief + NDA-safe external digest
aios loop weekly --all                 # owner brief + BOTH shareable digests
aios loop weekly --remote              # enable the LLM drafter (see consent below)
aios loop weekly --json                # audience-safe machine output (no brief content)
aios loop weekly --manifest <path>     # verify against a saved manifest
aios loop weekly --dry-run             # preview, write nothing
```

Artifacts land under `.aios/loop/closeouts/<stamp>/` (outside `sync_include` — never synced; C6
owns approval→writeback into the spine):
- `brief.md` + `next-week-actions.json` — **owner-only** (admin-tier; the honest internal picture).
- `digest-<audience>.md` + `verifier-<audience>.json` — **shareable**, written ONLY when the
  verifier passes/corrects and the leak sweep is clean. A non-shippable run writes a clearly-marked
  `digest-<audience>.FAILED.md` for inspection (never referenced as an approved artifact) and exits
  non-zero.

### Remote LLM drafting — egress consent

C5 is the loop's first off-machine step, so it honours the workspace's local-first invariant
(*nothing leaves the machine until `aios push`*) with an explicit consent model:

- **Offline by default.** Without `--remote`, a deterministic stub drafter (one grounded claim per
  signal) produces valid artifacts and prints a visible "LLM synthesis skipped" notice. Nothing
  is sent anywhere.
- **`--remote` is the explicit egress consent** and requires `ANTHROPIC_API_KEY` (it fails loud
  otherwise). It authorises sending **only the target audience's projection** to Anthropic.
- **The drafter input is tier-bounded.** For a `team` digest the drafter sees only team+external
  signals; for `external`, only external. **Admin-tier content — and the default-deny `excluded`
  log — never leave the machine for any artifact.** The private owner brief is composed locally
  and never runs an LLM on admin content.
- **Tier-safety is deterministic, not a model judgment.** Because the drafter only ever sees
  ≤-audience signals, every claim it can cite is allowed-evidence-only (mixed-tier claims cannot
  form). The C3 verifier independently re-checks every ref, and a deterministic C5 text-leak sweep
  withholds any claim/action whose *text* quotes an above-audience signal — the one case C3's
  ref-level checks do not cover. No LLM "yes" is ever part of the tier gate.

Default drafter model: `claude-opus-4-8` (the latest Claude); swap to a cheaper tier as volume/cost
scales.