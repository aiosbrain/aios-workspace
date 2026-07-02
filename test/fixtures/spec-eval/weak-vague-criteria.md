# Spec — improve the `aios spec eval` output

## Why

The findings block is hard to scan. We want it to read better so operators trust it.

## What

Reformat the findings block printed by `scripts/spec-eval.mjs`.

## Acceptance criteria

- It works well.
- It is fast.
- It feels clean and reads nicely.

## Integration points

- `scripts/spec-eval.mjs` — the `formatFindings` helper.

## Deps

Deps: none.

## Scope

In scope: the formatter. Out of scope: color themes.

## Build-with

Build-with: opus / medium effort.
