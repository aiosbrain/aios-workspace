# Devtools migration, preflight and rollback (AIO-665)

The devtools command set — `ship`, `build`, `roadmap-run`, `spec-eval`, `consolidate-findings`
— left this repo in AIO-662. This is the operator-facing consequence: what changed, how to check
your install is sound, and how to get back if it isn't.

Seam contract: `docs/devtools-toolkit-contract.md`. Dispatch: `scripts/devtools-dispatch.mjs`.

## What changed

`@aiosbrain/aios-devtools` is a **pinned dependency** of `@aiosbrain/aios`, so
`npm i -g @aiosbrain/aios` still gives you all five commands. Nothing to do for a normal install.

The pin is exact (`0.2.0`, not `^0.2.0`) on purpose: these commands drive an agent pipeline whose
output is reviewed and merged, so "whatever was latest that day" is not an acceptable answer to
"what reviewed this diff". Bumping it is a deliberate PR, and `scripts/devtools-preflight.mjs`
fails if it is loosened to any range, wildcard, tag, workspace alias, or local path.

## Bumping the pin (paired core + devtools changes)

Anything that changes **loop-model routing** (`scripts/loop-models.mjs`, `scripts/model-call.mjs`,
`scripts/model-providers.mjs`) exists in both repos. Core's test suite cannot prove `aios spec eval`
or `aios ship` behaviour, because those dispatch into the *published* devtools — so a core-only
change to a shared module ships a config surface that the runtime rejects. `<step>_preset` is the
worked example: devtools 0.2.0's `KEY_RE` has no `preset`, so `spec_eval_preset:` in
`.aios/loop-models.yaml` aborts every devtools command with `unknown key`, not just that step.

Order of operations, and it is not optional:

1. Land the devtools companion PR and publish it (`npm publish` from `aios-devtools`).
2. In core, bump the pin **and** the lockfile together — the lockfile integrity hash can only come
   from the registry, so this step is impossible before step 1:

   ```bash
   npm pkg set dependencies.@aiosbrain/aios-devtools=0.2.1
   npm install --package-lock-only
   npm run check:devtools        # declared and installed must both read 0.2.1
   ```

3. Only then merge the core PR.

Merging core first ships a broken config surface to every operator on the current pin.

## Preflight

```bash
npm run check:devtools          # or: node scripts/devtools-preflight.mjs [--json]
```

Exit 0 when all five dispatch targets resolve, 1 otherwise. It runs as part of `test:prepare`, so
a broken devtools dependency fails before the suite rather than as a confusing test error.

It reports **which source is live**, which matters more than a pass/fail: the same command can
resolve four different ways.

```
devtools: @aiosbrain/aios-devtools
  declared:  0.2.0
  installed: 0.2.0
  ✓ ship                   via @aiosbrain/aios-devtools
  ✓ build                  via @aiosbrain/aios-devtools
  ...
```

> The first version of this preflight reported ✓ with the package uninstalled —
> `resolveDevtoolsModule()` only *builds* a specifier string and never checks the target exists.
> It now actually resolves. `test/devtools-preflight.test.mjs` pins that case first, because a
> preflight that cannot detect the one condition it exists to detect is worse than none.

## Resolution order

1. `--devtools-dir <path>`
2. `AIOS_DEVTOOLS_DIR`
3. an in-tree `scripts/<name>.mjs`, if one exists (dormant in this repo since AIO-662)
4. the installed `@aiosbrain/aios-devtools`
5. an actionable error

An **explicit** source (1 or 2) that doesn't resolve is a hard error — it never silently falls
back to something that happens to work, because running different code than you asked for is
worse than failing.

## Contributor flow: an adjacent checkout

Working on devtools itself:

```bash
git clone git@github.com:aiosbrain/aios-devtools.git ../aios-devtools
export AIOS_DEVTOOLS_DIR=../aios-devtools
aios ship AIO-123
npm run check:devtools          # confirms: "via AIOS_DEVTOOLS_DIR"
```

The preflight naming the source is the point — "it works" and "it works, from your local checkout
rather than the pinned release" are different answers, and only one of them is reproducible.

Note the reverse direction too: devtools reaches core-staying engines through
`AIOS_TOOLKIT_DIR`. Running devtools from `node_modules` without it produces
`cannot locate the AIOS toolkit … (via containing-repo)` — the containing-repo fallback resolves
to the package directory, not the consuming toolkit. Most paths degrade gracefully (advisory
warning, work continues); set `AIOS_TOOLKIT_DIR` to silence it.

## Missing devtools

Verified behaviour, not intent:

| Command | Without devtools |
|---|---|
| `aios help`, `aios status`, everything else | **unchanged** — identical exit codes and output |
| `ship`, `build`, `spec`, `roadmap-run`, `consolidate-findings` | one actionable error naming the install, the checkout override, and the rollback |

The five fail individually. The CLI does not refuse to start, because a missing optional
dependency for five commands is not a reason to take the other forty down.

```
error: the 'spec' (spec-eval) command lives in @aiosbrain/aios-devtools, which is not installed
  Install it:             npm i @aiosbrain/aios-devtools
  Or point at a checkout: AIOS_DEVTOOLS_DIR=<path-to-aios-devtools>
```

The error names the command **you typed**, not the module it resolves to — `aios spec` loads the
`spec-eval` module, and being told your "'spec-eval' command" is missing sends you looking for a
command that does not exist.

## Rollback

```bash
npm i -g @aiosbrain/aios@0.9.1
```

`0.9.1` is the last release carrying the in-tree implementations. It needs no devtools package and
no environment variables.

Rolling back is a **downgrade of the whole toolkit**, not just devtools — you also lose everything
else that shipped after 0.9.1. If the problem is only devtools resolution, prefer
`AIOS_DEVTOOLS_DIR` pointing at a known-good checkout, which leaves the rest of the toolkit current.
