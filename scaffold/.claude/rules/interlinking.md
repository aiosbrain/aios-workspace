# Rule: OKF Interlinking

Documents in this repo use markdown links to reference one another. Links form a
machine-traversable graph that agents can follow without a database query.

## Link format

Use path-relative markdown links:

```markdown
[Title](relative/path/to/file.md)
```

- From `02-deliverables/sprint-1/report.md` → `../../03-status/decision-log.md`
- From `03-status/index.md` → `decision-log.md`
- From `00-engagement/scope-baseline.md` → `../03-status/decision-log.md`

## Where to link

| Context | Convention |
|---------|------------|
| `index.md` files | `* [Title](path) — one-sentence description` |
| Prose citations | `(03-status/decision-log.md, #16)` — existing prose style |
| OKF-style citations | `([Decision #16](../03-status/decision-log.md))` |
| Cross-links in deliverables | Reference supporting documents inline |

## `index.md` is the agent entry point

Every numbered spine directory contains an `index.md` listing the key documents
in that directory. When an agent needs to orient itself in a directory, it reads
`index.md` first. When you add a significant document to a directory, add a link
to that directory's `index.md`.

## Citation style in synthesized outputs

When harnesses produce outputs (weekly-synthesis, decision-audit, etc.), cite sources
using the existing prose format `(relative/path, #row)` for rubric grounding checks.
For new OKF-aware outputs, use markdown links: `[text](path.md)`.

## Local graph traversal

Run `aios graph [--from <file>] [--depth N]` to see the link graph rooted at a file.
This is a fully local traversal — no brain required. Use `--format json` for
downstream tooling.

## Broken links

Links to files that do not yet exist are allowed — they mark future content (OKF
spec §5). `aios graph` reports broken links at the end of traversal output.
