import { createOutput } from "./output.mjs";

export function cmdHelp(args, { usage, commands }) {
  const json = args.includes("--json");
  return createOutput({ json }).success(
    {
      schemaVersion: 1,
      command: "help",
      commands: commands.map((descriptor) => ({
        name: descriptor.name,
        aliases: descriptor.aliases ?? [],
        ...descriptor.metadata,
      })),
    },
    usage
  );
}
