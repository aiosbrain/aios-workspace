Make the epic's exit criteria measurable instead of vibes. Without this we can't tell if V1 is actually done, and it's the substrate M3 needs (cost/quality telemetry).

**Instrument per run:**
- Weekly closeout wall-clock time (→ median < 20 min).
- Verifier pass / corrected / fail rate (→ ≥90% must-pass on accepted runs).
- Tier-leak check: any admin/private content in a shareable digest = critical failure, count = 0.
- Next-week-action acceptance rate (→ ≥70%).
- Daily-loop run frequency across the dogfood window (habit signal).

**Privacy constraint (open roadmap question):** collect this **locally** — how much telemetry can we keep without violating AIOS's local-first posture? Default to on-device aggregates; nothing leaves without the same approval gate as C6.

**Acceptance:**
- A local dogfood dashboard / report shows the six exit-criteria metrics across runs.
- Tier-leak count is surfaced prominently (it's the one that's product-ending).
- Enough signal to declare each AIO-122 exit checkbox met or not.

Runs continuously through dogfood, not a one-shot task.

---

## Implementation (CLI)

C8 is **horizontal instrumentation** of the existing C4/C5/C6 flow plus a pure reducer — not a
new domain. The loop already writes its artifacts locally; C8 appends an event ledger and reads
it back into a dashboard. Core in `src/operator-loop/telemetry.ts`; wired into `scripts/aios.mjs`.

```
aios loop telemetry [--json] [--window <days>] [--all]
```

Renders the six exit-criteria metrics across recent runs. **Tier-leak count is printed first**
(red when > 0 — the one product-ending metric); a data-quality banner follows whenever the ledger
has unreadable lines. `--window <days>` sets the lookback (positive integer; **default 14**),
`--all` aggregates the whole ledger (the two are mutually exclusive). Exit code is `2` when a real
shipped tier-leak is on record, else `0`. **This is an owner-only surface** — it reads admin-tier
operational data and has no audience-safe projection (unlike `aios loop weekly --json`).

### Local-first decision (resolves the open roadmap question)

Telemetry is **purely local, no egress** in V1. The store is
`.aios/loop/telemetry/events.jsonl` — under `.aios/loop/` like manifests / continuity / closeouts,
so it is gitignored, outside `sync_include`, and **never pushed**. Every event is tagged
`tier: "admin"`. There is no off-machine path; a future M3 aggregate export would be added behind
its own C6-style approval gate, not here. Recording is **on by default**; set
`AIOS_LOOP_TELEMETRY=0` (`off` / `false` / `no`, case-insensitive) to disable it.

### Event ledger

Append-only JSONL, one self-describing event per line (`v` version, `tier:"admin"`, `runId` =
the closeout/manifest stamp, `kind`, `at`, `member`, `project`, `payload`). Emitted at the loop's
natural points (all skipped under `--dry-run`, gated by the opt-out):

| Kind | Emitted by | Feeds |
|------|------------|-------|
| `daily.run` | `aios loop daily` (real recording owner run only; not `--manifest` / `--no-record`) | daily-run frequency |
| `weekly.run` | `aios loop weekly` (CLI span + requested audiences) | wall-clock (CLI fallback) |
| `weekly.verify` | `aios loop weekly`, per shareable | verifier pass/corrected/fail rate |
| `weekly.shipped` | `aios loop weekly`, per shippable digest (independent post-ship leak re-check) | tier-leak count |
| `weekly.approve` | `aios loop writeback` (successful, ≥1 target; carries `taskRowsWritten` row-keys, `wroteCount`, `tierSafetyWithheld`, `exitCode`) | wall-clock (ritual span), next-week-action acceptance |

### Measurement definitions (how each exit criterion is computed)

- **Wall-clock** = ritual span `earliest weekly.approve.at − weekly.run.startedAt`; runs with no
  approval yet fall back to the CLI command duration, labelled as a proxy. Metric = median.
- **Verifier rate** = completed weekly runs whose every requested audience is non-failed & shippable,
  over completed weekly runs (≥ 90%).
- **Tier-leak count** = shipped digests where C8's independent re-check finds admin content (must be
  0). If that ever fires, `aios loop weekly` quarantines the digest to `digest-<aud>.LEAKED.md`
  (unpromotable by C6), alarms, and exits non-zero.
- **Next-week-action acceptance** = approval-decided runs whose distinct-union `taskRowsWritten`
  (by `row_key`, across a stamp's approvals) is non-empty, over approval-decided runs (≥ 70%). A
  rejected / zero-write approval stays in the denominator; a run with no approval is pending.
- **Daily-run frequency** = distinct working days with a real `daily.run`, over Mon–Fri days in the
  window (≥ majority).
- **Consecutive clean weeklies** = longest tail streak of clean weekly runs (≥ 3). A run is clean
  when it completed without failure, every audience is non-failed & shippable, and no shipped digest
  leaked.

Metrics degrade to `met: null` (never a false green) when the ledger's data quality can't support a
trustworthy result — an unattributable corrupt line nulls the tier-leak and streak metrics; a
corrupt line attributable to a specific run degrades only that run's metrics.