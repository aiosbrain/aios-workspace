/**
 * update/stamp.mjs — the `.aios-toolkit-version` stamp: the pinned merge base every 3-way
 * merge reasons `base` from, and the record of what a workspace is currently synced to.
 *
 * Invariant this module owns: line 1 of the stamp is the sha the NEXT `aios update` treats
 * as the 3-way merge base — there is exactly one reader (`readStampBaseSha`) and one writer
 * of its shape (`stampBody`), so the apply pre-flight and any read-only pre-flight can never
 * disagree about which base they're reasoning from.
 *
 * Extracted verbatim from scripts/update.mjs (AIO-557); no logic changed.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { VERSION_FILE } from "../toolkit-manifest.mjs";

/** The workspace's pinned merge base — line 1 of the version stamp, or undefined when the
 *  workspace has never been stamped (first apply). One reader, so the apply pre-flight and
 *  the read-only pre-flight can never disagree about which base they're reasoning from. */
export function readStampBaseSha(repo) {
  const stampPath = path.join(repo, VERSION_FILE);
  return existsSync(stampPath) ? readFileSync(stampPath, "utf8").split(/\s/)[0] : undefined;
}

/** The `.aios-toolkit-version` body. Line 1 is the sha (parsed as the merge base). */
export function stampBody(sha, meta, srcDir) {
  const lines = [sha, `toolkit-version ${meta.version}`];
  if (meta.brainApi) lines.push(`brain-api ${meta.brainApi}`);
  lines.push(`synced-at ${new Date().toISOString()}`, `source ${srcDir}`);
  return lines.join("\n") + "\n";
}
