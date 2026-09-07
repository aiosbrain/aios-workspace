/** Shared read-only toolkit stamp and merge-base contract; safe for diagnostic startup. */
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { UpdateError } from "./cli-common.mjs";
import { VERSION_FILE } from "./toolkit-manifest.mjs";

function assertReadPathSafe(repo, rel) {
  let current = repo;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new UpdateError(
          "A merge-base path is symlinked; restore the committed base store before updating."
        );
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

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

export const BASE_STORE_DIR = ".aios/toolkit-bases";
const INDEX_FILE = "index.json";

export const sha256hex = (content) => createHash("sha256").update(content).digest("hex");

/** Read the store index — `{ dest: { hash, src, packageVersion } }` — or null when absent/bad. */
export function readBaseIndex(repo) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(repo, BASE_STORE_DIR, INDEX_FILE), "utf8"));
    return parsed && typeof parsed.entries === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Base content for `destRel` from the store, or undefined (absent entry, missing blob, or
 * a blob whose bytes no longer match the recorded hash — treated as no-base, which
 * `decideMerge` surfaces as `fallback` rather than guessing).
 */
export function baseFromStore(repo, index, destRel) {
  const entry = index?.entries?.[destRel];
  if (!entry?.hash) return undefined;
  try {
    const content = readFileSync(path.join(repo, BASE_STORE_DIR, entry.hash), "utf8");
    return sha256hex(content) === entry.hash ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Every dest recorded in the index under a manifest dir prefix — the base FILE LIST a
 *  registry-root merge uses where a checkout would `lsTree` the pinned sha. */
export function baseDestsUnder(index, destPrefix) {
  if (!index?.entries) return [];
  const prefix = `${destPrefix}/`;
  return Object.keys(index.entries).filter((d) => d === destPrefix || d.startsWith(prefix));
}

/** Resolve the immutable generation named by the stamp; legacy active indices must also match. */
export function verifiedBaseIndex(repo, stamp) {
  const digest = stamp?.manifestDigest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? ""))
    throw new UpdateError(
      "Invalid v2 manifest digest; restore the committed stamp and base store before updating."
    );
  const generation = `${BASE_STORE_DIR}/${digest.slice(7)}.json`;
  let index;
  try {
    assertReadPathSafe(repo, generation);
    index = JSON.parse(readFileSync(path.join(repo, generation), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assertReadPathSafe(repo, `${BASE_STORE_DIR}/index.json`);
    index = readBaseIndex(repo);
  }
  if (!index?.entries || typeof index.entries !== "object" || Array.isArray(index.entries))
    throw new UpdateError(
      "The stamped base-store generation is missing; restore it from the workspace commit before updating."
    );
  const tuples = [];
  for (const [dest, entry] of Object.entries(index.entries)) {
    if (!/^[0-9a-f]{64}$/.test(entry?.hash ?? "") || typeof entry.src !== "string")
      throw new UpdateError("Invalid base-store entry; restore the committed base store.");
    assertReadPathSafe(repo, `${BASE_STORE_DIR}/${entry.hash}`);
    if (baseFromStore(repo, index, dest) === undefined)
      throw new UpdateError(
        `Missing or corrupt merge base for ${dest}; restore the committed base store before updating.`
      );
    tuples.push(`${dest}\0${entry.src}\0${entry.hash}`);
  }
  if (`sha256:${sha256hex(tuples.sort().join("\n"))}` !== digest)
    throw new UpdateError(
      "The base-store index does not match the version stamp; restore the committed stamp and bases before updating."
    );
  return index;
}
