import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeBrainOrigin } from "./brain-origin.mjs";

/** Persist only a confirmed canonical origin; preserve every other aios.yaml field. */
export function persistBrainOrigin(repo, value) {
  const origin = normalizeBrainOrigin(value);
  const file = path.join(repo, "aios.yaml");
  if (!existsSync(file))
    throw new Error(
      "Cannot save a Brain origin: this is not an AIOS workspace (aios.yaml missing)."
    );
  const before = readFileSync(file, "utf8");
  const line = `brain_url: "${origin}"`;
  const after = /^brain_url:\s*.*$/m.test(before)
    ? before.replace(/^brain_url:\s*.*$/m, line)
    : `${line}\n${before}`;
  if (after !== before) writeFileSync(file, after);
  return { origin, changed: after !== before };
}
