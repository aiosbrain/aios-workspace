/**
 * update/stamp.mjs — the `.aios-toolkit-version` stamp: the pinned merge base every 3-way
 * merge reasons `base` from, and the record of what a workspace is currently synced to.
 *
 * Invariant this module owns: line 1 of the stamp is the sha the NEXT `aios update` treats
 * as the 3-way merge base — there is exactly one reader (`readStampBaseSha`) and one writer
 * of its shape (`stampBody`), so the apply pre-flight and any read-only pre-flight can never
 * disagree about which base they're reasoning from.
 *
 * STAMP FORMAT 2 (AIO-635 Decision 1). The stamp stays line-oriented and line 1 remains a
 * full 40-char sha — the content identity of the toolkit the workspace last synced (a git
 * HEAD for a checkout source, the package's embedded build sha for a registry source) —
 * because every v1 reader (this module's own `readStampBaseSha`, the workspace shim's
 * `source` parser) keys off the v1 line shape. v2 appends keyed lines after the existing
 * `toolkit-version` / `brain-api` / `synced-at` / `source` lines:
 *
 *   stamp-format 2
 *   package @aiosbrain/aios
 *   package-version <semver>
 *   package-integrity sha512-… | unverified
 *   manifest-digest sha256:<hex>
 *   base-store .aios/toolkit-bases
 *
 * `source` records the checkout path for a checkout root (unchanged) or
 * `pkg:@aiosbrain/aios@<version>` for a registry root. The upgrade is a ONE-WAY RATCHET:
 * v2 always writes format 2, including for `--from <checkout>` sources.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { VERSION_FILE } from "../toolkit-manifest.mjs";

export const STAMP_FORMAT = 2;
export const BASE_STORE_LINE = ".aios/toolkit-bases";

/** The workspace's pinned merge base — line 1 of the version stamp, or undefined when the
 *  workspace has never been stamped (first apply). One reader, so the apply pre-flight and
 *  the read-only pre-flight can never disagree about which base they're reasoning from. */
export function readStampBaseSha(repo) {
  const stampPath = path.join(repo, VERSION_FILE);
  return existsSync(stampPath) ? readFileSync(stampPath, "utf8").split(/\s/)[0] : undefined;
}

/**
 * Parse the whole stamp. A stamp with no `stamp-format` line is format 1 (every stamp
 * written before v2). Returns null when the workspace has never been stamped.
 */
export function readStamp(repo) {
  const stampPath = path.join(repo, VERSION_FILE);
  if (!existsSync(stampPath)) return null;
  const raw = readFileSync(stampPath, "utf8");
  const lines = raw.split("\n");
  const field = (name) => {
    const m = raw.match(new RegExp(`^${name} (.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  return {
    raw,
    baseSha: lines[0]?.trim() || undefined,
    format: Number(field("stamp-format") ?? 1),
    toolkitVersion: field("toolkit-version"),
    brainApi: field("brain-api"),
    syncedAt: field("synced-at"),
    source: field("source"),
    package: field("package"),
    packageVersion: field("package-version"),
    packageIntegrity: field("package-integrity"),
    manifestDigest: field("manifest-digest"),
    baseStore: field("base-store"),
  };
}

/**
 * The `.aios-toolkit-version` body. Line 1 is the sha (parsed as the merge base).
 * `v2` carries the format-2 keyed lines: `{ packageName, packageVersion, packageIntegrity,
 * manifestDigest }`. Omit `v2` only where a legacy-shaped body is explicitly required
 * (tests); every real writer passes it — the one-way ratchet.
 */
export function stampBody(sha, meta, srcDir, v2) {
  const lines = [sha, `toolkit-version ${meta.version}`];
  if (meta.brainApi) lines.push(`brain-api ${meta.brainApi}`);
  lines.push(`synced-at ${new Date().toISOString()}`, `source ${srcDir}`);
  if (v2) {
    lines.push(
      `stamp-format ${STAMP_FORMAT}`,
      `package ${v2.packageName ?? "@aiosbrain/aios"}`,
      `package-version ${v2.packageVersion ?? meta.version}`,
      `package-integrity ${v2.packageIntegrity ?? "unverified"}`,
      `manifest-digest ${v2.manifestDigest}`,
      `base-store ${BASE_STORE_LINE}`
    );
  }
  return lines.join("\n") + "\n";
}
