# Terminal presentation

The human presentation layer covers workspace onboarding, connector prompts, status,
and normal item push/pull. It uses selected TermCN Ink sources pinned in
`src/terminal/vendor/provenance.json`; the MIT license and provenance travel in the
packed distribution. No component registry is contacted at runtime.

## Operation

Supported human terminals activate the renderer automatically. `AIOS_UI_TIER=plain`
uses legacy output and prompts. Existing `AIOS_UI_MOTION=0`, `AIOS_UI_GLYPHS=ascii`,
`AIOS_UI_WIDTH`, and `AIOS_UI_BG=light|dark` controls flow through the shared capability
resolver. `NO_COLOR` and `FORCE_COLOR` retain the resolver's documented precedence.
Pipes, CI, JSON, porcelain, and protocol channels never activate Ink.

`aios status` shows summary counts, complete paths, kind/tier metadata, and held-file
reasons. At widths below 80 it uses stacked summary rows. Holding private or untagged
files is an intentional local outcome, never a failed upload.

Onboarding retains Personal/Join/Create, exact-origin consent, optional tools, and
masked credentials. Each question releases terminal input before the existing engine
runs. Completed answers leave a short scrollback receipt; secret values are omitted.
Cancellation leaves completed changes in place and says so explicitly.

Sync progresses through named stages. Item pushes show a known denominator; pull
pages never invent an overall percentage. Completed writes are not retried if rendering
fails. Existing item-level errors, exit codes, and persistence order remain authoritative.
Skill, blueprint, and deliverable sync subcommands retain their existing output.

## Ownership and build

`scripts/ui.mjs` is the public internal barrel. Capability and presenter selection stay
in dependency-light JavaScript. Heavy TypeScript/TSX modules live under `src/terminal`
and compile with `npm run build:terminal` into `dist/terminal`.
`prepack` rebuilds them and copies third-party notices; installed users need neither
TypeScript nor shadcn. Contributor checkouts must build after editing terminal sources.

The design companion adds `@aios-alpha/design/terminal`, generated from canonical DTCG
colors. Until that additive export is published, the CLI reads the same generated
colors from the existing `tokens.pencil.json` export. This compatibility path contains
no copied palette values. Foreground and canvas always inherit the terminal.

TermCN's source adaptations are recorded in provenance: Node ESM import paths,
default-option focus, safe empty selection, Node-only global checks, and semantic step
colors, and synchronous input refs for batched paste/navigation plus Enter. Updates require reviewing the pinned source diff and running the PTY tests.

## Verification

`npm test` builds the terminal code and discovers `test/terminal-presentation.test.mjs`.
It verifies capability gating, complete narrow output, control-character sanitization,
operation-once behavior on display failure, and real PTY interactions. The PTY harness
uses Python's standard library on POSIX; no native Node PTY addon is required.

Do not weaken `docs/cli-output-contract.md` to accommodate presentation. Machine
branches return before the renderer is imported. Follow the same boundary for future
command migrations.
