# SEC4 — Ship pipeline isolation (AIO-157)

Parent: Pre-release security epic. Owner: john@john-ellison.com

## Why

Ship pipeline must isolate builder env, git fence, and log append (AIO-157).

## What

Merge AIO-157 and verify:
- `node --test test/build-fence.test.mjs` exit **0**
- `npm test` exit **0**

## Acceptance criteria

- AIO-157 merged to `main`. If AIO-157 is not yet merged, the builder cannot run `test/build-fence.test.mjs` (it doesn't exist yet); instead, record `AIO-157 not merged — SEC4 blocked` in the checklist and stop. This is an operator-blocked gate, not a builder failure.
- `node --test test/build-fence.test.mjs` exits **0** (only after AIO-157 merge).
- Checklist row pass with PR link.

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
if [ -f test/build-fence.test.mjs ]; then
  node --test test/build-fence.test.mjs
else
  echo "AIO-157 not merged — SEC4 blocked" && exit 1
fi
grep -q 'build-fence\|AIO-157' docs/pre-ship/security-audit-checklist.md
```

The first command exits **0** only after AIO-157 merge (the file doesn't exist before merge, so the named test correctly blocks). The second exits **0** once a checklist row references build-fence or AIO-157.
