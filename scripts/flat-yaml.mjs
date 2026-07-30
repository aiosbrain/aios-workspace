// Back-compat shim (AIO-601): the module body moved to packages/foundation
// (@aiosbrain/foundation). Re-exported by RELATIVE path (not the bare specifier) so the
// shim resolves on a bare checkout with no node_modules — CI guard jobs and the
// aios-update vendor snapshot execute scripts/ without an npm install.
export * from "../packages/foundation/src/internal/flat-yaml.mjs";
