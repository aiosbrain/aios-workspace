import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolkitMeta } from "../toolkit-meta.mjs";
import { createOutput } from "./output.mjs";

const toolkitRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function cmdVersion(args) {
  const meta = toolkitMeta(toolkitRoot);
  return createOutput({ json: args.includes("--json") }).success(
    { schemaVersion: 1, command: "version", label: meta.label },
    meta.label
  );
}
