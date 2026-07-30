/**
 * delivery.mjs — the top-level barrel for scripts/delivery/ (boundary rule R1, AIO-597).
 *
 * R1 says a scripts/<cmd>/ subdirectory is importable only via its own top-level barrel
 * `scripts/<cmd>.mjs` or from same-dir siblings. The delivery command entry is (still) named
 * `delivery-status.mjs`, so its four original imports (github/local-state/reconcile/render) are
 * grandfathered in scripts/boundaries.json; that list ratchets DOWN only, so any NEW
 * scripts/delivery/* surface must be exported from here and imported via this barrel — never
 * added as a fresh grandfather entry. (The delivery-status.mjs → delivery.mjs rename that
 * retires those grandfathers is tracked separately.)
 *
 * Current surface: the durable split-delivery manifest (AIO-595, epic AIO-594) — pure schema
 * validation + the read/install IO around `.aios/delivery/split-manifest.json`.
 */

export {
  SPLIT_MANIFEST_SCHEMA_VERSION,
  validateSplitManifest,
  validateVerdictEntry,
} from "./delivery/manifest-schema.mjs";
export {
  MANIFEST_RELPATH,
  manifestPath,
  readManifestFile,
  loadManifest,
  installManifest,
} from "./delivery/manifest.mjs";
