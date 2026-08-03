/**
 * devtools-commands.mjs — the five CLI descriptors whose implementations live in
 * `aiosbrain/aios-devtools` (AIO-594).
 *
 * Split out of `registry.mjs` for two reasons:
 *
 * 1. **They are the seam.** Every command here loads through `loadDevtoolsModule()` rather than a
 *    relative import, which is what keeps core free of R6 (core → devtools) violations. Keeping
 *    them together makes the boundary legible instead of scattered through a 500-line table.
 * 2. **The removal PR deletes one file, not five hunks.** When the in-tree implementations go
 *    (AIO-662), the decision is per-command and lives here.
 *
 * `registry.mjs` still owns ORDER — `aios help` renders `COMMANDS` in table order and these five
 * are interleaved with core commands, so each is referenced by name at its existing position.
 * Adding a command here without referencing it from `COMMANDS` makes it unreachable; the registry
 * invariants test asserts every descriptor appears exactly once.
 *
 * Shape is the `CommandDescriptor` typedef in `registry.mjs`.
 */

import { loadDevtoolsModule } from "../devtools-dispatch.mjs";
import { USAGE_LINES as U } from "./usage.mjs";

export const DEVTOOLS_COMMANDS = {
  build: {
    name: "build",
    resolution: "offline",
    usesDevtoolsDir: true,
    loader: () => loadDevtoolsModule("build"),
    adapt: (ctx, mod) => mod.cmdBuild(ctx.repo, ctx.rest),
    usage: U.build,
  },

  spec: {
    name: "spec",
    resolution: "offline",
    usesDevtoolsDir: true,
    loader: () => loadDevtoolsModule("spec-eval", { command: "spec" }),
    adapt: (ctx, mod) => mod.cmdSpec(ctx.repo, ctx.rest),
    usage: U.spec,
  },

  "consolidate-findings": {
    name: "consolidate-findings",
    resolution: "offline",
    usesDevtoolsDir: true,
    ownsRepoFlag: true, // same GitHub-slug `--repo` as `pr` — dispatch must not consume it
    loader: () => loadDevtoolsModule("consolidate-findings"),
    adapt: (ctx, mod) => mod.cmdConsolidateFindings(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U["consolidate-findings"],
  },

  ship: {
    name: "ship",
    // ship/roadmap-run's `--repo` is a WORKSPACE path (slug comes from detectRepo(repo)).
    resolution: "offline",
    usesDevtoolsDir: true,
    loader: () => loadDevtoolsModule("ship"),
    adapt: (ctx, mod) => mod.cmdShip(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.ship,
  },

  "roadmap-run": {
    name: "roadmap-run",
    resolution: "offline",
    usesDevtoolsDir: true,
    loader: () => loadDevtoolsModule("roadmap-run"),
    adapt: (ctx, mod) => mod.cmdRoadmapRun(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U["roadmap-run"],
  },
};
