---
kind: rubric
applies_to: operator-loop-c8
budget: 0
pass: no-must-fails
---

# Rubric — Operator Loop C8 (telemetry + dogfood instrumentation)

Machine-checkable success criteria for C8, the loop telemetry layer. Constitution §2: success
criteria live here, never invented ad-hoc inline. This is the must-pass contract AND the grading
sheet the independent validators score the diff against (receiving only this rubric + the diff +
the C8 acceptance criteria in `docs/v1-operator-loop/c8-telemetry.md`).

`budget: 0` — C8 is deterministic instrumentation + a pure reducer; no LLM, no correction loop. Its
core principle: **telemetry observes, it never gates the loop** (with one intentional exception,
T9), and it **never shows a false green** — degraded data degrades the metric to `met: null`.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| T1  | The ledger is local-only + admin-tier: `.aios/loop/telemetry/events.jsonl` (outside `sync_include`, gitignored, never pushed); every event is tagged `tier:"admin"`; `aios loop telemetry` is owner-only with no audience-safe projection | grounding-read | yes |
| T2  | Recording is best-effort and NEVER breaks a loop run: `recordEvent` swallows all I/O errors and no-ops when disabled; `AIOS_LOOP_TELEMETRY` in {0,off,false,no} (trimmed, lower-cased) disables it; on by default otherwise | code-read | yes |
| T3  | The reader NEVER silently drops a non-empty line: `readEvents` returns `{events, warnings}`; malformed JSON, `v!==1`, and missing-required-field lines each produce a `ParseWarning` (with a line number, and a `runId` when the line still exposes one) | code-read | yes |
| T4  | Cross-event facts are semantic, not parse-level: an orphan `weekly.approve` (no matching in-window `weekly.run`) is detected in `computeMetrics` as a semantic warning carrying `runId`+`at`+`detail`, and is excluded from acceptance + wall-clock | code-read | yes |
| T5  | Degraded data → `met:null`, never a false green: an unattributable corrupt line nulls `tierLeakCount` and `consecutiveCleanWeeklies` globally; a warning attributable to a run degrades ONLY that run (excluded from verifier/acceptance/wall-clock, breaks its streak) and does not null the global leak metric | grounding-read | yes |
| T6  | The six exit-criteria metrics are computed to the definitions in `c8-telemetry.md`: tier-leak count (`==0`, surfaced first), wall-clock median (`<20`, ritual span `earliest approve.at − run.startedAt` with CLI-duration fallback), verifier shippable rate (`≥0.90` per completed run), next-week-action acceptance (`≥0.70` of approval-decided runs), daily-run frequency (majority of Mon–Fri working days), consecutive clean weeklies (`≥3`) | grounding-read | yes |
| T7  | Deterministic grouping: weekly-run groups are keyed by `runId` and ordered by `weekly.run.endedAt` (not JSONL order); a run is "clean" only when it completed without failure, every requested audience is non-failed & shippable, and every shipped digest has `tierLeak:false` | code-read | yes |
| T8  | Approval semantics: `weekly.approve` is emitted ONLY from a non-preview, non-`--dry-run` `aios loop writeback` (a bad/missing stamp `die`s before any emit); accepted actions are the DISTINCT UNION of `taskRowsWritten` row-keys across a stamp's approvals; a rejected/zero-write approval stays in the acceptance denominator with 0 accepted actions; a run with no approval is pending (excluded) | grounding-read | yes |
| T9  | Independent post-ship leak re-check: for each shippable digest `aios loop weekly` re-runs `hasLeak(digest, aboveAudienceStrings(manifest, audience))` on the written bytes; a detected leak is quarantined (`digest-<aud>.md` → `digest-<aud>.LEAKED.md`, unpromotable by C6), alarmed, and exits non-zero — the one intentional case C8 mutates a pipeline artifact | code-read | yes |
| T10 | Daily-run source honesty: `daily.run` is emitted ONLY from a real recording owner `aios loop daily` (not `--as`, `--no-record`, or `--manifest`); when the daily source is wired, 0 runs in the window is `met:false` (not `null`); a build without the source is `met:null` | code-read | yes |
| T11 | The dashboard surfaces the tier-leak metric FIRST and a data-quality banner when the ledger has unreadable lines; `aios loop telemetry` parses `--window <n>` (positive integer; default 14) and `--all` (mutually exclusive; invalid input `die`s) and exits non-zero when a real shipped tier-leak is on record | code-read | yes |
| T12 | C4/C6 contracts preserved: C6's fail-closed writeback exit codes and C4's side-effect-free `--manifest`/`--no-record` paths are unchanged; telemetry emission is additive and gated | code-read | yes |
| T13 | Cockpit rendering and any off-machine/M3 aggregate export are explicitly deferred (the pure reducer makes cockpit a later read-only consumer) | grounding-read | no |
