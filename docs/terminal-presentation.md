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
TypeScript nor shadcn.

Contributor checkouts and worktrees never need a manual build.
`scripts/ensure-terminal-built.mjs` compares a content fingerprint of every input —
`src/terminal/**` including vendor notices, `tsconfig.terminal.json`, `tsconfig.json`, the
build script, `package.json`'s module type, and the installed versions of TypeScript,
Ink, React and their type packages — with the stamp `build-terminal.mjs` writes to
`dist/terminal/.build-inputs.sha256`. It runs at `npm install`, during worktree
hydration, and lazily inside `createPresenter()`, so the first rich command after a
`git pull` or an edit to `src/terminal` rebuilds (under a second) before rendering.
The lazy check runs only after the presenter has accepted a human TTY, so JSON,
porcelain, plain, piped and CI output never pay for it. A published install has no
`src/terminal` and stops at one `existsSync`. The stamp also lists every emitted file,
so a partially deleted `dist/terminal` reads as stale and rebuilds. A failed compile
keeps the last good build and records its fingerprint, so an in-progress edit with type
errors is not recompiled by every command; the next source change retries.

Each build compiles into a private staging directory under `dist/` and swaps it in
whole, so a command importing `dist/terminal` while another builds reads complete files
rather than ones the compiler is still writing, and outputs of deleted sources disappear.

Concurrent commands serialise on `dist/.terminal-build.lock`, which records the owner's
pid. Ctrl-C, `SIGTERM` or `SIGHUP` during a build removes the lock and still ends the
command, including a signal sent to the `aios` process alone. A lock whose owner died some
other way (a crash or `SIGKILL`) is reclaimed as soon as the next command sees the pid is
gone, even if the hostname has changed since. When an older build exists, the presenter
waits at most 1.5 s for another command's build, then renders the older build with a
one-line notice; only a checkout with no build at all waits for one.

When the colour UI cannot load, the CLI falls back to plain output and prints one
stderr line naming the fix: `npm run build:terminal`, or `npm install` first in a
checkout without devDependencies. When a rebuild failed over an older build, the line
says the UI is out of date instead. That hint appears only for a human TTY on stderr;
it is suppressed under `AIOS_UI_TIER=plain`, `NO_COLOR`, `TERM=dumb`, `CI`, machine
modes and redirected streams, and never touches stdout or the exit code.

The design companion adds `@aios-alpha/design/terminal`, generated from canonical DTCG
colors. Until that additive export is published, the CLI reads the same generated
colors from the existing `tokens.pencil.json` export. This compatibility path contains
no copied palette values. Foreground and canvas always inherit the terminal.

The terminal palette uses violet for headings, active choices, and team labels; lime
for live progress and next commands; teal for information and intentionally held files;
and emerald/amber/red for success, changes or warnings, and failures. The AIOS product
label remains terminal-native. Truecolor accents are derived toward the canonical
foreground until they reach 4.5:1 against the selected canonical light/dark canvas.
Custom terminal backgrounds may differ; `AIOS_UI_BG` selects the reference and limited
terminals use their own ANSI palette. Monochrome output retains labels and symbols.

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
