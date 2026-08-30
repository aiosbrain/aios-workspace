import { commandMetadata as M } from "./command-contract.mjs";
import { USAGE_LINES as U } from "./usage.mjs";

export const DIAGNOSTIC_COMMANDS = [
  {
    name: "help",
    aliases: ["-h", "--help"],
    resolution: "diagnostic",
    metadata: M`help core.cli none none never human-or-json diagnostic`,
    loader: () => import("./help.mjs"),
    adapt: (ctx, mod) => mod.cmdHelp(ctx.rest, ctx.catalog),
    usage: [],
  },
  {
    name: "version",
    aliases: ["-v", "--version"],
    resolution: "diagnostic",
    metadata: M`version core.cli none none never human-or-json diagnostic`,
    loader: () => import("./version.mjs"),
    adapt: (ctx, mod) => mod.cmdVersion(ctx.rest),
    usage: [],
  },
  {
    name: "doctor",
    resolution: "diagnostic",
    metadata: M`doctor core.cli none none never human-or-json diagnostic`,
    loader: () => import("./doctor.mjs"),
    adapt: (ctx, mod) => mod.cmdDoctor(ctx.rest),
    usage: U.doctor,
  },
  {
    name: "provenance",
    resolution: "diagnostic",
    metadata: M`provenance core.cli none none never human-or-json diagnostic`,
    loader: () => import("./provenance.mjs"),
    adapt: (ctx, mod) => mod.cmdProvenance(ctx.rest),
    usage: U.provenance,
  },
];
