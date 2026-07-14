# V1 Operator Loop synthetic evidence — 2026-07-14

## Result

One disposable consultant workspace completed the daily and weekly paths without network egress.
Both shareable audiences passed verification, the two written digests recorded zero tier leaks,
and approval wrote one team-tier next-week action. The run proves the mechanics; it does not meet
the three-week or multi-day human-adoption criteria.

| Evidence | Result |
|---|---|
| Fresh scaffold validation | exit 0; warnings only for optional metadata |
| Daily recording run | exit 0; 1 recorded synthetic day |
| Weekly closeout | exit 0; real 0.28 seconds |
| Team verifier | pass; 5 checked claims; 0 corrections |
| External verifier | pass; 0 visible claims; 0 corrections |
| Leak-withheld | 0 |
| Shipped tier leaks | 0 across 2 digests |
| Writeback | local + sync + PM approved; 3 files + 1 task row |
| `aios push --dry-run` | exit 0; 13 eligible items, 3 admin memory files blocked |
| Live push | not run |

## Release gates

| Gate | Result |
|---|---|
| `npm run check:v1-linear` | exit 0; C1–C8 Done and no stale AIO-130 blocker |
| CQ3 spec evaluation | `SPEC_READY`, score 100, exit 0 |
| `npm run check:docs` | exit 0 |
| Operator Loop tests | 512/512 pass |
| Secret scan / leak gate | both exit 0 |
| `npm run build:loop` | **blocked:** duplicate `InboxEvent` / `InboxEventKind` exports |
| `npm test` | **blocked:** stops at the same `build:loop` compilation error |

The Inbox compile failure is outside this read-only close-out lane and remains a tag blocker; no
Unified Inbox implementation was changed here.

## Reproduction

The disposable workspace was `/tmp/aios-v1-dogfood-20260714`, scaffolded with synthetic identities
and content. Commands ran from the release-hygiene worktree under Node 22:

```text
validation/validate-all.sh /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop daily --record --no-connectors --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop collect --daily --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop collect --weekly --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop weekly --all --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop writeback 2026-07-14T11-18-55-199Z --local --sync --pm --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs loop telemetry --all --json --repo /tmp/aios-v1-dogfood-20260714
node scripts/aios.mjs push --dry-run --repo /tmp/aios-v1-dogfood-20260714
```

The first writeback rehearsal exposed two C6 compatibility defects: it ignored the scaffold's
`tasks-team.md` split and serialized a team-tier title into an external-safe JSON payload. Both are
covered by the release-hygiene tests and the final writeback evidence reflects the repaired path.

## Artifact integrity

```text
brief.md               e8d92a235cc10b6f585acc42c9a305fe7461f34529fa8cc18786ebf0bc75e2ee
digest-external.md     65686385e0cc4043fa4c97362a8766484f760abcd475c86bbb83ef8d23fe8b59
digest-team.md         99312d42c589f109a87967fa7db5656812f506f139b4b8643b0ea7398069dc0c
manifest.json          6c3cb6682f72a2c45fc88a4523e93c070a39cff0d3edaf6e457983a169cda6ce
next-week-actions.json 2b067468400fab47477af094993cccf0b211b1693cc59e6d35d48db0ed472428
verifier-external.json e5341f2814e5cbe14e1334e39b0271dfe800c82ffcf60d5b3d1e915b76756677
verifier-team.json     f1804d79d06f71034e426576f20f5a2ca6df76eff4b35af6ea997f762f2f0c24
```

The synthetic private canary had zero matches in the closeout directory, promoted digests, or
team task table. One untagged hours row was default-denied and recorded in the exact manifest.

See [status-reconciliation.md](./status-reconciliation.md) for code/Linear claim evidence and
[release-verdict.md](./release-verdict.md) for the tag recommendation.
