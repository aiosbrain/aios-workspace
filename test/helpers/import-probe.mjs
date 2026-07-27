// `node --import <this file>` installs the resolution tracer. Every file: URL Node resolves
// is appended to $AIOS_IMPORT_TRACE, which lets a test assert that a given command did NOT
// pull a heavy module into its startup graph.
import { register } from "node:module";

register("./import-probe-hooks.mjs", {
  parentURL: import.meta.url,
  data: { out: process.env.AIOS_IMPORT_TRACE || null },
});
