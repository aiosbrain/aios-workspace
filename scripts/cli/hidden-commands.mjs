/**
 * hidden-commands.mjs — the undocumented-but-reachable registry descriptors, split out of
 * registry.mjs (AIO-1068) the same way devtools/linear/slack-commands were: the registry
 * sits at its size-cap ratchet, and these four descriptors are behavior-preserving moves.
 */
import { commandMetadata as M } from "./command-contract.mjs";
import { USAGE_LINES as U } from "./usage.mjs";

export const HIDDEN_COMMANDS = [
  {
    name: "whoami",
    metadata: M`whoami core.cli workspace brain required human requires-workspace`,
    resolution: "workspace",
    adapt: (ctx) => ctx.local.cmdWhoami(ctx.repo, ctx.cfg),
    usage: U.whoami,
  },
  // AIO-600 GUI seams: gui/server shells `aios gen-catalog|catalog|connector`, never scripts/*.
  {
    name: "gen-catalog",
    metadata: M`gen-catalog core.cli optional none never human offline`,
    resolution: "offline",
    loader: () => import("../gen-catalog.mjs"),
    adapt: (ctx, mod) => mod.generate(ctx.repo),
    usage: [],
  },
  {
    name: "catalog",
    metadata: M`catalog core.cli optional none never human offline`,
    resolution: "offline",
    loader: () => import("../gen-catalog.mjs"),
    adapt: (ctx, mod) => mod.cmdCatalog(ctx.repo, ctx.rest),
    usage: U.catalog,
  },
  {
    name: "connector",
    metadata: M`connector core.cli optional optional optional human-or-json offline`,
    resolution: "offline",
    loader: () => import("../connector-cli.mjs"),
    adapt: (ctx, mod) => mod.cmdConnector(ctx.repo, ctx.rest),
    exit: "exit-status",
    usage: U.connector,
  },
];
