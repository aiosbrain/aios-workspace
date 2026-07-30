// Back-compat shim (AIO-601): the module body moved to packages/monorepo
// (@aios-alpha/monorepo). Re-exported by RELATIVE path (not the bare specifier) so the
// shim resolves on a bare checkout with no node_modules — CI guard jobs and the
// aios-update vendor snapshot execute scripts/ without an npm install.
export * from "../packages/monorepo/src/linear-client.mjs";
