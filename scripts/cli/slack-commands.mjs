/**
 * slack-commands.mjs — registry descriptor for the built-in Slack adapter (AIO-1068),
 * split out the same way linear-commands.mjs was (registry.mjs sits at its size-cap
 * ratchet). The loader routes through the scripts/connectors.mjs barrel and stays lazy:
 * a broken Slack adapter must never break an unrelated command surface.
 */
import { commandMetadata as M } from "./command-contract.mjs";
import { USAGE_LINES as U } from "./usage.mjs";

export const SLACK_COMMANDS = {
  slack: {
    name: "slack",
    metadata: M`slack adapter.slack user-or-workspace brain-or-provider required human-or-json offline`,
    resolution: "offline",
    // `aios slack` must work from ANY directory (an empty HOME included) — credential
    // resolution is the adapter's own job, not the workspace resolver's.
    cwdFallback: () => true,
    loader: async () => (await import("../connectors.mjs")).loadSlackAdapter(),
    adapt: (ctx, mod) => mod.cmdSlack(ctx.repo, ctx.rest),
    exit: "exit-code",
    usage: U.slack,
  },
};
