import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
let root;
export function initialize(data) {
  root = realpathSync(data.root) + path.sep;
}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("node:")) return result;
  if (!result.url.startsWith("file:") || !fileURLToPath(result.url).startsWith(root)) {
    throw new Error(`Standalone import escaped package: ${specifier}`);
  }
  return result;
}
