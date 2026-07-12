/**
 * toolkit-meta.mjs — the toolkit's human-readable version identity.
 *
 * A git sha is precise but opaque: "am I on b4b02c3 or 555972b?" tells a contributor
 * nothing about compatibility. The toolkit therefore also carries a **semver** (its
 * `package.json` version) and the **brain-api contract version** it targets (the header
 * of `docs/brain-api.md`, the pinned sync contract). `aios update` stamps both into
 * `.aios-toolkit-version` and reports them, so a workspace can reason about "0.6 → 0.7"
 * and "needs brain-api 1.x" instead of an opaque hash.
 *
 * Pure reads from a toolkit checkout; no writes, no deps.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** The toolkit's semver, from its package.json. "0.0.0" if unreadable. */
export function toolkitVersion(toolkitDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(toolkitDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The brain-api contract version the toolkit targets — parsed from the `**Version: N.M**`
 * header of docs/brain-api.md (the single pinned contract). undefined if unavailable.
 */
export function brainApiVersion(toolkitDir) {
  try {
    const doc = path.join(toolkitDir, "docs", "brain-api.md");
    if (!existsSync(doc)) return undefined;
    const m = readFileSync(doc, "utf8").match(/\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Both identity fields for a toolkit checkout, plus a short display string. */
export function toolkitMeta(toolkitDir) {
  const version = toolkitVersion(toolkitDir);
  const brainApi = brainApiVersion(toolkitDir);
  return {
    version,
    brainApi,
    label: brainApi ? `v${version} (brain-api ${brainApi})` : `v${version}`,
  };
}
