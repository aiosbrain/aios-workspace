# SEC4 — Ship pipeline isolation (AIO-157)

Parent: Pre-release security epic. Owner: john@john-ellison.com

## Why

Ship pipeline must isolate builder env, git fence, and log append (AIO-157).

## What

Merge AIO-157 and verify:
- `node --test test/build-fence.test.mjs` exit **0**
- `npm test` exit **0**

## Acceptance criteria

- AIO-157 merged to `main`.
- `node --test test/build-fence.test.mjs` exits **0**.
- Checklist row pass with PR link.
- `npm run aios -- spec eval docs/pre-ship/sec4-ship-pipeline-isolation.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** AIO-157 PR merged; tests green.
- **Operator verifies:** checklist row + confirm no open SEC4 blockers.

## Integration points

- `scripts/ship.mjs`
- `test/build-fence.test.mjs`

## Deps

**Blocked by AIO-157** until merge.

## Scope

AIO-157 merge + verify. Out of scope: pipeline rewrite.

## Build-with

Build-with: opus / medium.

## Testability

Named acceptance test:

```bash
node --test test/build-fence.test.mjs
grep -q 'build-fence\|AIO-157' docs/pre-ship/security-audit-checklist.md
```

Both exit **0**.
