#!/usr/bin/env node
/**
 * `slack` — warning-only compatibility delegate (AIO-1068; removal boundary v3.0.0-earliest).
 *
 * The canonical route is `aios slack <verb> …`. This bin runs the SAME built-in Node
 * adapter in-process (one implementation, one credential resolution — no config logic
 * lives here), so stdout schema and exit status are identical to `aios slack`; the only
 * difference is one deprecation warning, written to stderr so machine consumers of stdout
 * see zero extra bytes. The former Python subprocess path is gone: the packed package is
 * the whole runtime.
 */
process.stderr.write(
  "slack: deprecated compatibility command — use `aios slack " +
    `${process.argv[2] ?? "<verb>"} …\` (this bin will be removed no earlier than v3.0.0)\n`
);
try {
  const { loadSlackAdapter } = await import("./connectors.mjs");
  const { cmdSlack } = await loadSlackAdapter();
  process.exitCode = await cmdSlack(null, process.argv.slice(2));
} catch (error) {
  // Same containment as `aios slack` (dispatch's die): a broken adapter fails as a CLI
  // error line, never an unhandled stack dump.
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
