/**
 * delivery/manifest.mjs — read/install IO for the split-delivery manifest (AIO-595, epic AIO-594).
 *
 * The manifest lives at `.aios/delivery/split-manifest.json` inside the aios-workspace checkout
 * (`.aios/` is gitignored — it is durable local program state, not source). Validation itself is
 * pure and lives in delivery/manifest-schema.mjs.
 *
 * Strictly bounded write surface: the ONLY write in the whole `aios delivery` feature is
 * `installManifest` copying an ALREADY-VALIDATED manifest file into place (`manifest init`).
 * No git/gh subprocess is involved anywhere in this module — the delivery safe-exec allowlist
 * is untouched — and nothing here (or anywhere else in the feature) merges, deletes, pushes, or
 * records verdicts. `verdict_log` is appended only by humans editing the file directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateSplitManifest } from "./manifest-schema.mjs";

/** Repo-relative location of the installed manifest. */
export const MANIFEST_RELPATH = path.join(".aios", "delivery", "split-manifest.json");

/** @param {string} repoPath  a local aios-workspace checkout */
export function manifestPath(repoPath) {
  return path.join(repoPath, MANIFEST_RELPATH);
}

/**
 * Read + parse + schema-validate one candidate manifest file. Never throws.
 *
 * @param {string} file
 * @returns {{manifest: object|null, raw: string|null, errors: string[]}}  `manifest` is non-null
 *   only when the file read, parsed, AND validated cleanly; `raw` carries the original bytes so
 *   an install is a byte-exact copy, not a re-serialization.
 */
export function readManifestFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return { manifest: null, raw: null, errors: [`cannot read ${file}: ${e.message}`] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { manifest: null, raw, errors: [`invalid JSON in ${file}: ${e.message}`] };
  }
  const errors = validateSplitManifest(data);
  return { manifest: errors.length ? null : data, raw, errors };
}

/**
 * Load the installed manifest, read-only. Never throws, never writes: an absent or invalid
 * manifest is REPORTED (`manifest: null` + a warning string), exactly like every other
 * degraded input in `aios delivery status`.
 *
 * @param {string} repoPath
 * @returns {{manifest: object|null, warning: string|null}}
 */
export function loadManifest(repoPath) {
  const file = manifestPath(repoPath);
  if (!existsSync(file)) {
    return {
      manifest: null,
      warning: `no split manifest installed at ${file} — install one with \`aios delivery manifest init <file>\``,
    };
  }
  const { manifest, errors } = readManifestFile(file);
  if (!manifest) {
    return { manifest: null, warning: `split manifest at ${file} is invalid: ${errors.join("; ")}` };
  }
  return { manifest, warning: null };
}

/**
 * Validate `sourceFile` against the schema and, only if fully valid, copy it byte-exact to
 * `<repoPath>/.aios/delivery/split-manifest.json` (creating the directory). Refuses to overwrite
 * an existing manifest unless `force` — the installed manifest may carry human-recorded verdicts
 * that a re-init must never silently clobber.
 *
 * @param {string} sourceFile
 * @param {string} repoPath
 * @param {{force?: boolean}} [opts]
 * @returns {{ok: boolean, dest: string, errors: string[]}}
 */
export function installManifest(sourceFile, repoPath, { force = false } = {}) {
  const dest = manifestPath(repoPath);
  const { manifest, raw, errors } = readManifestFile(sourceFile);
  if (!manifest) return { ok: false, dest, errors };
  if (existsSync(dest) && !force) {
    return {
      ok: false,
      dest,
      errors: [
        `refusing to overwrite the existing manifest at ${dest} — it may carry human-recorded ` +
          "verdicts; pass --force to replace it deliberately",
      ],
    };
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, raw);
  return { ok: true, dest, errors: [] };
}
