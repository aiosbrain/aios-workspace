#!/usr/bin/env node
/**
 * `linear` — warning-only compatibility delegate (AIO-1067; removal boundary v3.0.0-earliest).
 *
 * The canonical route is `aios linear <verb> …`. This bin runs the SAME built-in adapter
 * in-process (one implementation, one credential resolution), so stdout schema and exit
 * status are identical to `aios linear`; the only difference is one deprecation warning,
 * written to stderr so machine consumers of stdout see zero extra bytes.
 */
process.stderr.write(
  "linear: deprecated compatibility command — use `aios linear " +
    `${process.argv[2] ?? "<verb>"} …\` (this bin will be removed no earlier than v3.0.0)\n`
);
const { loadLinearAdapter } = await import("./connectors.mjs");
const { cmdLinear } = await loadLinearAdapter();
process.exitCode = await cmdLinear(null, process.argv.slice(2));
