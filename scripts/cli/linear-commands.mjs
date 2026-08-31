/**
 * linear-commands.mjs — registry descriptors for the built-in Linear adapter (AIO-1067),
 * split out of registry.mjs the same way devtools-commands.mjs was (the registry sits at its
 * size-cap ratchet). Loaders route through the scripts/connectors.mjs barrel and stay lazy:
 * a broken adapter must never break an unrelated command surface.
 */
import { commandMetadata as M } from "./command-contract.mjs";
import { USAGE_LINES as U } from "./usage.mjs";

export const LINEAR_COMMANDS = {
  linear: {
    name: "linear",
    metadata: M`linear adapter.linear user-or-workspace provider required human-or-json offline`,
    resolution: "offline",
    // `aios linear` must work from ANY directory (an empty HOME included) — credential
    // resolution is the adapter's own job, not the workspace resolver's.
    cwdFallback: () => true,
    loader: async () => (await import("../connectors.mjs")).loadLinearAdapter(),
    adapt: (ctx, mod) => mod.cmdLinear(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.linear,
  },
  disconnect: {
    name: "disconnect",
    metadata: M`disconnect core.cli user none never human offline`,
    resolution: "offline",
    cwdFallback: () => true,
    loader: async () => (await import("../connectors.mjs")).loadLinearSetup(),
    adapt: (ctx, mod) => mod.cmdDisconnect(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.disconnect,
  },
};
