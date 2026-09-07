import { fileURLToPath } from "node:url";
import path from "node:path";
let root;
export function initialize(data) {
  root = path.resolve(data.root) + path.sep;
}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("node:")) return result;
  if (!result.url.startsWith("file:") || !fileURLToPath(result.url).startsWith(root)) {
    throw new Error(`Standalone import escaped package: ${specifier}`);
  }
  return result;
}
